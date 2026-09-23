/**
 * Security edge adapter.
 *
 * The edge is a data plane of Envoy (routing, TLS, connection control) with
 * Coraza and the OWASP Core Rule Set (WAF inspection). Cloud Wai owns the
 * policy vocabulary; this module is the only place that policy becomes engine
 * syntax — Coraza directives and an Envoy route fragment. Callers never write
 * either (ADR-0001).
 *
 * Three rules shape the design:
 *
 *   1. Deny by default. A published route names a *private* origin and the
 *      generated Envoy config carries no direct-to-origin listener, so the origin
 *      is unreachable except through the edge.
 *   2. Policy never rolls backwards. Every distribution carries a monotonic
 *      version and the engine rejects an older one.
 *   3. Customer input never becomes a directive. A path pattern, host or header
 *      name is validated against a strict grammar and rejected if it does not
 *      match; nothing is passed through by concatenation.
 */
import {
  err,
  ok,
  type AdapterResult,
  type OperationRef,
  type ProviderRef,
} from "@cloud-wai/contracts";
import type { EnforcementAction, RiskLevel } from "@cloud-wai/security";
import type { AdapterContext, SecurityEdgeAdapter } from "./index.js";
import { request, type HttpClientOptions } from "./http.js";

export const CORAZA_SEVERITY: Readonly<Record<RiskLevel, string>> = {
  low: "notice",
  medium: "warning",
  high: "error",
  critical: "critical",
};

/** Coraza's disruptive action for each Cloud Wai enforcement action. */
export const CORAZA_ACTION: Readonly<Record<EnforcementAction, string>> = {
  allow: "pass",
  log: "pass",
  challenge: "deny",
  block: "deny",
  quarantine: "deny",
};

/** A route the edge should publish, with a private origin. */
export interface EdgeRoute {
  readonly host: string;
  /** Must be a private address; the edge never exposes a public origin. */
  readonly origin: string;
  readonly pathPrefix: string;
  readonly organizationId: AdapterContext["organizationId"];
}

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PATH_PATTERN = /^\/[A-Za-z0-9\-._~\/]{0,200}$/;
const PRIVATE_HOST =
  /^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[?f[cd][0-9a-f]{2}:)/;

export interface CompileInput {
  readonly route: EdgeRoute;
  readonly policy?: {
    readonly riskLevel: RiskLevel;
    readonly action: EnforcementAction;
    readonly version: number;
  };
}

export interface CompiledEdge {
  /** Coraza / SecLang directives for the route. */
  readonly corazaDirectives: readonly string[];
  /** An Envoy route fragment: cluster, host match, and the WAF filter hook. */
  readonly envoyConfig: {
    readonly host: string;
    readonly pathPrefix: string;
    readonly cluster: string;
    readonly privateOrigin: string;
    readonly wafEnabled: boolean;
  };
  readonly version: number;
}

/**
 * Validate the pieces of a route that become engine syntax.
 *
 * This is the boundary that keeps customer input out of a directive: anything
 * that does not match the grammar is refused, not escaped and forwarded.
 */
export function validateEdgeRoute(route: EdgeRoute): { ok: true } | { ok: false; reason: string } {
  if (!HOST_PATTERN.test(route.host)) return { ok: false, reason: "Host is not a valid DNS name." };
  if (!PATH_PATTERN.test(route.pathPrefix))
    return { ok: false, reason: "Path prefix is not valid." };
  if (!PRIVATE_HOST.test(route.origin)) {
    return {
      ok: false,
      reason: "Origin must be a private address; a public origin would be reachable directly.",
    };
  }
  return { ok: true };
}

/**
 * Compile a Cloud Wai policy into engine configuration.
 *
 * Pure and deterministic: the same input yields the same directives, which is
 * what makes the generated config reviewable and the version comparable.
 */
export function compileEdge(input: CompileInput): CompiledEdge {
  const { route, policy } = input;
  const cluster = `origin-${route.host.replace(/\./g, "-")}`;

  const directives = [
    `SecRuleEngine On`,
    `SecRule REQUEST_URI "@beginsWith ${route.pathPrefix}" "id:1,phase:1,pass,nolog,ctl:ruleEngine=On"`,
  ];

  if (policy) {
    const severity = CORAZA_SEVERITY[policy.riskLevel];
    const action = CORAZA_ACTION[policy.action];
    directives.push(
      `SecAction "id:2,phase:1,pass,nolog,setvar:tx.anomaly_score_threshold=${policy.riskLevel === "critical" ? 1 : policy.riskLevel === "high" ? 3 : 5}"`,
      `SecRule TX:ANOMALY_SCORE "@ge %{tx.anomaly_score_threshold}" "id:3,phase:2,severity:${severity},${action},status:403,log"`,
    );
  }

  return {
    corazaDirectives: directives,
    envoyConfig: {
      host: route.host,
      pathPrefix: route.pathPrefix,
      cluster,
      privateOrigin: route.origin,
      wafEnabled: policy !== undefined,
    },
    version: policy?.version ?? 1,
  };
}

export interface SecurityEdgeOptions extends HttpClientOptions {
  readonly credentials: (
    organizationId: AdapterContext["organizationId"],
  ) => { readonly adminUrl: string; readonly token: string } | null;
  /**
   * Look up the details a reference stands for.
   *
   * The adapter interface names a route or policy by `ProviderRef`, but the
   * route's host/origin and the policy's level live in the control plane. They
   * are resolved here rather than smuggled through an untyped cast, and a null
   * result is an honest failure rather than a guess.
   */
  readonly resolveRoute: (ref: ProviderRef) => EdgeRoute | null;
  readonly resolvePolicy: (ref: ProviderRef) => CompileInput | null;
}

export function createEnvoySecurityEdge(options: SecurityEdgeOptions): SecurityEdgeAdapter {
  const doFetch = options.fetchImpl ?? fetch;

  const credentialsFor = <T>(
    ctx: AdapterContext,
  ):
    | { ok: true; creds: { adminUrl: string; token: string } }
    | { ok: false; result: AdapterResult<T> } => {
    const creds = options.credentials(ctx.organizationId);
    if (!creds || !creds.adminUrl.trim() || !creds.token.trim()) {
      return {
        ok: false,
        result: err(
          "not_configured",
          `The security edge is not configured for organization ${ctx.organizationId}. Provision edge credentials for this organization.`,
        ),
      };
    }
    return { ok: true, creds };
  };

  const call = <T>(
    ctx: AdapterContext,
    creds: { adminUrl: string; token: string },
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) =>
    request<T>(
      { fetchImpl: doFetch, classify: options.classify },
      {
        method,
        url: `${creds.adminUrl.replace(/\/$/, "")}${path}`,
        headers: { authorization: `Bearer ${creds.token}` },
        body,
        timeoutMs: ctx.timeoutMs,
      },
    );

  /** Policy distributions are rejected by the engine if they are stale. */
  const staleVersion = (reason: string): boolean => /version|stale|409/.test(reason);

  return {
    async publishRoute(ctx, input) {
      const route = options.resolveRoute(input.routeRef);
      if (!route) return err("failed", `No route is known for ${input.routeRef.resourceId}.`);

      const validated = validateEdgeRoute(route);
      if (!validated.ok) return err("failed", validated.reason);

      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const compiled = compileEdge({ route });

      const response = await call<{ version?: number }>(
        ctx,
        resolved.creds,
        "POST",
        "/edge/v1/routes",
        compiled,
      );
      if (!response.ok) return response;

      return ok("succeeded", {
        jobId: `edge-route-${route.host}` as OperationRef["jobId"],
        providerRef: {
          organizationId: ctx.organizationId,
          provider: "envoy",
          resourceType: "route",
          resourceId: route.host,
        },
      });
    },

    async removeRoute(ctx, input) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "DELETE",
        `/edge/v1/routes/${encodeURIComponent(input.routeRef.resourceId)}`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async applyPolicy(ctx, input) {
      const policy = options.resolvePolicy(input.ref);
      if (!policy) return err("failed", `No policy is known for ${input.ref.resourceId}.`);

      const resolved = credentialsFor<{ version: number }>(ctx);
      if (!resolved.ok) return resolved.result;

      const compiled = compileEdge(policy);

      const response = await call<{ version?: number }>(
        ctx,
        resolved.creds,
        "POST",
        "/edge/v1/policies",
        compiled,
      );
      if (!response.ok) {
        if (staleVersion(response.reason)) {
          return err("failed", "The edge is holding a newer policy version.");
        }
        return response;
      }

      return ok("succeeded", { version: response.value.value?.version ?? compiled.version });
    },

    async quarantine(ctx, input) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<unknown>(ctx, resolved.creds, "POST", "/edge/v1/quarantine", {
        ref: input.ref,
      });
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async inspectHealth(ctx, input) {
      const resolved = credentialsFor<{ healthy: boolean }>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<{ healthy?: boolean; status?: string }>(
        ctx,
        resolved.creds,
        "GET",
        `/edge/v1/health/${encodeURIComponent(input.ref.resourceId)}`,
      );
      if (!response.ok) return response;

      const body = response.value.value ?? {};
      // Only an explicit healthy flag counts. An absent field is not health.
      return ok("succeeded", { healthy: body.healthy === true });
    },
  };
}
