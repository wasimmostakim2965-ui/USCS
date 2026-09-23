/**
 * Deployment wiring for the API server.
 *
 * This is the one place that reads the environment and decides whether the
 * control plane is real. It never falls back to a fake: if Supabase auth or the
 * control-plane database is not configured, `createDeployment` returns `null`
 * and the entry point refuses to start, because an API that authenticates
 * nobody and stores nothing would look healthy while doing nothing.
 *
 * `CLOUD_WAI_USE_FAKE_ENGINES` affects only *engines*. It selects in-memory
 * adapters for local development, and it never fabricates control-plane data.
 */
import type { ControlPlaneStore } from "@cloud-wai/database";
import {
  controlPlaneConfig,
  createPostgrestClient,
  createSupabaseControlPlaneStore,
} from "@cloud-wai/database";
import {
  createSupabaseSessionVerifier,
  supabaseAuthConfig,
  type SessionVerifier,
} from "@cloud-wai/auth";
import { buildEngines, engineConfigFromEnv, type Engines } from "@cloud-wai/adapters";
import { randomUUID } from "node:crypto";
import { buildProcedures } from "./procedures/index.js";
import { buildRouter } from "./router.js";
import type { HttpServer } from "./server.js";

export interface Deployment {
  readonly router: ReturnType<typeof buildRouter>;
  readonly engines: Engines;
}

export interface ApiDeploymentDeps {
  readonly store: ControlPlaneStore;
  readonly verifier: SessionVerifier;
  readonly engines: Engines;
  readonly newId: () => string;
}

/** Build a router over a real store and verifier. */
export function createDeployment(deps: ApiDeploymentDeps): Deployment {
  const procedures = buildProcedures(deps.store, {
    engines: deps.engines,
    newId: deps.newId,
  });
  const router = buildRouter(
    { verifier: deps.verifier, memberships: deps.store },
    procedures,
  );
  return { router, engines: deps.engines };
}

export interface StartupOptions {
  readonly env?: Record<string, string | undefined>;
  readonly newId?: () => string;
  readonly port?: number;
  readonly host?: string;
  readonly allowedOrigins?: readonly string[];
}

export interface StartupResult {
  readonly server: HttpServer;
  readonly engines: Engines;
}

/**
 * Read configuration and start the API, or explain why it cannot start.
 *
 * The returned `reason` is for an operator reading a log, never for an HTTP
 * response body.
 */
export async function start(
  options: StartupOptions = {},
): Promise<StartupResult | { readonly reason: string }> {
  const env = options.env ?? process.env;

  const auth = supabaseAuthConfig(env);
  if (!auth) {
    return { reason: "Set SUPABASE_URL and SUPABASE_ANON_KEY to verify sessions." };
  }

  const database = controlPlaneConfig(env);
  if (!database) {
    return {
      reason: "Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY for the control-plane database.",
    };
  }

  const newId = options.newId ?? (() => randomUUID());
  const client = createPostgrestClient({
    url: database.url,
    serviceRoleKey: database.serviceRoleKey,
  });
  const store = createSupabaseControlPlaneStore({ client, newId });
  const verifier = createSupabaseSessionVerifier(auth);
  const engines = buildEngines(engineConfigFromEnv(env));

  const deployment = createDeployment({ store, verifier, engines, newId });

  const { listen } = await import("./server.js");
  const server = await listen(
    {
      route: (request) => deployment.router.route(request),
      ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    },
    options.port ?? Number(env.PORT ?? 8787),
    options.host ?? env.HOST ?? "127.0.0.1",
  );

  return { server, engines };
}
