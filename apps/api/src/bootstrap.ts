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
  buildDeploymentEngines,
  controlPlaneConfig,
  createPostgrestClient,
  createSupabaseControlPlaneStore,
  SqlJobQueue,
} from "@cloud-wai/database";
import {
  createSupabaseSessionVerifier,
  secretCipherFromEnv,
  supabaseAuthConfig,
  type SecretCipher,
  type SessionVerifier,
} from "@cloud-wai/auth";
import type { Engines, JobQueue } from "@cloud-wai/adapters";
import { createEngineConsoleLinker } from "@cloud-wai/adapters";
import { randomUUID } from "node:crypto";
import { buildProcedures, type ConsoleLinkResolver } from "./procedures/index.js";
import { buildRouter } from "./router.js";
import type { GitHookHandler, HttpServer } from "./server.js";
import { receiveGitDelivery } from "./git-hook.js";

export interface Deployment {
  readonly router: ReturnType<typeof buildRouter>;
  readonly engines: Engines;
}

export interface ApiDeploymentDeps {
  readonly store: ControlPlaneStore;
  readonly verifier: SessionVerifier;
  readonly engines: Engines;
  readonly newId: () => string;
  /** When wired, deploy/rollback become durable jobs. Omitted in tests. */
  readonly queue?: JobQueue;
  /** The cipher for webhook secrets. Null means git linking is not configured. */
  readonly secretCipher?: SecretCipher | null;
  /**
   * Resolves a resource's engine-console link. Omitted means no links: the
   * Database section says a console is not configured rather than guessing a URL.
   */
  readonly consoleLink?: ConsoleLinkResolver | undefined;
}

/** Build a router over a real store and verifier. */
export function createDeployment(deps: ApiDeploymentDeps): Deployment {
  const procedures = buildProcedures(deps.store, {
    engines: deps.engines,
    newId: deps.newId,
    ...(deps.queue ? { queue: deps.queue } : {}),
    ...(deps.secretCipher ? { secretCipher: deps.secretCipher } : {}),
    ...(deps.consoleLink ? { consoleLink: deps.consoleLink } : {}),
  });
  const router = buildRouter({ verifier: deps.verifier, memberships: deps.store }, procedures);
  return { router, engines: deps.engines };
}

/**
 * The git webhook handler, or undefined when there is nothing to receive with.
 *
 * A receiver needs a queue (a delivery becomes a durable job, never inline
 * engine work on the provider's request) and the secret cipher. Without either,
 * the route is not mounted — which the server turns into a 404, the honest state
 * of a deployment with no git integration.
 */
function buildGitHook(
  store: ControlPlaneStore,
  queue: JobQueue,
  cipher: SecretCipher | null,
): GitHookHandler | undefined {
  if (!cipher) return undefined;
  return {
    handle: (request) => receiveGitDelivery({ store, queue, cipher }, request),
  };
}

export interface StartupOptions {
  readonly env?: Record<string, string | undefined>;
  readonly newId?: () => string;
  readonly port?: number;
  readonly host?: string;
  readonly allowedOrigins?: readonly string[];
}

/**
 * The origins allowed to call this API, read from the deployment's environment.
 *
 * An allow-list, never `*`: a control-plane response is per-user, so a wildcard
 * would let any site read it with a stolen token. Empty (or unset) keeps CORS
 * off, which is the correct setting for a same-origin deployment where the
 * dashboard is served by the API's own host.
 */
export function allowedOriginsFromEnv(
  env: Record<string, string | undefined>,
): readonly string[] | undefined {
  const raw = env.CLOUD_WAI_ALLOWED_ORIGINS;
  if (!raw) return undefined;
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : undefined;
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
      reason:
        "Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY for the control-plane database.",
    };
  }

  const newId = options.newId ?? (() => randomUUID());
  const client = createPostgrestClient({
    url: database.url,
    serviceRoleKey: database.serviceRoleKey,
  });
  const store = createSupabaseControlPlaneStore({ client, newId });
  const verifier = createSupabaseSessionVerifier(auth);
  // A reachable security edge is built here when the environment configures one;
  // otherwise the honest `not_configured` edge is built. The same helper is used
  // by the worker, so the two processes cannot disagree about the edge.
  const engines = buildDeploymentEngines(env, store);

  // The durable queue is the production writer: deploy and rollback become jobs
  // the worker executes. Its claim/reap functions are service-role only, so this
  // client — which holds the service-role key and never reaches a browser — is
  // the only thing that can drain it.
  const queue = new SqlJobQueue(client);

  // The webhook secret cipher. Unset means a repository cannot be linked (the
  // API answers `engine_unavailable`); it never downgrades to a plaintext
  // secret. The receiver uses the same cipher to recompute the delivery HMAC.
  const secretCipher = secretCipherFromEnv(env);

  // The engine console's deep link. Absent configuration means `data.list`
  // carries null links and the Database section says so; the URL is built by the
  // adapter layer from the same placement the engine call uses.
  const consoleLink = createEngineConsoleLinker(env);

  const deployment = createDeployment({
    store,
    verifier,
    engines,
    newId,
    queue,
    secretCipher,
    ...(consoleLink ? { consoleLink } : {}),
  });

  const { listen } = await import("./server.js");
  const allowedOrigins = options.allowedOrigins ?? allowedOriginsFromEnv(env);
  const gitHook = buildGitHook(store, queue, secretCipher);
  const server = await listen(
    {
      route: (request) => deployment.router.route(request),
      ...(gitHook ? { gitHook } : {}),
      ...(allowedOrigins ? { allowedOrigins } : {}),
    },
    options.port ?? Number(env.PORT ?? 8787),
    options.host ?? env.HOST ?? "127.0.0.1",
  );

  return { server, engines };
}
