/**
 * Minimal RPC router for the control plane.
 *
 * This is not a web framework: it is the single place where a request becomes a
 * context, a procedure is dispatched, and an error becomes a wire response. The
 * HTTP adapter (deployment phase) calls `route()` and writes the result.
 *
 * Invariants:
 *   * `total` is what the API returns. If a dependency is not configured, the
 *     router returns an empty, explicitly `not_configured` payload rather than a
 *     failed request that a caller might read as "no data".
 *   * Every error is normalized. An unexpected exception becomes a generic
 *     500-shaped response, and the message is never echoed to the caller.
 */
import { ApiError, isApiError } from "./errors.js";
import { buildContext, type ContextDeps, type RequestContext } from "./context.js";
import { createLogger, type Logger } from "@cloud-wai/observability";

export interface RpcRequest {
  readonly procedure: string;
  readonly accessToken?: string | null;
  readonly input?: unknown;
}

export interface RpcResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  /** True when a required engine was unconfigured, so the caller can show it. */
  readonly notConfigured?: boolean;
}

export interface RouterDeps extends ContextDeps {
  readonly logger?: Logger;
}

type Handler = (ctx: RequestContext, deps: unknown, input: unknown) => Promise<unknown>;

export interface Procedure {
  readonly name: string;
  readonly handler: Handler;
}

const STATUS_BY_CODE: Record<ApiError["code"], number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  engine_unavailable: 503,
};

/** Build a router over a set of procedures and their dependencies. */
export function buildRouter(deps: RouterDeps, procedures: readonly Procedure[]) {
  const logger = deps.logger ?? createLogger({ service: "api" });
  const byName = new Map(procedures.map((p) => [p.name, p]));

  return {
    async route(request: RpcRequest): Promise<RpcResponse> {
      const procedure = byName.get(request.procedure);
      if (!procedure) {
        return {
          ok: false,
          status: 404,
          error: { code: "not_found", message: "Unknown procedure." },
        };
      }

      try {
        const ctx = await buildContext(deps, {
          accessToken: request.accessToken,
          body: request.input,
        });
        const data = await procedure.handler(ctx, deps, request.input);
        return { ok: true, status: 200, data };
      } catch (error) {
        if (isApiError(error)) {
          logger.warn("procedure rejected", {
            procedure: request.procedure,
            code: error.code,
          });
          return {
            ok: false,
            status: STATUS_BY_CODE[error.code],
            error: { code: error.code, message: error.message },
          };
        }
        // Unexpected: log with detail, return without it.
        logger.error("procedure failed", {
          procedure: request.procedure,
          detail: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          status: 500,
          error: { code: "internal", message: "Internal error." },
        };
      }
    },

    procedures(): readonly string[] {
      return [...byName.keys()].sort();
    },
  };
}
