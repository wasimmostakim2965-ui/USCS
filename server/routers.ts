import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getSupabaseUserClient } from "./_core/supabaseAuth";
import { getHostingAdapter, type DeploymentEnvironment } from "./adapters/hosting";
import { getDatabaseAdapter, getStorageAdapter } from "./adapters/data";
import { getDomainResellerAdapter } from "./adapters/domainReseller";
import { resolveSecurityPolicy } from "./securityPolicy";
import { getBillingAdapter } from "./adapters/billing";
import { getSecurityEdgeAdapter } from "./adapters/securityEdge";
import { getPlatformAdapters } from "./adapters/platform";
import type { EdgeEnforcementConfig, SecurityLevel } from "./securityPolicy";

const edgeConfigSchema = z.object({
  level: z.enum(["none", "normal", "high", "ultimate"]),
  firewall: z.object({ enabled: z.boolean(), denyPrivateNetworks: z.boolean(), rules: z.array(z.object({ field: z.enum(["ip", "country", "path"]), operator: z.enum(["equals", "contains", "in"]), value: z.string().trim().min(1).max(255), action: z.enum(["allow", "deny"]) })).max(100) }),
  waf: z.object({ enabled: z.boolean(), owaspCoreRules: z.boolean(), sensitivity: z.enum(["off", "balanced", "strict"]) }),
  rateLimit: z.object({ enabled: z.boolean(), requestsPerMinute: z.number().int().min(0).max(1_000_000), rules: z.array(z.object({ path: z.string().trim().min(1).max(255), method: z.enum(["ANY", "GET", "POST", "PUT", "DELETE"]), threshold: z.number().int().positive().max(1_000_000), windowSeconds: z.number().int().positive().max(86400), action: z.enum(["throttle", "block"]) })).max(100) }),
  botProtection: z.object({ enabled: z.boolean(), challengeThreshold: z.enum(["off", "suspicious", "aggressive"]) }),
  tls: z.object({ minimumVersion: z.enum(["TLSv1.2", "TLSv1.3"]), hsts: z.boolean(), securityHeaders: z.boolean() }),
});

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.identity ?? opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  domains: router({
    search: protectedProcedure
      .input(z.object({ query: z.string().trim().min(1).max(253) }))
      .query(async ({ input }) => getDomainResellerAdapter().search(input.query)),

    list: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
        if (membershipError) throw new Error(membershipError.message);
        const ids = (memberships ?? []).map(row => row.organization_id).filter(id => !input?.organizationId || id === input.organizationId);
        if (!ids.length) return [];
        let query = client.from("domains").select("id,organization_id,project_id,hostname,status,registrar_ref,nameservers,ssl_status,dnssec_enabled,created_by,created_at,updated_at").in("organization_id", ids).order("created_at", { ascending: false }).limit(100);
        if (input?.projectId) query = query.eq("project_id", input.projectId);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        return data ?? [];
      }),

    create: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid().nullable().optional(), hostname: z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/) }))
      .mutation(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data, error } = await client.from("domains").insert({ organization_id: input.organizationId, project_id: input.projectId ?? null, hostname: input.hostname, status: "not_configured", created_by: ctx.identity.supabaseId }).select("id,organization_id,project_id,hostname,status,registrar_ref,nameservers,ssl_status,dnssec_enabled,created_by,created_at,updated_at").single();
        if (error) throw new Error(error.message);
        await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "domain.create", resource_type: "domain", resource_id: data.id, result: "success", metadata: { hostname: data.hostname, status: data.status } });
        return { configured: false as const, reason: "DNS provider is not configured. The domain record was saved without claiming that live DNS is active.", domain: data };
      }),

    updateDnssec: protectedProcedure
      .input(z.object({ id: z.string().uuid(), enabled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: domain, error: domainError } = await client.from("domains").select("id,organization_id").eq("id", input.id).maybeSingle();
        if (domainError) throw new Error(domainError.message);
        if (!domain) throw new Error("Domain not found");
        const { data, error } = await client.from("domains").update({ dnssec_enabled: input.enabled, updated_at: new Date().toISOString() }).eq("id", input.id).select("id,organization_id,project_id,hostname,status,registrar_ref,nameservers,ssl_status,dnssec_enabled,created_by,created_at,updated_at").single();
        if (error) throw new Error(error.message);
        await client.from("audit_logs").insert({ organization_id: domain.organization_id, actor_id: ctx.identity.supabaseId, action: "domain.dnssec.update", resource_type: "domain", resource_id: input.id, metadata: { enabled: input.enabled } });
        return { configured: false as const, reason: "DNSSEC metadata was saved. A live DNS provider is required to publish the DS record.", domain: data };
      }),

    records: router({
      list: protectedProcedure
        .input(z.object({ domainId: z.string().uuid() }))
        .query(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data, error } = await client.from("dns_records").select("id,organization_id,domain_id,record_type,name,value,ttl,priority,created_by,created_at,updated_at").eq("domain_id", input.domainId).order("record_type").order("name").limit(500);
          if (error) throw new Error(error.message);
          return data ?? [];
        }),
      create: protectedProcedure
        .input(z.object({ domainId: z.string().uuid(), recordType: z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "NS"]), name: z.string().trim().min(1).max(253), value: z.string().trim().min(1).max(2048), ttl: z.number().int().min(60).max(86400).default(3600), priority: z.number().int().min(0).max(65535).nullable().optional() }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data: domain, error: domainError } = await client.from("domains").select("organization_id").eq("id", input.domainId).maybeSingle();
          if (domainError) throw new Error(domainError.message);
          if (!domain) throw new Error("Domain not found");
          const { data, error } = await client.from("dns_records").insert({ organization_id: domain.organization_id, domain_id: input.domainId, record_type: input.recordType, name: input.name, value: input.value, ttl: input.ttl, priority: input.priority ?? null, created_by: ctx.identity.supabaseId }).select("id,organization_id,domain_id,record_type,name,value,ttl,priority,created_by,created_at,updated_at").single();
          if (error) throw new Error(error.message);
          const provider = await getPlatformAdapters().dns.applyRecords({ domainId: input.domainId, records: [{ type: input.recordType, name: input.name, value: input.value, ttl: input.ttl }] });
          await client.from("audit_logs").insert({ organization_id: domain.organization_id, actor_id: ctx.identity.supabaseId, action: "dns_record.create", resource_type: "dns_record", resource_id: data.id, metadata: { domainId: input.domainId, recordType: input.recordType, name: input.name, adapterStatus: provider.status } });
          return { configured: provider.status === "ready" as const, reason: provider.message, record: data };
        }),
      delete: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data: record, error: recordError } = await client.from("dns_records").select("id,organization_id,domain_id").eq("id", input.id).maybeSingle();
          if (recordError) throw new Error(recordError.message);
          if (!record) throw new Error("DNS record not found");
          const { error } = await client.from("dns_records").delete().eq("id", input.id);
          if (error) throw new Error(error.message);
          await client.from("audit_logs").insert({ organization_id: record.organization_id, actor_id: ctx.identity.supabaseId, action: "dns_record.delete", resource_type: "dns_record", resource_id: input.id, metadata: { domainId: record.domain_id } });
          return { configured: false as const, reason: "DNS record removed from the local control plane. Provider synchronization is not configured." };
        }),
    }),
  }),

  security: router({
    previewPolicy: protectedProcedure
      .input(z.object({ level: z.enum(["none", "normal", "high", "ultimate"]) }))
      .query(({ input }) => ({ status: "ready" as const, config: resolveSecurityPolicy(input.level) })),

    getPolicy: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid().nullable().optional() }))
      .query(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: membership, error: membershipError } = await client.from("organization_members").select("role").eq("organization_id", input.organizationId).eq("user_id", ctx.identity.supabaseId).maybeSingle();
        if (membershipError) throw new Error(membershipError.message);
        if (!membership) throw new Error("Organization membership required");
        const { data: policy, error } = await client.from("security_policies").select("id,organization_id,project_id,security_level,auto_setup,enforcement_version,desired_config,applied_config,last_applied_at,last_apply_status,last_apply_error,created_by,created_at,updated_at").eq("organization_id", input.organizationId).is("project_id", input.projectId ?? null).maybeSingle();
        if (error) throw new Error(error.message);
        const { data: events, error: eventsError } = policy ? await client.from("security_policy_events").select("id,event_type,actor_id,desired_config,applied_config,error_message,created_at").eq("security_policy_id", policy.id).order("created_at", { ascending: false }).limit(30) : { data: [], error: null };
        if (eventsError) throw new Error(eventsError.message);
        return { policy, events: events ?? [], role: membership.role };
      }),

    setLevel: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid().nullable().optional(), level: z.enum(["none", "normal", "high", "ultimate"]), autoSetup: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: membership, error: membershipError } = await client.from("organization_members").select("role").eq("organization_id", input.organizationId).eq("user_id", ctx.identity.supabaseId).maybeSingle();
        if (membershipError) throw new Error(membershipError.message);
        if (!membership || !["owner", "admin", "security"].includes(membership.role)) throw new Error("Security policy changes require owner, admin, or security role");
        if (input.projectId) {
          const { data: project, error: projectError } = await client.from("projects").select("id").eq("id", input.projectId).eq("organization_id", input.organizationId).maybeSingle();
          if (projectError) throw new Error(projectError.message);
          if (!project) throw new Error("Project does not belong to this organization");
        }
        const desiredConfig = resolveSecurityPolicy(input.level as SecurityLevel);
        const { data: existing, error: existingError } = await client.from("security_policies").select("id,applied_config,enforcement_version").eq("organization_id", input.organizationId).is("project_id", input.projectId ?? null).maybeSingle();
        if (existingError) throw new Error(existingError.message);
        const payload = { organization_id: input.organizationId, project_id: input.projectId ?? null, security_level: input.level, auto_setup: input.autoSetup, desired_config: desiredConfig, updated_at: new Date().toISOString(), created_by: ctx.identity.supabaseId };
        const query = existing ? client.from("security_policies").update(payload).eq("id", existing.id) : client.from("security_policies").insert(payload);
        const { data: policy, error } = await query.select("id,organization_id,project_id,security_level,auto_setup,enforcement_version,desired_config,applied_config,last_applied_at,last_apply_status,last_apply_error,created_by,created_at,updated_at").single();
        if (error) throw new Error(error.message);
        const { error: eventError } = await client.from("security_policy_events").insert({ organization_id: input.organizationId, security_policy_id: policy.id, event_type: "previewed", actor_id: ctx.identity.supabaseId, desired_config: desiredConfig, applied_config: existing?.applied_config ?? {} });
        if (eventError) throw new Error(eventError.message);
        await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "security_policy.set_level", resource_type: "security_policy", resource_id: policy.id, metadata: { level: input.level, autoSetup: input.autoSetup } });
        return policy;
      }),

    applyPolicy: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid().nullable().optional() }))
      .mutation(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: membership, error: membershipError } = await client.from("organization_members").select("role").eq("organization_id", input.organizationId).eq("user_id", ctx.identity.supabaseId).maybeSingle();
        if (membershipError) throw new Error(membershipError.message);
        if (!membership || !["owner", "admin", "security"].includes(membership.role)) throw new Error("Security policy apply requires owner, admin, or security role");
        const { data: policy, error: policyError } = await client.from("security_policies").select("id,organization_id,project_id,security_level,desired_config,applied_config,enforcement_version").eq("organization_id", input.organizationId).is("project_id", input.projectId ?? null).maybeSingle();
        if (policyError) throw new Error(policyError.message);
        if (!policy) throw new Error("Set a security level before applying a policy");
        const adapter = getSecurityEdgeAdapter();
        const result = await adapter.apply({ organizationId: input.organizationId, projectId: input.projectId ?? "organization-default", desiredConfig: policy.desired_config });
        const status = result.status === "ready" ? "applied" : result.status === "not_configured" ? "pending" : "failed";
        const { data: updated, error: updateError } = await client.from("security_policies").update({ applied_config: result.status === "ready" ? policy.desired_config : policy.applied_config, last_apply_status: status, last_applied_at: result.status === "ready" ? new Date().toISOString() : null, last_apply_error: result.status === "ready" ? null : result.message, enforcement_version: policy.enforcement_version + 1, updated_at: new Date().toISOString() }).eq("id", policy.id).select("id,organization_id,project_id,security_level,auto_setup,enforcement_version,desired_config,applied_config,last_applied_at,last_apply_status,last_apply_error,created_by,created_at,updated_at").single();
        if (updateError) throw new Error(updateError.message);
        const eventType = result.status === "ready" ? "applied" : result.status === "not_configured" ? "previewed" : "failed";
        await client.from("security_policy_events").insert({ organization_id: input.organizationId, security_policy_id: policy.id, event_type: eventType, actor_id: ctx.identity.supabaseId, desired_config: policy.desired_config, applied_config: result.status === "ready" ? policy.desired_config : policy.applied_config, error_message: result.status === "ready" ? null : result.message });
        await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "security_policy.apply", resource_type: "security_policy", resource_id: policy.id, result: result.status === "error" ? "failure" : "success", metadata: { adapter: adapter.name, status, message: result.message } });
        return { policy: updated, adapter: adapter.name, status, message: result.message };
      }),
    updateConfig: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid().nullable().optional(), config: edgeConfigSchema }))
      .mutation(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: membership, error: membershipError } = await client.from("organization_members").select("role").eq("organization_id", input.organizationId).eq("user_id", ctx.identity.supabaseId).maybeSingle();
        if (membershipError) throw new Error(membershipError.message);
        if (!membership || !["owner", "admin", "security"].includes(membership.role)) throw new Error("Security policy changes require owner, admin, or security role");
        const { data: existing, error: existingError } = await client.from("security_policies").select("id,applied_config,enforcement_version").eq("organization_id", input.organizationId).is("project_id", input.projectId ?? null).maybeSingle();
        if (existingError) throw new Error(existingError.message);
        const desiredConfig = input.config as EdgeEnforcementConfig;
        const payload = { organization_id: input.organizationId, project_id: input.projectId ?? null, security_level: input.config.level, desired_config: desiredConfig, auto_setup: true, updated_at: new Date().toISOString(), created_by: ctx.identity.supabaseId };
        const query = existing ? client.from("security_policies").update(payload).eq("id", existing.id) : client.from("security_policies").insert(payload);
        const { data: policy, error } = await query.select("id,organization_id,project_id,security_level,auto_setup,enforcement_version,desired_config,applied_config,last_applied_at,last_apply_status,last_apply_error,created_by,created_at,updated_at").single();
        if (error) throw new Error(error.message);
        await client.from("security_policy_events").insert({ organization_id: input.organizationId, security_policy_id: policy.id, event_type: "previewed", actor_id: ctx.identity.supabaseId, desired_config: desiredConfig, applied_config: existing?.applied_config ?? {} });
        await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "security_policy.update_config", resource_type: "security_policy", resource_id: policy.id, metadata: { level: input.config.level, firewallRules: input.config.firewall.rules.length, rateLimitRules: input.config.rateLimit.rules.length } });
        return policy;
      }),
    edgeEvents: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid().nullable().optional(), eventType: z.enum(["waf", "firewall", "rate_limit", "bot", "ddos", "tls"]).optional() }))
      .query(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        let query = client.from("security_edge_events").select("id,organization_id,project_id,event_type,action,source,path,metadata,created_at").eq("organization_id", input.organizationId).order("created_at", { ascending: false }).limit(100);
        if (input.projectId) query = query.eq("project_id", input.projectId);
        if (input.eventType) query = query.eq("event_type", input.eventType);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        return data ?? [];
      }),
  }),

  observability: router({
    events: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid().optional(), category: z.enum(["log", "metric", "error", "request"]).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
        if (membershipError) throw new Error(membershipError.message);
        const ids = (memberships ?? []).map(row => row.organization_id).filter(id => !input?.organizationId || id === input.organizationId);
        if (!ids.length) return [];
        let query = client.from("observability_events").select("id,organization_id,project_id,deployment_id,category,severity,message,route,status_code,latency_ms,metadata,occurred_at,created_at").in("organization_id", ids).order("occurred_at", { ascending: false }).limit(200);
        if (input?.category) query = query.eq("category", input.category);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        return data ?? [];
      }),
    alerts: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
        if (membershipError) throw new Error(membershipError.message);
        const ids = (memberships ?? []).map(row => row.organization_id);
        if (!ids.length) return [];
        const { data, error } = await client.from("observability_alerts").select("id,organization_id,project_id,name,metric,threshold,enabled,state,last_triggered_at,created_by,created_at,updated_at").in("organization_id", ids).order("updated_at", { ascending: false }).limit(100);
        if (error) throw new Error(error.message);
        return data ?? [];
      }),
      create: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid().nullable().optional(), name: z.string().trim().min(1).max(120), metric: z.enum(["error_rate", "latency_p95", "request_rate", "uptime"]), threshold: z.number().finite().min(0) }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data, error } = await client.from("observability_alerts").insert({ organization_id: input.organizationId, project_id: input.projectId ?? null, name: input.name, metric: input.metric, threshold: input.threshold, created_by: ctx.identity.supabaseId }).select("id,organization_id,project_id,name,metric,threshold,enabled,state,last_triggered_at,created_by,created_at,updated_at").single();
          if (error) throw new Error(error.message);
          await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "observability.alert.create", resource_type: "observability_alert", resource_id: data.id, metadata: { metric: input.metric, threshold: input.threshold } });
          return data;
        }),
    }),
    errorGroups: router({
      list: protectedProcedure.input(z.object({ organizationId: z.string().uuid().optional(), status: z.enum(["open", "resolved", "ignored"]).optional() }).optional()).query(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
        if (membershipError) throw new Error(membershipError.message);
        const ids = (memberships ?? []).map(row => row.organization_id).filter(id => !input?.organizationId || id === input.organizationId);
        if (!ids.length) return [];
        let query = client.from("observability_error_groups").select("id,organization_id,project_id,fingerprint,example_message,occurrence_count,first_seen_at,last_seen_at,status,created_at,updated_at").in("organization_id", ids).order("last_seen_at", { ascending: false }).limit(200);
        if (input?.status) query = query.eq("status", input.status);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        return data ?? [];
      }),
    }),
    alertDestinations: router({
      list: protectedProcedure.input(z.object({ alertId: z.string().uuid() })).query(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data, error } = await client.from("observability_alert_destinations").select("id,organization_id,alert_id,destination_type,destination_ref,enabled,created_by,created_at").eq("alert_id", input.alertId).order("created_at", { ascending: false });
        if (error) throw new Error(error.message);
        return data ?? [];
      }),
      create: protectedProcedure.input(z.object({ organizationId: z.string().uuid(), alertId: z.string().uuid(), destinationType: z.enum(["email", "webhook", "slack"]), destinationRef: z.string().trim().min(1).max(1024) })).mutation(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data, error } = await client.from("observability_alert_destinations").insert({ organization_id: input.organizationId, alert_id: input.alertId, destination_type: input.destinationType, destination_ref: input.destinationRef, created_by: ctx.identity.supabaseId }).select("id,organization_id,alert_id,destination_type,destination_ref,enabled,created_by,created_at").single();
        if (error) throw new Error(error.message);
        await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "observability.alert_destination.create", resource_type: "observability_alert_destination", resource_id: data.id, metadata: { alertId: input.alertId, destinationType: input.destinationType } });
        return data;
      }),
    }),
  }),

  developer: router({
    connections: protectedProcedure.query(async ({ ctx }) => {
      const client = getSupabaseUserClient(ctx.req);
      if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
      const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
      if (membershipError) throw new Error(membershipError.message);
      const ids = (memberships ?? []).map(row => row.organization_id);
      if (!ids.length) return [];
      const { data, error } = await client.from("developer_connections").select("id,organization_id,provider,status,account_ref,error_message,created_by,created_at,updated_at").in("organization_id", ids).order("provider");
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
    connect: protectedProcedure.input(z.object({ organizationId: z.string().uuid(), provider: z.enum(["github", "gitlab", "bitbucket"]), accountRef: z.string().trim().min(1).max(255).nullable().optional() })).mutation(async ({ ctx, input }) => {
      const client = getSupabaseUserClient(ctx.req);
      if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
      const { data, error } = await client.from("developer_connections").upsert({ organization_id: input.organizationId, provider: input.provider, account_ref: input.accountRef ?? null, status: "not_configured", error_message: "OAuth provider adapter is not configured; connection intent saved.", created_by: ctx.identity.supabaseId, updated_at: new Date().toISOString() }, { onConflict: "organization_id,provider" }).select("id,organization_id,provider,status,account_ref,error_message,created_by,created_at,updated_at").single();
      if (error) throw new Error(error.message);
      await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "developer.connection.create", resource_type: "developer_connection", resource_id: data.id, result: "success", metadata: { provider: input.provider } });
      return data;
    }),
    repositories: protectedProcedure.query(async ({ ctx }) => {
      const client = getSupabaseUserClient(ctx.req);
      if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
      const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
      if (membershipError) throw new Error(membershipError.message);
      const ids = (memberships ?? []).map(row => row.organization_id);
      if (!ids.length) return [];
      const { data, error } = await client.from("developer_repositories").select("id,organization_id,connection_id,full_name,default_branch,webhook_status,webhook_ref,created_by,created_at,updated_at").in("organization_id", ids).order("updated_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
    addRepository: protectedProcedure.input(z.object({ organizationId: z.string().uuid(), connectionId: z.string().uuid(), fullName: z.string().trim().min(1).max(255), defaultBranch: z.string().trim().min(1).max(255).default("main") })).mutation(async ({ ctx, input }) => {
      const client = getSupabaseUserClient(ctx.req);
      if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
      const { data, error } = await client.from("developer_repositories").insert({ organization_id: input.organizationId, connection_id: input.connectionId, full_name: input.fullName, default_branch: input.defaultBranch, webhook_status: "not_configured", created_by: ctx.identity.supabaseId }).select("id,organization_id,connection_id,full_name,default_branch,webhook_status,webhook_ref,created_by,created_at,updated_at").single();
      if (error) throw new Error(error.message);
      await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "developer.repository.add", resource_type: "developer_repository", resource_id: data.id, metadata: { fullName: input.fullName } });
      return data;
    }),
    webhook: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      const client = getSupabaseUserClient(ctx.req);
      if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
      const { data, error } = await client.from("developer_repositories").update({ webhook_status: "not_configured", updated_at: new Date().toISOString() }).eq("id", input.id).select("id,organization_id,webhook_status,webhook_ref").single();
      if (error) throw new Error(error.message);
      await client.from("audit_logs").insert({ organization_id: data.organization_id, actor_id: ctx.identity.supabaseId, action: "developer.webhook.configure", resource_type: "developer_repository", resource_id: data.id, result: "failure", metadata: { reason: "Webhook adapter is not configured" } });
      return { configured: false as const, reason: "Webhook adapter is not configured.", repository: data };
    }),
  }),

  billing: router({
    status: protectedProcedure.query(() => getBillingAdapter().status()),
  }),

  workspace: router({
    organizations: protectedProcedure.query(async ({ ctx }) => {
      const client = getSupabaseUserClient(ctx.req);
      if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
      const { data: memberships, error: membershipError } = await client
        .from("organization_members")
        .select("organization_id,role")
        .eq("user_id", ctx.identity.supabaseId);
      if (membershipError) throw new Error(membershipError.message);
      const ids = (memberships ?? []).map(m => m.organization_id);
      if (!ids.length) return [];
      const { data, error } = await client
        .from("organizations")
        .select("id,name,slug,created_by,created_at,updated_at")
        .in("id", ids)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []).map(org => ({
        ...org,
        role: memberships?.find(m => m.organization_id === org.id)?.role ?? "member",
      }));
    }),
    projects: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: memberships, error: membershipError } = await client
          .from("organization_members")
          .select("organization_id")
          .eq("user_id", ctx.identity.supabaseId);
        if (membershipError) throw new Error(membershipError.message);
        const ids = (memberships ?? []).map(m => m.organization_id);
        if (!ids.length) return [];
        const { data, error } = await client
          .from("projects")
          .select("id,organization_id,name,slug,created_by,created_at,updated_at")
          .in("organization_id", ids)
          .order("updated_at", { ascending: false });
        if (error) throw new Error(error.message);
        return data ?? [];
      }),
      create: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), name: z.string().trim().min(1).max(120) }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const slugBase = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "project";
          const slug = slugBase + "-" + randomBytes(3).toString("hex");
          const { data, error } = await client
            .from("projects")
            .insert({ organization_id: input.organizationId, name: input.name, slug, created_by: ctx.identity.supabaseId })
            .select("id,organization_id,name,slug,created_by,created_at,updated_at")
            .single();
          if (error) throw new Error(error.message);
          await client.from("audit_logs").insert({
            organization_id: input.organizationId,
            actor_id: ctx.identity.supabaseId,
            action: "project.created",
            resource_type: "project",
            resource_id: data.id,
            metadata: { name: data.name, slug: data.slug },
          });
          return data;
        }),
    }),
    audit: protectedProcedure.query(async ({ ctx }) => {
      const client = getSupabaseUserClient(ctx.req);
      if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
      const { data: memberships, error: membershipError } = await client
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", ctx.identity.supabaseId)
        .in("role", ["owner","admin","security"]);
      if (membershipError) throw new Error(membershipError.message);
      const ids = (memberships ?? []).map(m => m.organization_id);
      if (!ids.length) return [];
      const { data, error } = await client
        .from("audit_logs")
        .select("id,organization_id,actor_id,action,resource_type,resource_id,result,metadata,created_at")
        .in("organization_id", ids)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return data ?? [];
    }),
  }),

  deployments: router({
    list: protectedProcedure
      .input(z.object({ organizationId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: memberships, error: membershipError } = await client
          .from("organization_members")
          .select("organization_id")
          .eq("user_id", ctx.identity.supabaseId)
          .limit(100);
        if (membershipError) throw new Error(membershipError.message);
        const organizationIds = (memberships ?? []).map(row => row.organization_id)
          .filter(id => !input?.organizationId || id === input.organizationId);
        if (!organizationIds.length) return [];
        let query = client
          .from("deployments")
          .select("id,organization_id,project_id,environment,status,source_branch,commit_sha,source_repository,deployment_url,provider_ref,error_message,created_by,started_at,completed_at,created_at,updated_at")
          .in("organization_id", organizationIds)
          .order("created_at", { ascending: false })
          .limit(100);
        if (input?.projectId) query = query.eq("project_id", input.projectId);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        return data ?? [];
      }),

    get: protectedProcedure
      .input(z.object({ id: z.string().uuid(), includeLogs: z.boolean().optional() }))
      .query(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: deployment, error } = await client
          .from("deployments")
          .select("id,organization_id,project_id,environment,status,source_branch,commit_sha,source_repository,deployment_url,provider_ref,error_message,created_by,started_at,completed_at,created_at,updated_at")
          .eq("id", input.id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!deployment) throw new Error("Deployment not found");
        if (!input.includeLogs) return { deployment, logs: [] };
        const { data: logs, error: logsError } = await client
          .from("deployment_logs")
          .select("id,deployment_id,organization_id,level,message,source,created_at")
          .eq("deployment_id", input.id)
          .order("created_at", { ascending: true })
          .limit(500);
        if (logsError) throw new Error(logsError.message);
        return { deployment, logs: logs ?? [] };
      }),

    create: protectedProcedure
      .input(z.object({
        organizationId: z.string().uuid(),
        projectId: z.string().uuid(),
        environment: z.enum(["production", "preview", "development"]),
        sourceBranch: z.string().trim().min(1).max(255).nullable().optional(),
        commitSha: z.string().trim().min(1).max(128).nullable().optional(),
        sourceRepository: z.string().trim().min(1).max(500).nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: deployment, error } = await client
          .from("deployments")
          .insert({
            organization_id: input.organizationId,
            project_id: input.projectId,
            environment: input.environment satisfies DeploymentEnvironment,
            status: "pending",
            source_branch: input.sourceBranch ?? null,
            commit_sha: input.commitSha ?? null,
            source_repository: input.sourceRepository ?? null,
            created_by: ctx.identity.supabaseId,
          })
          .select("id,organization_id,project_id,environment,status,source_branch,commit_sha,source_repository,deployment_url,provider_ref,error_message,created_by,started_at,completed_at,created_at,updated_at")
          .single();
        if (error) throw new Error(error.message);

        const adapter = getHostingAdapter();
        const result = await adapter.createDeployment({
          deploymentId: deployment.id,
          projectId: deployment.project_id,
          environment: input.environment,
          sourceBranch: input.sourceBranch,
          commitSha: input.commitSha,
          sourceRepository: input.sourceRepository,
        });
        if (!result.configured) {
          const now = new Date().toISOString();
          const { data: updated, error: updateError } = await client
            .from("deployments")
            .update({ status: "failed", error_message: result.reason, completed_at: now, updated_at: now })
            .eq("id", deployment.id)
            .select("id,organization_id,project_id,environment,status,source_branch,commit_sha,source_repository,deployment_url,provider_ref,error_message,created_by,started_at,completed_at,created_at,updated_at")
            .single();
          if (updateError) throw new Error(updateError.message);
          await client.from("deployment_logs").insert({ deployment_id: deployment.id, organization_id: input.organizationId, level: "warn", message: result.reason, source: adapter.name });
          await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "deployment.create", resource_type: "deployment", resource_id: deployment.id, result: "failure", metadata: { adapter: adapter.name, reason: result.reason } });
          return { configured: false as const, reason: result.reason, deployment: updated };
        }

        const { data: updated, error: updateError } = await client
          .from("deployments")
          .update({ status: result.status, provider_ref: result.providerRef, deployment_url: result.deploymentUrl ?? null, started_at: deployment.started_at ?? new Date().toISOString(), completed_at: result.status === "ready" ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
          .eq("id", deployment.id)
          .select("id,organization_id,project_id,environment,status,source_branch,commit_sha,source_repository,deployment_url,provider_ref,error_message,created_by,started_at,completed_at,created_at,updated_at")
          .single();
        if (updateError) throw new Error(updateError.message);
        if (result.logs?.length) await client.from("deployment_logs").insert(result.logs.map(log => ({ deployment_id: deployment.id, organization_id: input.organizationId, level: log.level, message: log.message, source: adapter.name })));
        await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "deployment.create", resource_type: "deployment", resource_id: deployment.id, metadata: { adapter: adapter.name, providerRef: result.providerRef } });
        return { configured: true as const, deployment: updated };
      }),

    rollback: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data: deployment, error } = await client
          .from("deployments")
          .select("id,organization_id,project_id,status")
          .eq("id", input.id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!deployment) throw new Error("Deployment not found");
        if (deployment.status !== "ready") throw new Error("Only a ready deployment can be rolled back");
        const adapter = getHostingAdapter();
        const result = await adapter.rollbackDeployment(deployment.id);
        if (!result.configured) {
          await client.from("deployment_logs").insert({ deployment_id: deployment.id, organization_id: deployment.organization_id, level: "warn", message: result.reason, source: adapter.name });
          await client.from("deployment_rollback_history").insert({ deployment_id: deployment.id, organization_id: deployment.organization_id, project_id: deployment.project_id, previous_status: deployment.status, result: "failed", adapter_name: adapter.name, reason: result.reason, diff: { requestedStatus: "rolled_back", actualStatus: deployment.status }, created_by: ctx.identity.supabaseId });
          await client.from("audit_logs").insert({ organization_id: deployment.organization_id, actor_id: ctx.identity.supabaseId, action: "deployment.rollback", resource_type: "deployment", resource_id: deployment.id, result: "failure", metadata: { adapter: adapter.name, reason: result.reason } });
          return { configured: false as const, reason: result.reason };
        }
        const { data: updated, error: updateError } = await client
          .from("deployments")
          .update({ status: "rolled_back", updated_at: new Date().toISOString() })
          .eq("id", deployment.id)
          .select("id,organization_id,project_id,environment,status,source_branch,commit_sha,source_repository,deployment_url,provider_ref,error_message,created_by,started_at,completed_at,created_at,updated_at")
          .single();
        if (updateError) throw new Error(updateError.message);
        await client.from("deployment_rollback_history").insert({ deployment_id: deployment.id, organization_id: deployment.organization_id, project_id: deployment.project_id, previous_status: deployment.status, result: "completed", adapter_name: adapter.name, diff: { requestedStatus: "rolled_back", actualStatus: updated.status }, created_by: ctx.identity.supabaseId });
        if (result.logs?.length) await client.from("deployment_logs").insert(result.logs.map(log => ({ deployment_id: deployment.id, organization_id: deployment.organization_id, level: log.level, message: log.message, source: adapter.name })));
        await client.from("audit_logs").insert({ organization_id: deployment.organization_id, actor_id: ctx.identity.supabaseId, action: "deployment.rollback", resource_type: "deployment", resource_id: deployment.id, metadata: { adapter: adapter.name } });
        return { configured: true as const, deployment: updated };
      }),

    envVars: router({
      list: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid(), environment: z.enum(["production", "preview", "development"]) }))
        .query(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data, error } = await client.from("deployment_env_vars").select("id,organization_id,project_id,environment,name,masked_value,is_secret,created_by,created_at,updated_at").eq("organization_id", input.organizationId).eq("project_id", input.projectId).eq("environment", input.environment).order("name");
          if (error) throw new Error(error.message);
          return data ?? [];
        }),
      upsert: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid(), environment: z.enum(["production", "preview", "development"]), name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), valueRef: z.string().trim().min(1).max(2048).nullable().optional(), isSecret: z.boolean().default(true) }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data, error } = await client.from("deployment_env_vars").upsert({ organization_id: input.organizationId, project_id: input.projectId, environment: input.environment, name: input.name, value_ref: input.valueRef ?? null, masked_value: input.isSecret ? "••••••••" : (input.valueRef ?? ""), is_secret: input.isSecret, created_by: ctx.identity.supabaseId, updated_at: new Date().toISOString() }, { onConflict: "organization_id,project_id,environment,name" }).select("id,organization_id,project_id,environment,name,masked_value,is_secret,created_by,created_at,updated_at").single();
          if (error) throw new Error(error.message);
          await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "deployment.env_var.upsert", resource_type: "deployment_env_var", resource_id: data.id, metadata: { projectId: input.projectId, environment: input.environment, name: input.name } });
          return data;
        }),
      remove: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data: record, error: lookupError } = await client.from("deployment_env_vars").select("id,organization_id,name").eq("id", input.id).maybeSingle();
          if (lookupError) throw new Error(lookupError.message);
          if (!record) throw new Error("Environment variable not found");
          const { error } = await client.from("deployment_env_vars").delete().eq("id", input.id);
          if (error) throw new Error(error.message);
          await client.from("audit_logs").insert({ organization_id: record.organization_id, actor_id: ctx.identity.supabaseId, action: "deployment.env_var.remove", resource_type: "deployment_env_var", resource_id: record.id, metadata: { name: record.name } });
          return { success: true };
        }),
    }),

    domainBindings: router({
      list: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid() }))
        .query(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data, error } = await client.from("deployment_domain_bindings").select("id,organization_id,project_id,domain_id,environment,status,provider_ref,error_message,created_by,created_at,updated_at,domains(hostname)").eq("organization_id", input.organizationId).eq("project_id", input.projectId).order("created_at", { ascending: false });
          if (error) throw new Error(error.message);
          return data ?? [];
        }),
      bind: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid(), domainId: z.string().uuid(), environment: z.enum(["production", "preview", "development"]) }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data: domain, error: domainError } = await client.from("domains").select("id,organization_id,hostname").eq("id", input.domainId).eq("organization_id", input.organizationId).maybeSingle();
          if (domainError) throw new Error(domainError.message);
          if (!domain) throw new Error("Domain does not belong to this organization");
          const { data, error } = await client.from("deployment_domain_bindings").upsert({ organization_id: input.organizationId, project_id: input.projectId, domain_id: input.domainId, environment: input.environment, status: "not_configured", error_message: "Hosting domain binding adapter is not configured.", created_by: ctx.identity.supabaseId, updated_at: new Date().toISOString() }, { onConflict: "organization_id,project_id,domain_id,environment" }).select("id,organization_id,project_id,domain_id,environment,status,provider_ref,error_message,created_by,created_at,updated_at").single();
          if (error) throw new Error(error.message);
          await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "deployment.domain.bind", resource_type: "deployment_domain_binding", resource_id: data.id, metadata: { projectId: input.projectId, domainId: domain.id, hostname: domain.hostname, environment: input.environment } });
          return data;
        }),
    }),

    protection: router({
      get: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid() }))
        .query(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data, error } = await client
            .from("deployment_protection")
            .select("id,organization_id,project_id,enabled,require_authentication,preview_access,updated_by,created_at,updated_at")
            .eq("organization_id", input.organizationId)
            .eq("project_id", input.projectId)
            .maybeSingle();
          if (error) throw new Error(error.message);
          return data;
        }),
      set: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid(), enabled: z.boolean(), requireAuthentication: z.boolean(), previewAccess: z.enum(["public", "team", "private"]) }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data, error } = await client
            .from("deployment_protection")
            .upsert({ organization_id: input.organizationId, project_id: input.projectId, enabled: input.enabled, require_authentication: input.requireAuthentication, preview_access: input.previewAccess, updated_by: ctx.identity.supabaseId, updated_at: new Date().toISOString() }, { onConflict: "organization_id,project_id" })
            .select("id,organization_id,project_id,enabled,require_authentication,preview_access,updated_by,created_at,updated_at")
            .single();
          if (error) throw new Error(error.message);
          await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "deployment.protection.update", resource_type: "project", resource_id: input.projectId, metadata: { enabled: input.enabled, requireAuthentication: input.requireAuthentication, previewAccess: input.previewAccess } });
          return data;
        }),
    }),

    rollbackHistory: protectedProcedure
      .input(z.object({ deploymentId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data, error } = await client
          .from("deployment_rollback_history")
          .select("id,organization_id,project_id,deployment_id,previous_status,result,adapter_name,reason,diff,created_by,created_at")
          .eq("deployment_id", input.deploymentId)
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) throw new Error(error.message);
        return data ?? [];
      }),
  }),

  data: router({
    databaseInstances: router({
      list: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }).optional())
        .query(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
          if (membershipError) throw new Error(membershipError.message);
          const organizationIds = (memberships ?? []).map(row => row.organization_id).filter(id => !input?.organizationId || id === input.organizationId);
          if (!organizationIds.length) return [];
          let query = client.from("database_instances").select("id,organization_id,project_id,name,engine,status,tenant_identifier,adapter_ref,error_message,created_by,created_at,updated_at").in("organization_id", organizationIds).order("created_at", { ascending: false }).limit(100);
          if (input?.projectId) query = query.eq("project_id", input.projectId);
          const { data, error } = await query;
          if (error) throw new Error(error.message);
          return data ?? [];
        }),
      provision: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid().nullable().optional(), name: z.string().trim().min(1).max(120) }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          if (input.projectId) {
            const { data: project, error: projectError } = await client.from("projects").select("id").eq("id", input.projectId).eq("organization_id", input.organizationId).maybeSingle();
            if (projectError) throw new Error(projectError.message);
            if (!project) throw new Error("Project does not belong to this organization");
          }
          const { data: instance, error } = await client.from("database_instances").insert({ organization_id: input.organizationId, project_id: input.projectId ?? null, name: input.name, created_by: ctx.identity.supabaseId, status: "pending" }).select("id,organization_id,project_id,name,engine,status,tenant_identifier,adapter_ref,error_message,created_by,created_at,updated_at").single();
          if (error) throw new Error(error.message);
          const adapter = getDatabaseAdapter();
          const result = await adapter.provisionDatabase({ databaseInstanceId: instance.id, organizationId: instance.organization_id, projectId: instance.project_id, name: instance.name });
          if (!result.configured) {
            const now = new Date().toISOString();
            const { data: updated, error: updateError } = await client.from("database_instances").update({ status: "failed", error_message: result.reason, updated_at: now }).eq("id", instance.id).select("id,organization_id,project_id,name,engine,status,tenant_identifier,adapter_ref,error_message,created_by,created_at,updated_at").single();
            if (updateError) throw new Error(updateError.message);
            await client.from("audit_logs").insert({ organization_id: instance.organization_id, actor_id: ctx.identity.supabaseId, action: "database_instance.provision", resource_type: "database_instance", resource_id: instance.id, result: "failure", metadata: { adapter: adapter.name, reason: result.reason } });
            return { configured: false as const, reason: result.reason, instance: updated };
          }
          const { data: updated, error: updateError } = await client.from("database_instances").update({ status: result.status, adapter_ref: result.adapterRef, tenant_identifier: result.tenantIdentifier ?? null, updated_at: new Date().toISOString() }).eq("id", instance.id).select("id,organization_id,project_id,name,engine,status,tenant_identifier,adapter_ref,error_message,created_by,created_at,updated_at").single();
          if (updateError) throw new Error(updateError.message);
          await client.from("audit_logs").insert({ organization_id: instance.organization_id, actor_id: ctx.identity.supabaseId, action: "database_instance.provision", resource_type: "database_instance", resource_id: instance.id, metadata: { adapter: adapter.name, adapterRef: result.adapterRef } });
          return { configured: true as const, instance: updated };
        }),
    }),

    storageBuckets: router({
      list: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }).optional())
        .query(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
          if (membershipError) throw new Error(membershipError.message);
          const organizationIds = (memberships ?? []).map(row => row.organization_id).filter(id => !input?.organizationId || id === input.organizationId);
          if (!organizationIds.length) return [];
          let query = client.from("storage_buckets").select("id,organization_id,project_id,name,visibility,status,region,adapter_ref,error_message,created_by,created_at,updated_at").in("organization_id", organizationIds).order("created_at", { ascending: false }).limit(100);
          if (input?.projectId) query = query.eq("project_id", input.projectId);
          const { data, error } = await query;
          if (error) throw new Error(error.message);
          return data ?? [];
        }),
      provision: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), projectId: z.string().uuid().nullable().optional(), name: z.string().trim().min(1).max(120), visibility: z.enum(["private", "public"]), region: z.string().trim().min(1).max(80).nullable().optional() }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          if (input.projectId) {
            const { data: project, error: projectError } = await client.from("projects").select("id").eq("id", input.projectId).eq("organization_id", input.organizationId).maybeSingle();
            if (projectError) throw new Error(projectError.message);
            if (!project) throw new Error("Project does not belong to this organization");
          }
          const { data: bucket, error } = await client.from("storage_buckets").insert({ organization_id: input.organizationId, project_id: input.projectId ?? null, name: input.name, visibility: input.visibility, region: input.region ?? null, created_by: ctx.identity.supabaseId, status: "pending" }).select("id,organization_id,project_id,name,visibility,status,region,adapter_ref,error_message,created_by,created_at,updated_at").single();
          if (error) throw new Error(error.message);
          const adapter = getStorageAdapter();
          const result = await adapter.provisionBucket({ bucketId: bucket.id, organizationId: bucket.organization_id, projectId: bucket.project_id, name: bucket.name, visibility: bucket.visibility, region: bucket.region });
          if (!result.configured) {
            const { data: updated, error: updateError } = await client.from("storage_buckets").update({ status: "failed", error_message: result.reason, updated_at: new Date().toISOString() }).eq("id", bucket.id).select("id,organization_id,project_id,name,visibility,status,region,adapter_ref,error_message,created_by,created_at,updated_at").single();
            if (updateError) throw new Error(updateError.message);
            await client.from("audit_logs").insert({ organization_id: bucket.organization_id, actor_id: ctx.identity.supabaseId, action: "storage_bucket.provision", resource_type: "storage_bucket", resource_id: bucket.id, result: "failure", metadata: { adapter: adapter.name, reason: result.reason } });
            return { configured: false as const, reason: result.reason, bucket: updated };
          }
          const { data: updated, error: updateError } = await client.from("storage_buckets").update({ status: result.status, adapter_ref: result.adapterRef, updated_at: new Date().toISOString() }).eq("id", bucket.id).select("id,organization_id,project_id,name,visibility,status,region,adapter_ref,error_message,created_by,created_at,updated_at").single();
          if (updateError) throw new Error(updateError.message);
          await client.from("audit_logs").insert({ organization_id: bucket.organization_id, actor_id: ctx.identity.supabaseId, action: "storage_bucket.provision", resource_type: "storage_bucket", resource_id: bucket.id, metadata: { adapter: adapter.name, adapterRef: result.adapterRef } });
          return { configured: true as const, bucket: updated };
        }),
    }),

    storageFiles: router({
      files: router({
        list: protectedProcedure
          .input(z.object({ bucketId: z.string().uuid() }))
          .query(async ({ ctx, input }) => {
            const client = getSupabaseUserClient(ctx.req);
            if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
            const { data, error } = await client.from("storage_files").select("id,organization_id,storage_bucket_id,object_key,content_type,size_bytes,status,adapter_ref,error_message,created_by,created_at,updated_at").eq("storage_bucket_id", input.bucketId).order("object_key").limit(500);
            if (error) throw new Error(error.message);
            return data ?? [];
          }),
        upload: protectedProcedure
          .input(z.object({ organizationId: z.string().uuid(), bucketId: z.string().uuid(), objectKey: z.string().trim().min(1).max(1024), contentType: z.string().trim().max(255).nullable().optional() }))
          .mutation(async ({ ctx, input }) => {
            const client = getSupabaseUserClient(ctx.req);
            if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
            const { data: bucket, error: bucketError } = await client.from("storage_buckets").select("id,organization_id").eq("id", input.bucketId).eq("organization_id", input.organizationId).maybeSingle();
            if (bucketError) throw new Error(bucketError.message);
            if (!bucket) throw new Error("Bucket not found in this organization");
            const { data: file, error } = await client.from("storage_files").insert({ organization_id: input.organizationId, storage_bucket_id: input.bucketId, object_key: input.objectKey, content_type: input.contentType ?? null, created_by: ctx.identity.supabaseId, status: "pending" }).select("id,organization_id,storage_bucket_id,object_key,content_type,size_bytes,status,adapter_ref,error_message,created_by,created_at,updated_at").single();
            if (error) throw new Error(error.message);
            const adapter = getStorageAdapter();
            const result = await adapter.uploadFile({ fileId: file.id, bucketId: file.storage_bucket_id, organizationId: file.organization_id, objectKey: file.object_key, contentType: file.content_type });
            const { data: updated, error: updateError } = await client.from("storage_files").update({ status: result.configured ? result.status : "failed", adapter_ref: result.configured ? result.adapterRef : null, error_message: result.configured ? null : result.reason, updated_at: new Date().toISOString() }).eq("id", file.id).select("id,organization_id,storage_bucket_id,object_key,content_type,size_bytes,status,adapter_ref,error_message,created_by,created_at,updated_at").single();
            if (updateError) throw new Error(updateError.message);
            await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "storage_file.upload", resource_type: "storage_file", resource_id: file.id, result: result.configured ? "success" : "failure", metadata: { adapter: adapter.name, objectKey: input.objectKey, reason: result.configured ? null : result.reason } });
            return { configured: result.configured, reason: result.configured ? "File upload accepted by storage adapter." : result.reason, file: updated };
          }),
      }),
    }),

    backups: router({
      list: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid().optional(), resourceType: z.enum(["database", "storage"]).optional() }).optional())
        .query(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
          if (membershipError) throw new Error(membershipError.message);
          const organizationIds = (memberships ?? []).map(row => row.organization_id).filter(id => !input?.organizationId || id === input.organizationId);
          if (!organizationIds.length) return [];
          let query = client.from("backups").select("id,organization_id,resource_type,database_instance_id,storage_bucket_id,status,adapter_ref,size_bytes,error_message,started_at,completed_at,created_by,created_at").in("organization_id", organizationIds).order("created_at", { ascending: false }).limit(100);
          if (input?.resourceType) query = query.eq("resource_type", input.resourceType);
          const { data, error } = await query;
          if (error) throw new Error(error.message);
          return data ?? [];
        }),
      create: protectedProcedure
        .input(z.object({ organizationId: z.string().uuid(), resourceType: z.enum(["database", "storage"]), resourceId: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const resourceTable = input.resourceType === "database" ? "database_instances" : "storage_buckets";
          const { data: resource, error: resourceError } = await client.from(resourceTable).select("id,organization_id").eq("id", input.resourceId).eq("organization_id", input.organizationId).maybeSingle();
          if (resourceError) throw new Error(resourceError.message);
          if (!resource) throw new Error("Resource not found in this organization");
          const resourceFields = input.resourceType === "database" ? { database_instance_id: input.resourceId, storage_bucket_id: null } : { database_instance_id: null, storage_bucket_id: input.resourceId };
          const { data: backup, error } = await client.from("backups").insert({ organization_id: input.organizationId, resource_type: input.resourceType, ...resourceFields, created_by: ctx.identity.supabaseId, status: "pending" }).select("id,organization_id,resource_type,database_instance_id,storage_bucket_id,status,adapter_ref,size_bytes,error_message,started_at,completed_at,created_by,created_at").single();
          if (error) throw new Error(error.message);
          const adapter = input.resourceType === "database" ? getDatabaseAdapter() : getStorageAdapter();
          const result = await adapter.createBackup({ backupId: backup.id, organizationId: backup.organization_id, resourceType: input.resourceType, resourceId: input.resourceId });
          if (!result.configured) {
            const { data: updated, error: updateError } = await client.from("backups").update({ status: "failed", error_message: result.reason }).eq("id", backup.id).select("id,organization_id,resource_type,database_instance_id,storage_bucket_id,status,adapter_ref,size_bytes,error_message,started_at,completed_at,created_by,created_at").single();
            if (updateError) throw new Error(updateError.message);
            await client.from("audit_logs").insert({ organization_id: backup.organization_id, actor_id: ctx.identity.supabaseId, action: "backup.create", resource_type: "backup", resource_id: backup.id, result: "failure", metadata: { adapter: adapter.name, reason: result.reason, resourceType: input.resourceType } });
            return { configured: false as const, reason: result.reason, backup: updated };
          }
          const { data: updated, error: updateError } = await client.from("backups").update({ status: result.status, adapter_ref: result.adapterRef, size_bytes: result.sizeBytes ?? null }).eq("id", backup.id).select("id,organization_id,resource_type,database_instance_id,storage_bucket_id,status,adapter_ref,size_bytes,error_message,started_at,completed_at,created_by,created_at").single();
          if (updateError) throw new Error(updateError.message);
          await client.from("audit_logs").insert({ organization_id: backup.organization_id, actor_id: ctx.identity.supabaseId, action: "backup.create", resource_type: "backup", resource_id: backup.id, metadata: { adapter: adapter.name, adapterRef: result.adapterRef, resourceType: input.resourceType } });
          return { configured: true as const, backup: updated };
        }),
      restore: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data: backup, error } = await client.from("backups").select("id,organization_id,resource_type,database_instance_id,storage_bucket_id").eq("id", input.id).maybeSingle();
          if (error) throw new Error(error.message);
          if (!backup) throw new Error("Backup not found");
          const adapter = backup.resource_type === "database" ? getDatabaseAdapter() : getStorageAdapter();
          const resourceId = backup.database_instance_id ?? backup.storage_bucket_id;
          if (!resourceId) throw new Error("Backup resource is missing");
          const result = await adapter.restoreBackup({ backupId: backup.id, organizationId: backup.organization_id, resourceType: backup.resource_type, resourceId });
          const { data: updated, error: updateError } = await client.from("backups").update({ restore_status: result.configured ? "completed" : "failed", restored_at: result.configured ? new Date().toISOString() : null, restore_error: result.configured ? null : result.reason }).eq("id", backup.id).select("id,restore_status,restored_at,restore_error").single();
          if (updateError) throw new Error(updateError.message);
          await client.from("audit_logs").insert({ organization_id: backup.organization_id, actor_id: ctx.identity.supabaseId, action: "backup.restore", resource_type: "backup", resource_id: backup.id, result: result.configured ? "success" : "failure", metadata: { adapter: adapter.name, reason: result.configured ? null : result.reason } });
          return { configured: result.configured, reason: result.configured ? "Restore completed." : result.reason, backup: updated };
        }),
      schedules: router({
        list: protectedProcedure.query(async ({ ctx }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { data: memberships, error: membershipError } = await client.from("organization_members").select("organization_id").eq("user_id", ctx.identity.supabaseId).limit(100);
          if (membershipError) throw new Error(membershipError.message);
          const ids = (memberships ?? []).map(row => row.organization_id);
          if (!ids.length) return [];
          const { data, error } = await client.from("backup_schedules").select("id,organization_id,database_instance_id,storage_bucket_id,frequency,enabled,next_run_at,last_run_at,created_by,created_at,updated_at").in("organization_id", ids).order("updated_at", { ascending: false }).limit(100);
          if (error) throw new Error(error.message);
          return data ?? [];
        }),
        create: protectedProcedure.input(z.object({ organizationId: z.string().uuid(), resourceType: z.enum(["database", "storage"]), resourceId: z.string().uuid(), frequency: z.enum(["hourly", "daily", "weekly"]) })).mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const fields = input.resourceType === "database" ? { database_instance_id: input.resourceId, storage_bucket_id: null } : { database_instance_id: null, storage_bucket_id: input.resourceId };
          const { data, error } = await client.from("backup_schedules").insert({ organization_id: input.organizationId, ...fields, frequency: input.frequency, created_by: ctx.identity.supabaseId }).select("id,organization_id,database_instance_id,storage_bucket_id,frequency,enabled,next_run_at,last_run_at,created_by,created_at,updated_at").single();
          if (error) throw new Error(error.message);
          await client.from("audit_logs").insert({ organization_id: input.organizationId, actor_id: ctx.identity.supabaseId, action: "backup.schedule.create", resource_type: "backup_schedule", resource_id: data.id, metadata: { frequency: input.frequency, resourceType: input.resourceType, resourceId: input.resourceId } });
          return data;
        }),
      }),
    }),
  }),

  account: router({
    me: protectedProcedure.query(({ ctx }) => ({
      id: ctx.identity?.supabaseId ?? null,
      name: ctx.identity?.name ?? null,
      email: ctx.identity?.email ?? null,
      loginMethod: ctx.identity?.loginMethod ?? "unknown",
      role: ctx.identity?.role ?? "user",
    })),
    apiKeys: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        const client = getSupabaseUserClient(ctx.req);
        if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
        const { data, error } = await client
          .from("api_keys")
          .select("id,name,key_prefix,last_used_at,expires_at,revoked_at,created_at")
          .eq("user_id", ctx.identity.supabaseId)
          .order("created_at", { ascending: false });
        if (error) throw new Error(error.message);
        return data ?? [];
      }),
      create: protectedProcedure
        .input(z.object({ name: z.string().trim().min(1).max(80), expiresAt: z.string().datetime().nullable().optional() }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const raw = `uscs_${randomBytes(24).toString("base64url")}`;
          const hash = createHash("sha256").update(raw).digest("hex");
          const prefix = raw.slice(0, 12);
          const { data, error } = await client
            .from("api_keys")
            .insert({
              user_id: ctx.identity.supabaseId,
              name: input.name,
              key_prefix: prefix,
              key_hash: hash,
              expires_at: input.expiresAt ?? null,
            })
            .select("id,name,key_prefix,last_used_at,expires_at,revoked_at,created_at")
            .single();
          if (error) throw new Error(error.message);
          return { key: raw, record: data };
        }),
      revoke: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
          const client = getSupabaseUserClient(ctx.req);
          if (!client || !ctx.identity?.supabaseId) throw new Error("Supabase session unavailable");
          const { error } = await client
            .from("api_keys")
            .update({ revoked_at: new Date().toISOString() })
            .eq("id", input.id)
            .eq("user_id", ctx.identity.supabaseId)
            .is("revoked_at", null);
          if (error) throw new Error(error.message);
          return { success: true };
        }),
    }),
  }),

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
