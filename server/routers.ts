import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getSupabaseUserClient } from "./_core/supabaseAuth";
import { getHostingAdapter, type DeploymentEnvironment } from "./adapters/hosting";
import { getDatabaseAdapter, getStorageAdapter } from "./adapters/data";

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
          .update({ status: result.status, provider_ref: result.providerRef, deployment_url: result.deploymentUrl ?? null, updated_at: new Date().toISOString() })
          .eq("id", deployment.id)
          .select("id,organization_id,project_id,environment,status,source_branch,commit_sha,source_repository,deployment_url,provider_ref,error_message,created_by,started_at,completed_at,created_at,updated_at")
          .single();
        if (updateError) throw new Error(updateError.message);
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
        await client.from("audit_logs").insert({ organization_id: deployment.organization_id, actor_id: ctx.identity.supabaseId, action: "deployment.rollback", resource_type: "deployment", resource_id: deployment.id, metadata: { adapter: adapter.name } });
        return { configured: true as const, deployment: updated };
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
