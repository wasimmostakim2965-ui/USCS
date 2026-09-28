/**
 * Browser session.
 *
 * Supabase Auth is the only browser identity source. This module is the only
 * place the dashboard holds a session, and it exposes the access token to the
 * `ApiClient` and nothing else. A hosting engine's user is never a customer
 * identity, and no engine credential is ever held here.
 *
 * The session is read from `localStorage` through the official client, which
 * refreshes the token before it expires. Writing that logic by hand would be a
 * place to get token rotation subtly wrong.
 */
import { createClient, type SupabaseClient, type Session } from "@supabase/supabase-js";

export interface BrowserSession {
  readonly userId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly accessToken: string;
}

export interface SessionConfig {
  /** Supabase project URL. */
  readonly url: string;
  /** Anon/publishable key. Public by design; it is not a secret. */
  readonly anonKey: string;
}

/**
 * The dashboard's session controller.
 *
 * `getAccessToken` is synchronous because the API client calls it on every
 * request; the current access token is cached in memory and kept current by the
 * client's own refresh timer.
 */
export interface SessionController {
  /** The current session, or null when signed out. */
  current(): BrowserSession | null;
  /** The token for `ApiClient`, or null. */
  getAccessToken(): string | null;
  signInWithPassword(email: string, password: string): Promise<void>;
  signUpWithPassword(
    email: string,
    password: string,
  ): Promise<{ readonly needsConfirmation: boolean }>;
  /**
   * Adopt a session the server already established, without a password in the
   * browser. Used only by the pre-launch demo sign-in, where the API holds the
   * credential and returns the tokens.
   */
  applySession(tokens: {
    readonly accessToken: string;
    readonly refreshToken: string;
  }): Promise<void>;
  signOut(): Promise<void>;
  /** Subscribe to sign-in/sign-out. Returns an unsubscribe function. */
  subscribe(listener: (session: BrowserSession | null) => void): () => void;
  /** False when Supabase is not configured, which the UI reports honestly. */
  readonly configured: boolean;
  /**
   * True when this controller signs a fixed demo account in automatically, with
   * no sign-in form. It is a deliberate, temporary bypass used only while the
   * product is being demonstrated before public sign-up exists; the dashboard
   * skips the landing page when it is set. Absent means the normal behaviour.
   */
  readonly autoEnter?: boolean;
}

function toBrowserSession(session: Session | null): BrowserSession | null {
  if (!session?.user) return null;
  const user = session.user;
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const display = ["display_name", "full_name", "name"].find(
    (key) => typeof meta[key] === "string" && (meta[key] as string).trim() !== "",
  );
  return {
    userId: user.id,
    email: user.email ?? null,
    displayName: display ? (meta[display] as string) : null,
    accessToken: session.access_token,
  };
}

/**
 * Read session configuration from Vite's environment.
 *
 * Both values are public: the anon key is designed to be shipped to a browser.
 * The service-role key is deliberately not read here, and must never be.
 */
export function sessionConfigFromEnv(
  env: Record<string, string | undefined>,
): SessionConfig | null {
  const url = env["VITE_SUPABASE_URL"];
  const anonKey = env["VITE_SUPABASE_ANON_KEY"];
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** A controller for a deployment with no Supabase project configured. */
export function unconfiguredSessionController(): SessionController {
  return {
    configured: false,
    current: () => null,
    getAccessToken: () => null,
    async signInWithPassword() {
      throw new Error("Supabase is not configured for this deployment.");
    },
    async signUpWithPassword() {
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
      // The dashboard uses email/password, not the OAuth redirect flow, so the
      // URL is not parsed for a session.
      detectSessionInUrl: false,
    },
  });

  let session: BrowserSession | null = null;
  const listeners = new Set<(session: BrowserSession | null) => void>();

  const emit = (next: BrowserSession | null) => {
    session = next;
    for (const listener of listeners) listener(next);
  };

  client.auth.onAuthStateChange((_event, next) => {
    emit(toBrowserSession(next));
  });

  // Resolve any persisted session before the first render.
  void client.auth.getSession().then(({ data }) => {
    emit(toBrowserSession(data.session));
  });

  return {
    configured: true,
    current: () => session,
    getAccessToken: () => session?.accessToken ?? null,
    async signInWithPassword(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
    },
    async signUpWithPassword(email, password) {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw new Error(error.message);
      // With email confirmation on, there is no session yet.
      return { needsConfirmation: data.session === null };
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

/**
 * Wrap a controller so it asks the API for a demo session and adopts it, with no
 * user action and no credential in the browser.
 *
 * The password is never in this bundle: the request carries only the procedure
 * name, and the API performs the password grant with credentials it holds in its
 * own environment. The bypass is therefore switchable and rate-limited on the
 * server, and reading the dashboard's JavaScript yields no account.
 *
 * The retry loop tolerates the API not yet being reachable on first paint; it
 * stops as soon as a session exists or the API answers a definitive refusal.
 */
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
      if (!response.ok) {
        // A definitive refusal (the bypass is off, or rate-limited) is not worth
        // retrying; only an unreachable API is.
        return response.status !== 502;
      }
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
      // The API is not reachable yet; the loop retries.
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
