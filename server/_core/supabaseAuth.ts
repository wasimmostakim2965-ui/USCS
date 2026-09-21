import { createClient } from "@supabase/supabase-js";
import type { Request } from "express";
import * as db from "../db";
import type { User } from "../../drizzle/schema";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const supabase = supabaseUrl && supabasePublishableKey
  ? createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export async function authenticateSupabaseRequest(req: Request): Promise<User | null> {
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

  await db.upsertUser({
    openId: `supabase:${data.user.id}`,
    name: displayName,
    email: data.user.email ?? null,
    loginMethod: data.user.app_metadata?.provider ?? "supabase",
    lastSignedIn: new Date(),
  });

  return db.getUserByOpenId(`supabase:${data.user.id}`) as Promise<User | null>;
}
