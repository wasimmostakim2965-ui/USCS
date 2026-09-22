import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Request } from "express";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

const supabase = supabaseUrl && supabasePublishableKey
  ? createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const supabaseAdmin: SupabaseClient | null = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export type SupabaseIdentity = {
  id: string;
  supabaseId: string;
  name: string | null;
  email: string | null;
  loginMethod: string;
  role: "user" | "admin";
  authMethod: "session" | "api_key";
};

function identityFromAuthUser(user: { id: string; email?: string | null; user_metadata?: Record<string, unknown>; app_metadata?: Record<string, unknown> }, authMethod: SupabaseIdentity["authMethod"]): SupabaseIdentity {
  const metadata = user.user_metadata ?? {};
  const displayName = typeof metadata.full_name === "string"
    ? metadata.full_name
    : typeof metadata.name === "string"
      ? metadata.name
      : user.email?.split("@")[0] ?? null;
  return {
    id: user.id,
    supabaseId: user.id,
    name: displayName,
    email: user.email ?? null,
    loginMethod: typeof user.app_metadata?.provider === "string" ? user.app_metadata.provider : "supabase",
    role: "user",
    authMethod,
  };
}

export async function authenticateSupabaseRequest(req: Request): Promise<SupabaseIdentity | null> {
  if (!supabase) return null;
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const accessToken = authorization.slice("Bearer ".length).trim();
  if (!accessToken || accessToken.startsWith("uscs_")) return null;
  const { data, error } = await supabase.auth.getUser(accessToken);
  return error || !data.user ? null : identityFromAuthUser(data.user, "session");
}

function readApiKey(req: Request): string | null {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("ApiKey ")) return authorization.slice("ApiKey ".length).trim() || null;
  if (authorization?.startsWith("Bearer uscs_")) return authorization.slice("Bearer ".length).trim();
  return null;
}

export async function authenticateApiKeyRequest(req: Request): Promise<SupabaseIdentity | null> {
  const rawKey = readApiKey(req);
  if (!rawKey || !supabaseAdmin) return null;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const { data: key, error } = await supabaseAdmin
    .from("api_keys")
    .select("id,user_id,expires_at,revoked_at")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (error || !key || key.revoked_at) return null;
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return null;

  const { data: updated, error: updateError } = await supabaseAdmin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.id)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (updateError || !updated) return null;

  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(key.user_id);
  return authError || !authUser.user ? null : identityFromAuthUser(authUser.user, "api_key");
}

export function getSupabaseUserClient(req: Request) {
  if (!supabase) return null;
  if (readApiKey(req)) return supabaseAdmin;
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const accessToken = authorization.slice("Bearer ".length).trim();
  if (!accessToken || accessToken.startsWith("uscs_")) return null;
  return createClient(supabaseUrl!, supabasePublishableKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export function getSupabaseAdminClient() {
  return supabaseAdmin;
}
