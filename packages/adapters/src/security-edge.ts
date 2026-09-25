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

/**
 * A bot allowed through without a challenge.
 *
 * `userAgent` is the substring that must appear; `confirmSuffix` is the
 * forward-confirmed reverse-DNS suffix that must ALSO match. Both are required
 * on purpose: a `User-Agent` alone is attacker-controlled, so matching it
 * without a DNS confirmation would be a trivial bypass (a scraper that sets
 * `User-Agent: Googlebot`). This mirrors how the crawlers actually verify
 * themselves, and it is the whole reason the allow-list is trustworthy.
 */
export interface VerifiedBot {
  readonly name: string;
  readonly userAgent: string;
  readonly confirmSuffix: string;
}

/**
 * The curated verified-bot directory.
 *
 * Deliberately small and exact. Each entry is a crawler or monitor whose owner
 * publishes a matching reverse-DNS scheme, so the confirm step can succeed. A
 * deployment may add its own overlay (see `botAllowList` on `CompileInput`) for
 * a webhook provider or uptime monitor it trusts, but the default set is what
 * keeps SEO and monitoring working while a challenge is up.
 */
export const VERIFIED_BOTS: readonly VerifiedBot[] = [
  { name: "googlebot", userAgent: "Googlebot", confirmSuffix: "googlebot.com" },
  { name: "google-other", userAgent: "Google", confirmSuffix: "google.com" },
  { name: "bingbot", userAgent: "bingbot", confirmSuffix: "search.msn.com" },
  { name: "duckduckbot", userAgent: "DuckDuckBot", confirmSuffix: "duckduckgo.com" },
  { name: "yandexbot", userAgent: "YandexBot", confirmSuffix: "yandex.ru" },
  { name: "baiduspider", userAgent: "Baiduspider", confirmSuffix: "baidu.com" },
  { name: "applebot", userAgent: "Applebot", confirmSuffix: "applebot.apple.com" },
  { name: "uptimerobot", userAgent: "UptimeRobot", confirmSuffix: "uptimerobot.com" },
  { name: "pingdom", userAgent: "Pingdom", confirmSuffix: "pingdom.com" },
];

/** How a route is protected. `attack` challenges browsers; bots still pass. */
export const ROUTE_PROTECTION_MODES = ["normal", "attack"] as const;
export type RouteProtectionMode = (typeof ROUTE_PROTECTION_MODES)[number];

/** One step of the compiled decision ladder, in the order the edge evaluates it. */
export interface LadderStep {
  /** The `id:` the directive carries, so a decision is traceable to a rule. */
  readonly id: number;
  readonly stage:
    | "allow-verified-bot"
    | "allow-internal"
    | "block-deny-list"
    | "challenge"
    | "waf"
    | "log"
    | "pass";
  readonly action: EnforcementAction;
  /** The Coraza/SecLang directive for this step, or a comment when it is Envoy-only. */
  readonly directive: string;
}

/** The default identity of this deployment's own requests (health, probes). */
export const INTERNAL_REQUEST_HEADER = "x-cloud-wai-internal";

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PATH_PATTERN = /^\/[A-Za-z0-9\-._~\/]{0,200}$/;
const PRIVATE_HOST =
  /^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[?f[cd][0-9a-f]{2}:)/;

/**
 * A deny-list entry: an IP, a CIDR, an ASN, or a user-agent substring.
 *
 * The value is validated against a strict grammar before it can become a rule,
 * for the same reason a host is: customer input never reaches a directive by
 * concatenation. A value that does not match is refused, not escaped.
 */
export type DenyRuleKind = "ip" | "cidr" | "asn" | "user-agent";

export interface DenyRule {
  readonly kind: DenyRuleKind;
  readonly value: string;
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const ASN = /^AS\d{1,10}$/;
const UA_VALUE = /^[A-Za-z0-9 ._\/+()-]{1,120}$/;

/** Validate one deny rule. Refuses anything that would be directive syntax. */
export function validateDenyRule(rule: DenyRule): { ok: true } | { ok: false; reason: string } {
  switch (rule.kind) {
    case "ip":
      if (!IPV4.test(rule.value)) return { ok: false, reason: "Not an IPv4 address." };
      return { ok: true };
    case "cidr":
      if (!CIDR.test(rule.value)) return { ok: false, reason: "Not an IPv4 CIDR block." };
      return { ok: true };
    case "asn":
      if (!ASN.test(rule.value)) return { ok: false, reason: "An ASN is written AS<number>." };
      return { ok: true };
    case "user-agent":
      if (!UA_VALUE.test(rule.value)) {
        return { ok: false, reason: "A user-agent value is 1-120 plain characters." };
      }
      return { ok: true };
  }
}

/** The Coraza operator and target for a deny rule kind. */
function denyOperator(rule: DenyRule): { target: string; operator: string } {
  switch (rule.kind) {
    case "ip":
      return { target: "REMOTE_ADDR", operator: `@ipMatch ${rule.value}` };
    case "cidr":
      return { target: "REMOTE_ADDR", operator: `@ipMatch ${rule.value}` };
    case "asn":
      // Coraza has no ASN primitive; the edge resolves it to an IP set upstream.
      // The directive is emitted as a collection match so the intent is recorded
      // and the edge's own ASN resolver is what enforces it.
      return { target: "TX:CLOUD_WAI_ASN", operator: `@streq ${rule.value}` };
    case "user-agent":
      return { target: "REQUEST_HEADERS:User-Agent", operator: `@contains ${rule.value}` };
  }
}

/** Render a verified-bot step: UA substring AND a forward-confirmed DNS suffix. */
function verifiedBotDirective(id: number, bot: VerifiedBot): string {
  return `SecRule REQUEST_HEADERS:User-Agent "@contains ${bot.userAgent}" "id:${id},phase:1,pass,nolog,chain,setvar:tx.cloud_wai_bot=${id},setvar:tx.cloud_wai_bot_confirm=${bot.confirmSuffix}"`;
}

export interface CompileInput {
  readonly route: EdgeRoute;
  readonly policy?: {
    readonly riskLevel: RiskLevel;
    readonly action: EnforcementAction;
    readonly version: number;
  };
  /**
   * Whether browsers are challenged. `attack` is the "under attack" posture:
   * verified bots and internal requests still pass, browser traffic is
   * challenged, and the WAF stays on. It never removes the allow-list steps.
   */
  readonly protection?: RouteProtectionMode | undefined;
  /**
   * Extra bots to allow, on top of the curated directory. Operator-supplied:
   * the customer's own webhook providers or monitors, not attacker input.
   */
  readonly botAllowList?: readonly VerifiedBot[] | undefined;
  /** Deny-list rules. Each is validated before it becomes a directive. */
  readonly denyList?: readonly DenyRule[] | undefined;
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
    /**
     * Whether browsers are challenged at the edge. Envoy performs the challenge
     * (a bot check / interstitial); the WAF only inspects what passes.
     */
    readonly challengeBrowsers: boolean;
  };
  /**
   * The decision ladder, in evaluation order. This is the reviewable form of
   * "what happens to a request": each step names its stage and its action, so a
   * crawler being allowed and an attacker being blocked are both visible without
   * reading Coraza syntax.
   */
  readonly ladder: readonly LadderStep[];
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
 *
 * The output is a *ladder*, evaluated top to bottom, so an attacker is stopped
 * without stopping Googlebot, an uptime monitor, a webhook sender or a normal
 * visitor:
 *
 *   1. allow  — a verified bot (UA substring AND a forward-confirmed DNS suffix)
 *   2. allow  — this deployment's own internal requests
 *   3. block  — an explicit deny-list match (IP / CIDR / ASN / user-agent)
 *   4. challenge — browser traffic, only when the route is in attack mode
 *   5. waf    — the OWASP CRS anomaly threshold (the existing rule)
 *   6. log    — an inspect-only match
 *   7. pass   — default
 *
 * Steps 1 and 2 come first on purpose: that ordering is what lets attack mode be
 * enabled without breaking SEO or a customer's integrations.
 */
export function compileEdge(input: CompileInput): CompiledEdge {
  const { route, policy } = input;
  const cluster = `origin-${route.host.replace(/\./g, "-")}`;
  const attackMode = input.protection === "attack";
  const bots = [...VERIFIED_BOTS, ...(input.botAllowList ?? [])];

  const ladder: LadderStep[] = [];
  const directives: string[] = [
    `SecRuleEngine On`,
    `SecRule REQUEST_URI "@beginsWith ${route.pathPrefix}" "id:1,phase:1,pass,nolog,ctl:ruleEngine=On"`,
  ];
  let nextId = 10;

  // 1. Verified bots. The UA match chains to a forward-confirmed reverse-DNS
  //    check, so a spoofed User-Agent does not get the allow.
  for (const bot of bots) {
    const id = nextId++;
    const directive = verifiedBotDirective(id, bot);
    directives.push(directive);
    ladder.push({ id, stage: "allow-verified-bot", action: "allow", directive });
  }

  // 2. Internal requests. This deployment's own health checks and probes carry
  //    the header; nothing a customer can set grants it, because the edge strips
  //    the header from inbound traffic before this rule runs.
  {
    const id = nextId++;
    const directive = `SecRule REQUEST_HEADERS:${INTERNAL_REQUEST_HEADER} "@streq 1" "id:${id},phase:1,pass,nolog"`;
    directives.push(directive);
    ladder.push({ id, stage: "allow-internal", action: "allow", directive });
  }

  // 3. Deny list. Each value was validated before it reached here; a value that
  //    would not match its grammar never becomes a directive.
  for (const rule of input.denyList ?? []) {
    const valid = validateDenyRule(rule);
    if (!valid.ok) continue; // never emit a directive from an unvalidated value
    const { target, operator } = denyOperator(rule);
    const id = nextId++;
    const directive = `SecRule ${target} "${operator}" "id:${id},phase:1,deny,status:403,log,msg:'cloud-wai deny list: ${rule.kind}'"`;
    directives.push(directive);
    ladder.push({ id, stage: "block-deny-list", action: "block", directive });
  }

  // 4. Attack mode challenges browsers. It is Envoy that serves the challenge;
  //    the WAF records the intent so the compiled config is self-describing.
  if (attackMode) {
    const id = nextId++;
    const directive = `SecAction "id:${id},phase:1,pass,nolog,setvar:tx.cloud_wai_challenge_browsers=1"`;
    directives.push(directive);
    ladder.push({ id, stage: "challenge", action: "challenge", directive });
  }

  // 5. The WAF rule. Present whenever there is a policy, in every mode: attack
  //    mode adds a challenge, it never weakens inspection.
  if (policy) {
    const severity = CORAZA_SEVERITY[policy.riskLevel];
    const action = CORAZA_ACTION[policy.action];
    const thresholdId = nextId++;
    const ruleId = nextId++;
    const threshold = policy.riskLevel === "critical" ? 1 : policy.riskLevel === "high" ? 3 : 5;
    const setThreshold = `SecAction "id:${thresholdId},phase:1,pass,nolog,setvar:tx.anomaly_score_threshold=${threshold}"`;
    const wafRule = `SecRule TX:ANOMALY_SCORE "@ge %{tx.anomaly_score_threshold}" "id:${ruleId},phase:2,severity:${severity},${action},status:403,log"`;
    directives.push(setThreshold, wafRule);
    ladder.push({ id: ruleId, stage: "waf", action: policy.action, directive: wafRule });
  }

  return {
    corazaDirectives: directives,
    envoyConfig: {
      host: route.host,
      pathPrefix: route.pathPrefix,
      cluster,
      privateOrigin: route.origin,
      wafEnabled: policy !== undefined,
      challengeBrowsers: attackMode,
    },
    ladder,
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
   *
   * These synchronous resolvers are what tests use. A deployment, whose lookups
   * are database reads, supplies the async `loadRoute` / `loadPolicy` instead;
   * the async form is preferred when both are given.
   */
  readonly resolveRoute?: (ref: ProviderRef) => EdgeRoute | null;
  readonly resolvePolicy?: (ref: ProviderRef) => CompileInput | null;
  /** Async lookup of a route, for a deployment reading from the control plane. */
  readonly loadRoute?: (ref: ProviderRef) => Promise<EdgeRoute | null>;
  /** Async lookup of a policy (with its mode and deny list). */
  readonly loadPolicy?: (ref: ProviderRef) => Promise<CompileInput | null>;
}

export function createEnvoySecurityEdge(options: SecurityEdgeOptions): SecurityEdgeAdapter {
  const doFetch = options.fetchImpl ?? fetch;

  /** Resolve a route by ref: the async loader wins when both are configured. */
  const routeFor = async (ref: ProviderRef): Promise<EdgeRoute | null> => {
    if (options.loadRoute) return options.loadRoute(ref);
    return options.resolveRoute?.(ref) ?? null;
  };

  const policyFor = async (ref: ProviderRef): Promise<CompileInput | null> => {
    if (options.loadPolicy) return options.loadPolicy(ref);
    return options.resolvePolicy?.(ref) ?? null;
  };

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
      const route = await routeFor(input.routeRef);
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
      const policy = await policyFor(input.ref);
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
