import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const isSupabaseAuthConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export const supabase: SupabaseClient | null = isSupabaseAuthConfigured
  ? createClient(supabaseUrl!, supabasePublishableKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export type SupabaseProvider = "google" | "github" | "gitlab";

export function getAuthRedirectUrl() {
  const configured = import.meta.env.VITE_SUPABASE_AUTH_REDIRECT_URL as string | undefined;
  if (configured) return configured;
  return `${window.location.origin}/`;
}

export async function signInWithProvider(provider: SupabaseProvider) {
  if (!supabase) {
    return { error: new Error("Supabase authentication is not configured for this deployment.") };
  }
  return supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: getAuthRedirectUrl(),
      queryParams: { prompt: "select_account" },
    },
  });
}

export async function getSupabaseSession() {
  return supabase?.auth.getSession() ?? { data: { session: null }, error: null };
}

export function subscribeToSupabaseAuth(callback: (event: AuthChangeEvent, session: Session | null) => void) {
  return supabase?.auth.onAuthStateChange(callback) ?? { data: { subscription: { unsubscribe: () => undefined } } };
}
