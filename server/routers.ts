import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getSupabaseUserClient } from "./_core/supabaseAuth";

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
