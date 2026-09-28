/**
 * Server-side demo sign-in for the pre-launch no-login bypass.
 *
 * The earlier bypass compiled `DEMO_EMAIL`/`DEMO_PASSWORD` into the browser
 * bundle, which is served publicly: anyone reading the dashboard's JavaScript
 * held the demo account's credentials, and the demo account was an owner of live
 * organizations. That defeats the isolation model, which assumes the browser
 * only ever carries a user's own token.
 *
 * This module moves the credential to the server. The browser asks for a demo
 * session, the server performs the password grant with credentials it holds in
 * its own environment (never shipped to a browser), and returns the resulting
 * Supabase tokens. The bypass can then be rate-limited and switched off without
 * a rebuild.
 *
 * It is still a deliberate bypass, not a production identity model. It is off
 * unless `DEMO_AUTOLOGIN=1` and both `DEMO_EMAIL` and `DEMO_PASSWORD` are set,
 * and it answers `not_configured` otherwise rather than inventing a session.
 */
import type { RpcResponse } from "./router.js";

export interface DemoSessionConfig {
  readonly url: string;
  readonly anonKey: string;
  readonly email: string;
  readonly password: string;
  /** Maximum requests a single client may make per `windowMs`. */
  readonly maxPerWindow: number;
  readonly windowMs: number;
}

/**
 * Read the demo-session configuration from the deployment's environment.
 *
 * Returns null (the bypass is off) unless it is explicitly enabled and fully
 * configured, so an operator cannot turn it on by accident.
 */
export function demoSessionFromEnv(
  env: Record<string, string | undefined>,
): DemoSessionConfig | null {
  if (env["DEMO_AUTOLOGIN"] !== "1") return null;
  const url = env["SUPABASE_URL"];
  const anonKey = env["SUPABASE_ANON_KEY"];
  const email = env["DEMO_EMAIL"];
  const password = env["DEMO_PASSWORD"];
  if (!url || !anonKey || !email || !password) return null;
  return {
    url,
    anonKey,
    email,
    password,
    maxPerWindow: Number(env["DEMO_MAX_PER_WINDOW"] ?? 30),
    windowMs: Number(env["DEMO_RATE_WINDOW_MS"] ?? 60_000),
  };
}

export interface DemoSessionHandler {
  /** Handle a `demo.session` request. `clientKey` scopes the rate limit. */
  handle(clientKey: string): Promise<RpcResponse>;
}

const notConfigured: RpcResponse = {
  ok: false,
  status: 503,
  error: {
    code: "not_configured",
    message: "The demo sign-in is not enabled for this deployment.",
  },
};

/**
 * Build the handler. Rate limiting is per-process and in-memory, which is the
 * right scope for a single API process behind the edge; it is a courtesy brake,
 * not a distributed quota.
 */
export function buildDemoSessionHandler(config: DemoSessionConfig): DemoSessionHandler {
  const hits = new Map<string, number[]>();

  const allowed = (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((at) => now - at < config.windowMs);
    if (recent.length >= config.maxPerWindow) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };

  return {
    async handle(clientKey: string): Promise<RpcResponse> {
      if (!allowed(clientKey)) {
        return {
          ok: false,
          status: 429,
          error: { code: "rate_limited", message: "Too many demo sign-in attempts." },
        };
      }

      let response: Response;
      try {
        response = await fetch(
          `${config.url.replace(/\/$/, "")}/auth/v1/token?grant_type=password`,
          {
            method: "POST",
            headers: { apikey: config.anonKey, "content-type": "application/json" },
            body: JSON.stringify({ email: config.email, password: config.password }),
          },
        );
      } catch {
        return {
          ok: false,
          status: 502,
          error: { code: "unreachable", message: "The identity service is unreachable." },
        };
      }

      if (!response.ok) {
        // The upstream body may name the account; it is never forwarded.
        return {
          ok: false,
          status: 502,
          error: { code: "unreachable", message: "The identity service refused the demo sign-in." },
        };
      }

      const body = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_at?: number;
        user?: { email?: string };
      };
      if (!body.access_token || !body.refresh_token) {
        return {
          ok: false,
          status: 502,
          error: { code: "unreachable", message: "The identity service returned no session." },
        };
      }

      return {
        ok: true,
        status: 200,
        data: {
          accessToken: body.access_token,
          refreshToken: body.refresh_token,
          ...(typeof body.expires_at === "number" ? { expiresAt: body.expires_at } : {}),
          ...(body.user?.email ? { email: body.user.email } : {}),
        },
      };
    },
  };
}

export { notConfigured as demoSessionNotConfigured };
