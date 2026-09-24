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
  signOut(): Promise<void>;
  /** Subscribe to sign-in/sign-out. Returns an unsubscribe function. */
  subscribe(listener: (session: BrowserSession | null) => void): () => void;
  /** False when Supabase is not configured, which the UI reports honestly. */
  readonly configured: boolean;
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
