import { createClient, type AuthChangeEvent, type Session, type SupabaseClient } from "@supabase/supabase-js";

// The publishable key is intentionally browser-safe. Environment variables remain
// the preferred deployment configuration; these fallbacks keep a static Vercel
// build functional when the project was deployed without Vercel env injection.
const CANONICAL_SUPABASE_URL = "https://lqaocykcxwnulirtykqy.supabase.co";
const configuredSupabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;

// Cloud Wai currently has one authoritative Supabase project. Never allow a stale
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
        // AuthCallback performs the PKCE code exchange exactly once. Leaving
        // automatic URL detection enabled creates a race on mobile browsers.
        detectSessionInUrl: false,
        flowType: "pkce",
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
  if (configured) {
    try {
      const configuredUrl = new URL(configured);
      if (configuredUrl.origin === window.location.origin) {
        return configuredUrl.toString();
      }
    } catch {
      // Fall through to the current browser origin.
    }
  }
  return `${window.location.origin}/auth/callback`;
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

export function startLogin() {
  void signInWithProvider("google");
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

  // The auth trigger is intentionally non-blocking. Retry tenant provisioning
  // from the authenticated browser so a transient trigger failure never makes
  // a valid Google session look unauthenticated.
  await supabase.rpc("ensure_user_workspace", {
    target_user_id: user.id,
    target_email: user.email ?? "",
    target_metadata: metadata,
  });

  return {
    id: user.id,
    name: fallbackName,
    email: user.email ?? null,
    loginMethod: user.app_metadata?.provider ?? "supabase",
    role: "user",
  };
}


export function subscribeToSupabaseAuth(callback: (event: AuthChangeEvent, session: Session | null) => void) {
  return supabase?.auth.onAuthStateChange(callback) ?? { data: { subscription: { unsubscribe: () => undefined } } };
}
