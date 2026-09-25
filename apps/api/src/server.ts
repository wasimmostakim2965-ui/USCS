/**
 * The HTTP adapter.
 *
 * `router.ts` decides what a request means; this file is only responsible for
 * turning HTTP into an `RpcRequest` and an `RpcResponse` back into HTTP. The
 * dashboard has exactly one endpoint to call, `POST /rpc`, and the browser has
 * no other port to reach: there is no engine route, no admin route and no
 * database route mounted here.
 *
 * Deliberate choices:
 *   * The body is size-capped before it is parsed, so a large body cannot be
 *     used to exhaust memory.
 *   * A bearer token is read from `Authorization` only. It is never read from a
 *     query string, where it would land in an access log.
 *   * CORS is an explicit allow-list. `*` is never correct for an authenticated
 *     API, because it would let any site call it with a user's token.
 *   * Errors are already normalized by the router; nothing here adds detail.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "@cloud-wai/observability";
import { createLogger } from "@cloud-wai/observability";
import type { RpcRequest, RpcResponse } from "./router.js";

export interface ServerDeps {
  /** The router's `route` function. */
  readonly route: (request: RpcRequest) => Promise<RpcResponse>;
  /**
   * Handle a git webhook delivery at `POST /hooks/git/{organizationId}/{linkId}`.
   *
   * Absent (the default) means the route 404s, which is the honest state of a
   * deployment with no git integration wired. When present, it receives the raw
   * body plus the delivery headers, and its own status/body are what the
   * provider sees — this file never interprets a delivery.
   */
  readonly gitHook?: GitHookHandler;
  /**
   * Origins allowed to call this API. An empty list disables CORS entirely,
   * which is the correct setting for a same-origin deployment.
   */
  readonly allowedOrigins?: readonly string[];
  readonly logger?: Logger;
  /** Maximum request body size in bytes. */
  readonly maxBodyBytes?: number;
  /**
   * How long `close()` waits for in-flight requests before dropping the
   * remaining sockets, in milliseconds. See `close()` for why this exists.
   */
  readonly shutdownGraceMs?: number;
}

/** A webhook delivery, as the API server hands it to the git-hook module. */
export interface GitHookRequest {
  readonly organizationId: string;
  readonly linkId: string;
  readonly event: string | null;
  readonly signature: string | null;
  /** A shared-token header (GitLab's `X-Gitlab-Token`), when the provider sends one. */
  readonly token: string | null;
  readonly body: string;
}

export interface GitHookHandler {
  handle(request: GitHookRequest): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface HttpServer {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY = 256 * 1024;

/** The one non-RPC route: a git provider's webhook delivery. */
const GIT_HOOK_PREFIX = "/hooks/git/";

/**
 * A git webhook delivery.
 *
 * The path is `/hooks/git/{organizationId}/{linkId}`. The organization is part
 * of the path so the receiver's link lookup stays tenant-scoped; a UUID-shaped
 * segment that is not one is refused before any work is done.
 *
 * The delivery is not an authenticated user, so the only thing checked here is
 * the *shape* of the path. The signature over the body is what authenticates it,
 * and that is verified inside the hook handler — this function never sees a
 * secret.
 */
async function handleGitHook(
  req: IncomingMessage,
  res: ServerResponse,
  hook: GitHookHandler,
  maxBodyBytes: number,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0]!;
  const rest = path.slice(GIT_HOOK_PREFIX.length);
  const [organizationId, linkId] = rest.split("/");
  if (!organizationId || !linkId) {
    json(res, 404, { ok: false, status: 404, error: { code: "not_found", message: "Unknown endpoint." } });
    return;
  }

  const raw = await readBody(req, maxBodyBytes);
  if (raw === null) {
    json(res, 413, {
      ok: false,
      status: 413,
      error: { code: "invalid_input", message: "Request body too large." },
    });
    return;
  }

  const header = (name: string): string | null => {
    const value = req.headers[name];
    return typeof value === "string" && value !== "" ? value : null;
  };

  const outcome = await hook.handle({
    organizationId,
    linkId,
    // Providers disagree on the event header name; any of them names the same
    // thing, and an absent one is left for the body's own `object_kind`.
    event: header("x-github-event") ?? header("x-gitlab-event") ?? header("x-event-key"),
    signature:
      header("x-hub-signature-256") ??
      header("x-hub-signature") ??
      header("x-gitlab-signature"),
    token: header("x-gitlab-token"),
    body: raw,
  });
  json(res, outcome.status, outcome.body);
}

/** Grace period for in-flight requests during shutdown. */
const DEFAULT_SHUTDOWN_GRACE = 2_000;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // A control-plane response is per-user and must never be cached by a proxy.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

/** Read the body with a hard cap; returns null when the cap is exceeded. */
async function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1]!.trim() : null;
}

export function createHttpServer(deps: ServerDeps): HttpServer {
  const logger = deps.logger ?? createLogger({ service: "api" });
  const allowed = new Set(deps.allowedOrigins ?? []);
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const shutdownGraceMs = deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE;

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (typeof origin === "string" && allowed.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // A liveness probe a load balancer can use. It reveals nothing about data,
    // engines or configuration.
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/healthz/")) {
      json(res, 200, { ok: true, status: 200, data: { service: "api" } });
      return;
    }

    if (req.method !== "POST" || !req.url?.startsWith("/rpc")) {
      if (deps.gitHook && req.method === "POST" && req.url?.startsWith(GIT_HOOK_PREFIX)) {
        await handleGitHook(req, res, deps.gitHook, maxBodyBytes);
        return;
      }
      json(res, 404, {
        ok: false,
        status: 404,
        error: { code: "not_found", message: "Unknown endpoint." },
      });
      return;
    }

    const raw = await readBody(req, maxBodyBytes);
    if (raw === null) {
      json(res, 413, {
        ok: false,
        status: 413,
        error: { code: "invalid_input", message: "Request body too large." },
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      json(res, 400, {
        ok: false,
        status: 400,
        error: { code: "invalid_input", message: "Request body must be JSON." },
      });
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      json(res, 400, {
        ok: false,
        status: 400,
        error: { code: "invalid_input", message: "Request body must be a JSON object." },
      });
      return;
    }

    const body = parsed as { procedure?: unknown; input?: unknown };
    if (typeof body.procedure !== "string" || body.procedure === "") {
      json(res, 400, {
        ok: false,
        status: 400,
        error: { code: "invalid_input", message: "A procedure name is required." },
      });
      return;
    }

    const response = await deps.route({
      procedure: body.procedure,
      accessToken: bearerToken(req),
      input: body.input,
    });
    json(res, response.status, response);
  }

  return {
    server,
    get port(): number {
      const address = server.address() as AddressInfo | null;
      return address?.port ?? 0;
    },
    get url(): string {
      const address = server.address() as AddressInfo | null;
      const port = address?.port ?? 0;
      return `http://127.0.0.1:${port}`;
    },
    async close(): Promise<void> {
      // Closing in two steps, because `server.close()` alone is not a shutdown:
      // it stops accepting new connections and then waits for every open socket
      // to end on its own. A browser holding a keep-alive connection — which is
      // the normal case — would keep the process alive for the whole keep-alive
      // window, and an in-flight request that never ends would keep it alive
      // forever. So: stop accepting, close what is idle, give the in-flight
      // requests a fixed grace period, then drop whatever is left.
      server.closeIdleConnections();
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, shutdownGraceMs);
      });
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
        grace,
      ]);
      if (timer) clearTimeout(timer);
      logger.info("api server stopped", {});
    },
  };
}

/** Start listening. Split from `createHttpServer` so tests can bind port 0. */
export async function listen(
  deps: ServerDeps,
  port = 8787,
  host = "127.0.0.1",
): Promise<HttpServer> {
  const instance = createHttpServer(deps);
  await new Promise<void>((resolve, reject) => {
    instance.server.once("error", reject);
    instance.server.listen(port, host, () => {
      instance.server.removeListener("error", reject);
      resolve();
    });
  });
  return instance;
}
