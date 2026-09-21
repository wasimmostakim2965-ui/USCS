import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";

// The publishable key is intentionally browser-safe. Environment variables remain
// the preferred deployment configuration; these fallbacks keep a static Vercel
// build functional when the project was deployed without Vercel env injection.
const CANONICAL_SUPABASE_URL = "https://lqaocykcxwnulirtykqy.supabase.co";
const configuredSupabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;

// USCS currently has one authoritative Supabase project. Never allow a stale
// deployment environment variable to silently redirect OAuth to another host.
const supabaseUrl = configuredSupabaseUrl === CANONICAL_SUPABASE_URL
  ? configuredSupabaseUrl
  : CANONICAL_SUPABASE_URL;
const CANONICAL_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_lG-q-jr7VNotmSNiO6gV9Q_hwelEAH-";
const configuredSupabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const supabasePublishableKey = configuredSupabasePublishableKey === CANONICAL_SUPABASE_PUBLISHABLE_KEY
  ? configuredSupabasePublishableKey
  : CANONICAL_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseAuthConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export const supabase: SupabaseClient | null = isSupabaseAuthConfigured
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export type SupabaseProvider = "google" | "github" | "gitlab";

export type SupabaseProvider = "google" | "github" | "gitlab";

export function subscribeToSupabaseAuth(callback: (event: AuthChangeEvent, session: Session | null) => void) {
  return supabase?.auth.onAuthStateChange(callback) ?? { data: { subscription: { unsubscribe: () => undefined } } };
}
