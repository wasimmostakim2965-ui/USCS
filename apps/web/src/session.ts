import { createClient, type SupabaseClient, type Session } from "@supabase/supabase-js";

export type OAuthProvider = "google" | "github" | "gitlab";

export interface BrowserSession {
  readonly userId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly accessToken: string;
}

export interface SessionConfig {
  readonly url: string;
  readonly anonKey: string;
}

export interface SessionController {
  current(): BrowserSession | null;
  getAccessToken(): string | null;
  signInWithProvider(provider: OAuthProvider): Promise<void>;
  applySession(tokens: {
    readonly accessToken: string;
    readonly refreshToken: string;
  }): Promise<void>;
  signOut(): Promise<void>;
  subscribe(listener: (session: BrowserSession | null) => void): () => void;
  readonly configured: boolean;
  readonly autoEnter?: boolean;
}

function toBrowserSession(session: Session | null): BrowserSession | null {
  if (!session?.user) return null;
  const user = session.user;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const display = ["display_name", "full_name", "name", "user_name"].find(
    (key) => typeof meta[key] === "string" && (meta[key] as string).trim() !== "",
  );
  return {
    userId: user.id,
    email: user.email ?? null,
    displayName: display ? (meta[display] as string) : null,
    accessToken: session.access_token,
  };
}

export function sessionConfigFromEnv(
  env: Record<string, string | undefined>,
): SessionConfig | null {
  const url = env["VITE_SUPABASE_URL"];
  const anonKey = env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? env["VITE_SUPABASE_ANON_KEY"];
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

export function authCallbackUrl(): string {
  return `${window.location.origin}/auth/callback`;
}

export function unconfiguredSessionController(): SessionController {
  return {
    configured: false,
    current: () => null,
    getAccessToken: () => null,
    async signInWithProvider() {
      throw new Error("Supabase is not configured for this deployment.");
    },
    async applySession() {
      throw new Error("Supabase is not configured for this deployment.");
    },
    async signOut() {},
    subscribe() {
      return () => {};
    },
  };
}

export function createSessionController(config: SessionConfig): SessionController {
  const client: SupabaseClient = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });

  let session: BrowserSession | null = null;
  const listeners = new Set<(session: BrowserSession | null) => void>();
  const emit = (next: BrowserSession | null) => {
    session = next;
    for (const listener of listeners) listener(next);
  };

  client.auth.onAuthStateChange((_event, next) => emit(toBrowserSession(next)));
  void client.auth.getSession().then(({ data }) => emit(toBrowserSession(data.session)));

  return {
    configured: true,
    current: () => session,
    getAccessToken: () => session?.accessToken ?? null,
    async signInWithProvider(provider) {
      const { error } = await client.auth.signInWithOAuth({
        provider,
        options: { redirectTo: authCallbackUrl(), queryParams: { prompt: "select_account" } },
      });
      if (error) throw new Error(error.message);
    },
    async applySession(tokens) {
      const { error } = await client.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });
      if (error) throw new Error(error.message);
    },
    async signOut() {
      await client.auth.signOut();
      emit(null);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function withDemoSession(base: SessionController, apiBaseUrl: string): SessionController {
  let inFlight = false;
  const attempt = async (): Promise<boolean> => {
    if (inFlight || base.current()) return true;
    inFlight = true;
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ procedure: "demo.session" }),
      });
      if (!response.ok) return response.status !== 502;
      const payload = (await response.json()) as {
        ok?: boolean;
        data?: { accessToken?: string; refreshToken?: string };
      };
      const accessToken = payload.data?.accessToken;
      const refreshToken = payload.data?.refreshToken;
      if (!payload.ok || !accessToken || !refreshToken) return true;
      await base.applySession({ accessToken, refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      inFlight = false;
    }
  };

  void (async () => {
    for (let i = 0; i < 60 && !base.current(); i += 1) {
      const settled = await attempt();
      if (base.current() || settled) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();

  return { ...base, autoEnter: true };
}
