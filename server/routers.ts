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
import type { SecurityLevel } from "./securityPolicy";

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
          await client.from("audit_logs").insert({ organization_id: domain.organization_id, actor_id: ctx.identity.supabaseId, action: "dns_record.create", resource_type: "dns_record", resource_id: data.id, metadata: { domainId: input.domainId, recordType: input.recordType, name: input.name } });
          return { configured: false as const, reason: "DNS record saved locally. A DNS adapter is required to publish it.", record: data };
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
