/**
 * Supabase session verification.
 *
 * The token the browser sends is a Supabase access token. This is the only
 * place it is checked: the API resolves a principal from it and never trusts an
 * identity claim from the request body.
 *
 * `verify` fails closed. An unparseable response, a non-2xx status and a
 * transport error all return `null`, which the caller turns into
 * `unauthenticated`. A verification outage therefore denies access rather than
 * admitting an unverified caller.
 */
import type { SessionVerifier, SupabaseSession } from "./index.js";

export interface SupabaseAuthConfig {
  /** Project URL, e.g. https://<project>.supabase.co */
  readonly url: string;
  /** Anon/publishable key. Sent as `apikey`; it is not a secret. */
  readonly anonKey: string;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface SupabaseUser {
  readonly id?: unknown;
  readonly email?: unknown;
  readonly user_metadata?: unknown;
}

function displayNameOf(user: SupabaseUser): string | null {
  if (!user.user_metadata || typeof user.user_metadata !== "object") return null;
  const meta = user.user_metadata as Record<string, unknown>;
  for (const key of ["display_name", "full_name", "name"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * Build a verifier backed by Supabase Auth.
 *
 * It calls `GET /auth/v1/user`, which returns the identity behind the token.
 * Decoding the JWT locally is deliberately not done: an unverified decode would
 * accept a token this deployment never minted.
 */
export function createSupabaseSessionVerifier(config: SupabaseAuthConfig): SessionVerifier {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 5000;
  const base = config.url.replace(/\/$/, "");

  return {
    async verify(accessToken: string): Promise<SupabaseSession | null> {
      if (!accessToken) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${base}/auth/v1/user`, {
          method: "GET",
          headers: {
            apikey: config.anonKey,
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
          },
          signal: controller.signal,
        });
        if (!response.ok) return null;

        const text = await response.text();
        if (!text) return null;
        let user: SupabaseUser;
        try {
          user = JSON.parse(text) as SupabaseUser;
        } catch {
          return null;
        }

        const id = user.id;
        if (typeof id !== "string" || id === "") return null;
        const email = typeof user.email === "string" && user.email !== "" ? user.email : null;

        return { userId: id, email, displayName: displayNameOf(user), accessToken };
      } catch {
        // Fail closed: an unreachable identity provider is not an identity.
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Read Supabase auth configuration from the environment, or `null`.
 *
 * `null` means "not configured", which the caller surfaces as an honest
 * not-configured state rather than starting an API that authenticates nobody.
 */
export function supabaseAuthConfig(
  env: Record<string, string | undefined> = process.env,
): SupabaseAuthConfig | null {
  const url = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
