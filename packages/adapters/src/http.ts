/**
 * A minimal, dependency-free JSON HTTP client for engine adapters.
 *
 * Every adapter goes through this rather than calling `fetch` directly, so that
 * three things happen in one place: the deadline is enforced, the engine's error
 * body is never echoed to a browser, and a non-2xx response becomes a typed
 * result instead of a thrown error.
 */
import { err, ok, type AdapterResult } from "@cloud-wai/contracts";

export interface EngineRequest {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface EngineResponse<T> {
  readonly statusCode: number;
  readonly value: T;
}

export interface HttpClientOptions {
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Maps an engine status code to a Cloud Wai status. */
  readonly classify?: ((statusCode: number) => "ok" | "degraded" | "failed") | undefined;
}

function defaultClassify(statusCode: number): "ok" | "degraded" | "failed" {
  if (statusCode >= 200 && statusCode < 300) return "ok";
  // 5xx and 429 are the engine being unwell, not a bad request.
  if (statusCode >= 500 || statusCode === 429) return "degraded";
  return "failed";
}

/**
 * Perform a JSON request against an engine.
 *
 * The returned `reason` carries the status code and, when the engine sent a
 * short message, that message — useful in logs, and safe because a caller never
 * forwards an adapter `reason` to an end user.
 */
export async function request<T>(
  options: HttpClientOptions,
  req: EngineRequest,
): Promise<AdapterResult<EngineResponse<T>>> {
  const doFetch = options.fetchImpl ?? fetch;
  const classify = options.classify ?? defaultClassify;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const onAbort = () => controller.abort();
  req.signal?.addEventListener("abort", onAbort);

  try {
    const init: RequestInit = {
      method: req.method,
      headers: {
        accept: "application/json",
        ...(req.body === undefined ? {} : { "content-type": "application/json" }),
        ...req.headers,
      },
      signal: controller.signal,
    };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    const response = await doFetch(req.url, init);

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON body (an HTML error page, an empty 204) is not fatal; the
        // status code still tells us what happened.
        parsed = undefined;
      }
    }

    const classification = classify(response.status);
    if (classification === "ok") {
      return ok("succeeded", { statusCode: response.status, value: parsed as T });
    }

    const detail = extractMessage(parsed);
    return err(
      classification === "degraded" ? "degraded" : "failed",
      `${req.method} ${redactUrl(req.url)} returned ${response.status}${detail ? `: ${detail}` : "."}`,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return err(
        "failed",
        `${req.method} ${redactUrl(req.url)} timed out after ${req.timeoutMs}ms.`,
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    // Connection-level failure: the engine is unreachable, which is `degraded`
    // rather than `failed` — it may recover without our correcting anything.
    return err("degraded", `${req.method} ${redactUrl(req.url)} unreachable: ${reason}`);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

/** Keep query strings out of log lines; they can carry tokens. */
function redactUrl(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : `${url.slice(0, query)}?[redacted]`;
}

function extractMessage(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of ["message", "error", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0 && value.length < 300) return value;
    }
  }
  return null;
}

/** Read a config value, treating an empty string as absent. */
export function requiredConfig(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): { ok: true; values: Record<string, string> } | { ok: false; missing: readonly string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of keys) {
    const value = env[key];
    if (value === undefined || value.trim() === "") missing.push(key);
    else values[key] = value;
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, values };
}
