import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";

// The publishable key is intentionally browser-safe. Environment variables remain
// the preferred deployment configuration; these fallbacks keep a static Vercel
// build functional when the project was deployed without Vercel env injection.
const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "https://lqaocykcxwnulirtykqy.supabase.co";
const supabasePublishableKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? "sb_publishable_lG-q-jr7VNotmSNiO6gV9Q_hwelEAH-";

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

export type BrowserAuthUser = {
  id: string;
  name: string | null;
  email: string | null;
  loginMethod: string;
  role: "user";
};

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

export async function getBrowserAuthUser(): Promise<BrowserAuthUser | null> {
  if (!supabase) return null;
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;

  const metadata = user.user_metadata ?? {};
  const fallbackName = typeof metadata.full_name === "string"
    ? metadata.full_name
    : typeof metadata.name === "string"
      ? metadata.name
      : user.email?.split("@")[0] ?? null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, email")
    .eq("id", user.id)
    .maybeSingle();

  return {
    id: user.id,
    name: profile?.display_name ?? fallbackName,
    email: profile?.email ?? user.email ?? null,
    loginMethod: user.app_metadata?.provider ?? "supabase",
    role: "user",
  };
}

export function subscribeToSupabaseAuth(callback: (event: AuthChangeEvent, session: Session | null) => void) {
  return supabase?.auth.onAuthStateChange(callback) ?? { data: { subscription: { unsubscribe: () => undefined } } };
}
