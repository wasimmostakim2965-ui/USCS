import { createClient } from "@supabase/supabase-js";
import type { Request } from "express";
import * as db from "../db";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const supabase = supabaseUrl && supabasePublishableKey
  ? createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export type SupabaseIdentity = {
  id: string;
  supabaseId: string;
  name: string | null;
  email: string | null;
  loginMethod: string;
  role: "user" | "admin";
};

export async function authenticateSupabaseRequest(req: Request): Promise<SupabaseIdentity | null> {
  if (!supabase) return null;
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const accessToken = authorization.slice("Bearer ".length).trim();
  if (!accessToken) return null;

  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) return null;

  const metadata = data.user.user_metadata ?? {};
  const displayName = typeof metadata.full_name === "string"
    ? metadata.full_name
    : typeof metadata.name === "string"
      ? metadata.name
      : data.user.email?.split("@")[0] ?? null;

  const loginMethod = data.user.app_metadata?.provider ?? "supabase";

  // Keep the existing Manus table synchronized when it is configured, but do
  // not make a valid Supabase session depend on that legacy database being
  // reachable. Supabase Auth remains the authoritative identity source.
  try {
    await db.upsertUser({
      openId: `supabase:${data.user.id}`,
      name: displayName,
      email: data.user.email ?? null,
      loginMethod,
      lastSignedIn: new Date(),
    });
  } catch {
    // The request can still be authenticated. Tenant data is protected by
    // Supabase RLS and is handled separately from this compatibility bridge.
  }

  const legacyUser = await db.getUserByOpenId(`supabase:${data.user.id}`).catch(() => undefined);
  return legacyUser
    ? { ...legacyUser, id: String(legacyUser.id), supabaseId: data.user.id, loginMethod: legacyUser.loginMethod ?? loginMethod, role: legacyUser.role }
    : {
        id: data.user.id,
        supabaseId: data.user.id,
        name: displayName,
        email: data.user.email ?? null,
        loginMethod,
        role: "user",
      };
}
