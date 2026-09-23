/**
 * PostgREST client for the control-plane database.
 *
 * Small and dependency-free: one `fetch` wrapper, one timeout, one place where
 * a snake_case row becomes a domain object. It talks only to the control-plane
 * Supabase project — customer tenant databases are a separate data plane and
 * are reached through `@cloud-wai/adapters`, never from here.
 */
import type { AdapterResult } from "@cloud-wai/contracts";
import { err, ok } from "@cloud-wai/contracts";

export interface PostgrestConfig {
  /** Supabase project URL. */
  readonly url: string;
  /** Service-role key: the API server holds it, a browser never does. */
  readonly serviceRoleKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface PostgrestRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path under `/rest/v1`, including any query string. */
  readonly path: string;
  readonly body?: unknown;
  /** PostgREST `Prefer` header value, e.g. `return=representation`. */
  readonly prefer?: string;
}

export interface PostgrestResponse<T> {
  readonly status: number;
  readonly rows: T;
}

/** Row plus its PostgREST content-range count when the caller asked for one. */
export interface PostgrestResult<T> {
  readonly rows: T;
  /** Total rows matching the filter, when `Prefer: count=exact` was sent. */
  readonly total: number | null;
}

export interface PostgrestClient {
  request<T>(req: PostgrestRequest): Promise<AdapterResult<PostgrestResponse<T>>>;
  /** As `request`, but parses the content-range total. Used for paginated lists. */
  requestWithCount<T>(req: PostgrestRequest): Promise<AdapterResult<PostgrestResult<T>>>;
}

function parseCount(contentRange: string | null): number | null {
  if (!contentRange) return null;
  const slash = contentRange.lastIndexOf("/");
  if (slash === -1) return null;
  const total = contentRange.slice(slash + 1);
  return total === "*" ? null : Number(total);
}

export function createPostgrestClient(config: PostgrestConfig): PostgrestClient {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 8000;
  const base = `${config.url.replace(/\/$/, "")}/rest/v1`;

  async function send<T>(
    req: PostgrestRequest,
  ): Promise<AdapterResult<{ status: number; body: T; count: number | null }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${base}${req.path}`, {
        method: req.method,
        headers: {
          apikey: config.serviceRoleKey,
          authorization: `Bearer ${config.serviceRoleKey}`,
          accept: "application/json",
          ...(req.body === undefined ? {} : { "content-type": "application/json" }),
          ...(req.prefer ? { prefer: req.prefer } : {}),
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: controller.signal,
      });

      const text = await response.text();
      let body: unknown = undefined;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }

      if (response.status >= 200 && response.status < 300) {
        return ok("succeeded", {
          status: response.status,
          body: body as T,
          count: parseCount(response.headers.get("content-range")),
        });
      }
      // 401/403 from PostgREST means the key was rejected; 5xx/429 means the
      // database is unwell. Both are the deployment's problem, not the
      // caller's, so they are `degraded` rather than a client-shaped failure.
      return err(
        response.status >= 500 || response.status === 429 ? "degraded" : "failed",
        `${req.method} ${req.path.split("?")[0]} returned ${response.status}.`,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return err("degraded", `${req.method} ${req.path.split("?")[0]} timed out.`);
      }
      return err(
        "degraded",
        `${req.method} ${req.path.split("?")[0]} unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async request<T>(req: PostgrestRequest) {
      const result = await send<T>(req);
      if (!result.ok) return result;
      return ok("succeeded", { status: result.value.status, rows: result.value.body });
    },
    async requestWithCount<T>(req: PostgrestRequest) {
      const result = await send<T>({ ...req, prefer: `${req.prefer ?? ""},count=exact` });
      if (!result.ok) return result;
      return ok("succeeded", { rows: result.value.body, total: result.value.count });
    },
  };
}
