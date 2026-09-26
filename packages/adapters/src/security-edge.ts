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

const BOT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Validate a bot entry before it can become a directive.
 *
 * The curated directory is compiled in, but `botAllowList` is operator-supplied
 * and reaches the same string templates as a deny rule's value. The same rule
 * applies: nothing arrives by concatenation. The suffix is checked as a DNS
 * name, which is what the edge will match its confirmation against, so a value
 * that is not a name is refused rather than escaped.
 */
export function validateVerifiedBot(
  bot: VerifiedBot,
): { ok: true } | { ok: false; reason: string } {
  if (!BOT_NAME.test(bot.name)) return { ok: false, reason: "A bot name is 1-40 [a-z0-9-]." };
  if (!UA_VALUE.test(bot.userAgent)) {
    return { ok: false, reason: "A bot user-agent is 1-120 plain characters." };
  }
  if (!HOST_PATTERN.test(bot.confirmSuffix)) {
    return { ok: false, reason: "A confirm suffix must be a DNS name." };
  }
  return { ok: true };
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
    | "allow-trusted-ip"
    | "block-deny-list"
    | "ratelimit"
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

/**
 * A trusted source: an IP or a CIDR that is never challenged or blocked.
 *
 * This is the answer to "attack mode must not lock out my own webhook senders or
 * CI runners". A trusted source is the operator's own input, and the value is
 * validated against the same IP/CIDR grammar a deny rule is — so a value that
 * would be directive syntax is refused, not escaped.
 *
 * It deliberately covers only address literals. A hostname would have to be
 * resolved, and the DNS answer is attacker-influenced, so trusting a name would
 * make the allow-list forgeable. An address cannot be spoofed in the same way
 * for a TCP connection the edge terminates.
 */
export interface TrustedSource {
  readonly kind: "ip" | "cidr";
  readonly value: string;
}

/** Validate one trusted source. Refuses anything that would be directive syntax. */
export function validateTrustedSource(
  source: TrustedSource,
): { ok: true } | { ok: false; reason: string } {
  switch (source.kind) {
    case "ip":
      if (!IPV4.test(source.value)) return { ok: false, reason: "Not an IPv4 address." };
      return { ok: true };
    case "cidr":
      if (!CIDR.test(source.value)) return { ok: false, reason: "Not an IPv4 CIDR block." };
      return { ok: true };
  }
}

/**
 * What a rate limit counts requests against.
 *
 * `ip` limits one source address, `header` limits by a request header's value
 * (an API key or tenant id), and `global` limits the route as a whole. These are
 * the three Vercel's firewall exposes for a custom rule, and they are the three
 * the edge's rate-limit descriptor can key on without new state.
 */
export const RATE_LIMIT_KEYS = ["ip", "header", "global"] as const;
export type RateLimitKey = (typeof RATE_LIMIT_KEYS)[number];

/**
 * A per-route request-rate rule.
 *
 * The answer to the scraper-budget problem: a normal visitor makes a handful of
 * requests a minute, so a limit of, say, 60/min is invisible to them while a
 * scraper walking a catalogue is throttled. It sits *after* the allow steps, so
 * a verified bot or a trusted address is never counted — SEO and a customer's
 * own webhook senders are untouched.
 *
 * `headerName` is required for `key: "header"` and refused for the others, so a
 * rule cannot be half-specified. Both the header name and the numeric bounds are
 * validated here and again at compile time: nothing reaches an engine by
 * concatenation.
 */
export interface RateLimitRule {
  readonly id: string;
  readonly key: RateLimitKey;
  readonly headerName?: string | undefined;
  /** Requests allowed per window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSeconds: number;
}

/** Header names that may key a rate limit. A strict token, never directive syntax. */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,60}$/;

/** Validate one rate-limit rule. Refuses anything that would be directive syntax. */
export function validateRateLimitRule(
  rule: RateLimitRule,
): { ok: true } | { ok: false; reason: string } {
  if (!RATE_LIMIT_KEYS.includes(rule.key)) return { ok: false, reason: "Unknown rate-limit key." };
  if (!Number.isInteger(rule.limit) || rule.limit < 1 || rule.limit > 1_000_000) {
    return { ok: false, reason: "A rate limit is an integer between 1 and 1000000." };
  }
  if (
    !Number.isInteger(rule.windowSeconds) ||
    rule.windowSeconds < 1 ||
    rule.windowSeconds > 86_400
  ) {
    return { ok: false, reason: "A rate-limit window is 1 to 86400 seconds." };
  }
  if (rule.key === "header") {
    if (!rule.headerName || !HEADER_NAME.test(rule.headerName)) {
      return { ok: false, reason: "A header-keyed limit needs a plain header name." };
    }
  } else if (rule.headerName !== undefined) {
    return { ok: false, reason: "Only a header-keyed limit may name a header." };
  }
  return { ok: true };
}

/** The Envoy rate-limit descriptor a compiled rule produces, for the engine. */
export interface CompiledRateLimit {
  readonly descriptor: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The Coraza operator and target for a deny rule kind. */
function denyOperator(rule: DenyRule): { target: string; operator: string } {
  switch (rule.kind) {
    case "ip":
      return { target: "REMOTE_ADDR", operator: `@ipMatch ${rule.value}` };
    case "cidr":
      return { target: "REMOTE_ADDR", operator: `@ipMatch ${rule.value}` };
    case "asn":
      // Coraza has no ASN primitive: it cannot map a source address to the
      // network that announces it. The edge resolves `REMOTE_ADDR` to an ASN
      // upstream and writes it to `TX:CLOUD_WAI_ASN`; this directive consumes
      // that value. The variable name is part of the edge contract in
      // docs/runbooks/deploy-aws.md — an edge that does not populate it leaves
      // every ASN deny inert, with no error to show for it.
      return { target: "TX:CLOUD_WAI_ASN", operator: `@streq ${rule.value}` };
    case "user-agent":
      return { target: "REQUEST_HEADERS:User-Agent", operator: `@contains ${rule.value}` };
  }
}

/**
 * The transaction variable the edge sets to the suffix it forward-confirmed.
 *
 * The edge performs the reverse-DNS lookup and the forward confirmation, and
 * writes the operator's suffix here only when both agree at a DNS label
 * boundary. Coraza cannot do that lookup itself, so the directive consumes the
 * result instead of inventing it. The edge must never populate this from an
 * inbound header: a header is attacker-controlled and would make the check
 * tautological.
 *
 * `@rbl` is deliberately not used. It queries `<ip>.<service>` for a listing,
 * which is not a PTR lookup and performs no forward confirmation, so it cannot
 * express "the reverse name is under this suffix AND resolves back to this
 * address". The edge does that check; this variable carries its answer.
 *
 * Exported because it is part of the edge contract, not an internal detail: an
 * edge that does not populate it grants no bot allow at all.
 */
export const BOT_CONFIRM_VARIABLE = "cloud_wai_bot_confirm";

/**
 * The transaction variable a confirmed bot sets.
 *
 * Written only when the whole bot chain matches, so it means "this is a
 * confirmed crawler" rather than "this User-Agent looks like one".
 */
export const BOT_MARKER_VARIABLE = "cloud_wai_bot";

/**
 * The operator's suffix as a match against the confirmed PTR name.
 *
 * The suffix is a DNS name (`googlebot.com`), and what the edge records is the
 * hostname it forward-confirmed (`crawl-66-249-66-1.googlebot.com`). Those are
 * not equal, so an exact match would never fire and the allow would be dead. The
 * name must instead *end* with the suffix **at a label boundary**: the leading
 * `(^|\.)` is what rejects `evilgooglebot.com`, which a bare `@endsWith` would
 * accept. Only dots are regex metacharacters in a validated DNS name, so they
 * are the only characters that need escaping.
 */
function botConfirmPattern(suffix: string): string {
  return `(^|\\.)${suffix.replace(/\./g, "\\.")}$`;
}

/**
 * Render a verified-bot allow as a real two-rule Coraza chain.
 *
 * `chain` binds a rule to the rule that *immediately follows*, and the chain
 * matches only if every member matches. The starter tests the User-Agent; the
 * member tests the forward-confirmed suffix the edge recorded. Emitting the
 * starter alone — as an earlier version did — made each bot rule swallow the
 * next rule as its member, which is not a valid ruleset and could never allow a
 * crawler. A `User-Agent` on its own is attacker-controlled, so the second
 * condition is what makes the allow trustworthy; without it, a scraper that
 * sets `User-Agent: Googlebot` would pass.
 *
 * The marker is set by the *member*, not the starter. A non-disruptive action
 * such as `setvar` runs on a chain starter as soon as the starter itself
 * matches, whether or not the rest of the chain does, so a marker on the starter
 * would be set for anyone who sends `User-Agent: Googlebot` — the exact
 * attacker-controlled claim the chain exists to reject.
 *
 * The member carries no `id` and no `phase`: Coraza rejects those on a chain
 * member ("can only be specified by chain starter rules").
 */
function verifiedBotDirectives(id: number, bot: VerifiedBot): { starter: string; member: string } {
  return {
    starter: `SecRule REQUEST_HEADERS:User-Agent "@contains ${bot.userAgent}" "id:${id},phase:1,pass,nolog,chain,msg:'cloud-wai verified bot: ${bot.name}'"`,
    member: `SecRule TX:${BOT_CONFIRM_VARIABLE} "@rx ${botConfirmPattern(bot.confirmSuffix)}" "t:none,setvar:tx.${BOT_MARKER_VARIABLE}=${id}"`,
  };
}

/**
 * The Envoy rate-limit descriptor for a rule.
 *
 * Envoy keys a rate limit by a descriptor entry, and the entry's name is what
 * distinguishes "per source address" from "per header value" from "per route".
 * Building it here keeps the descriptor grammar in the adapter, where every other
 * engine-specific string already lives.
 */
function rateLimitDescriptor(rule: RateLimitRule): string {
  switch (rule.key) {
    case "ip":
      return "remote_address";
    case "header":
      return `header:${rule.headerName ?? ""}`;
    case "global":
      return "route_global";
  }
}

export interface CompileInput {
  readonly route: EdgeRoute;
  /**
   * Every other host this artifact also applies to.
   *
   * One firewall covers the whole organization, so a policy artifact must name
   * all of the organization's verified hosts. `route` stays the primary (it is
   * what a single-route publish compiles), and `routes` carries the rest; the
   * compiled config emits a route fragment for each. Without this, a second
   * verified domain was neither routed nor inspected — it was simply absent from
   * the artifact, which is the gap this field closes.
   */
  readonly routes?: readonly EdgeRoute[] | undefined;
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
  /**
   * Trusted source addresses that are never challenged or blocked.
   *
   * Operator-supplied, like `botAllowList`: a customer's own webhook senders and
   * CI runners. Emitted *before* the deny list so a trusted address is allowed
   * even in attack mode. It cannot grant a bypass to an attacker the way a
   * `User-Agent` claim can, because it matches the connection's source address,
   * not a header the attacker sends.
   */
  readonly trustedSources?: readonly TrustedSource[] | undefined;
  /**
   * Per-route request-rate rules.
   *
   * Compiled after the allow steps so verified bots, internal requests and
   * trusted addresses are never counted — the scraper problem is addressed
   * without touching SEO or a customer's own webhook senders.
   */
  readonly rateLimits?: readonly RateLimitRule[] | undefined;
}

export interface EnvoyRouteFragment {
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
  /**
   * Source addresses that must never see the interstitial.
   *
   * The Coraza `allow-trusted-ip` marker cannot serve this purpose: it is a
   * transaction variable inside the WAF, set after Envoy has already decided
   * whether to challenge. Envoy is the component that serves the interstitial,
   * so it needs the addresses itself. They are address literals (never a name,
   * which would have to be resolved and could be forged), so Envoy matches them
   * on the connection's remote address exactly as the WAF does — which is what
   * stops attack mode from locking out a customer's own webhook sender or CI
   * runner. Empty when nothing is trusted.
   */
  readonly skipChallengeAddresses: readonly string[];
  /**
   * Whether the edge must skip the challenge for a crawler it has itself
   * confirmed.
   *
   * This is a flag and not a User-Agent list on purpose. Envoy cannot perform
   * the reverse-DNS / forward-confirmation check, and a UA pattern in the
   * fragment would let a scraper that sets `User-Agent: Googlebot` skip the
   * interstitial — the bypass the WAF chain exists to close. The edge already
   * does that confirmation to populate `tx.cloud_wai_bot_confirm`; when this is
   * true it must apply the same answer here, before serving the challenge.
   */
  readonly skipChallengeForVerifiedBots: boolean;
}

export interface CompiledEdge {
  /** Coraza / SecLang directives for the route. */
  readonly corazaDirectives: readonly string[];
  /**
   * The primary route fragment. Kept as the single-route shape a `publishRoute`
   * compiles, so a caller that publishes one hostname reads it directly.
   */
  readonly envoyConfig: EnvoyRouteFragment;
  /**
   * One route fragment per host this artifact applies to.
   *
   * The Coraza directives are host-agnostic (they match `REQUEST_URI`), so one
   * compiled policy inspects every host it is deployed with; the route fragments
   * are what tell the edge which hosts to serve and from which private origin.
   * An organization with three verified domains therefore gets three fragments
   * under one policy — one firewall, all its domains.
   */
  readonly envoyRoutes: readonly EnvoyRouteFragment[];
  /**
   * The decision ladder, in evaluation order. This is the reviewable form of
   * "what happens to a request": each step names its stage and its action, so a
   * crawler being allowed and an attacker being blocked are both visible without
   * reading Coraza syntax.
   */
  readonly ladder: readonly LadderStep[];
  /**
   * The rate-limit descriptors the edge enforces, per compiled rule. Envoy's
   * rate-limit filter is the enforcement point; these describe what to key on
   * and how many requests are allowed.
   */
  readonly rateLimits: readonly CompiledRateLimit[];
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
 *   3. allow  — a trusted source address (a webhook sender / CI runner)
 *   4. block  — an explicit deny-list match (IP / CIDR / ASN / user-agent)
 *   5. ratelimit — a per-route request burst (the scraper-budget problem)
 *   6. challenge — browser traffic, only when the route is in attack mode
 *   7. waf    — the OWASP CRS anomaly threshold (the existing rule)
 *   8. log    — an inspect-only match
 *   9. pass   — default
 *
 * Steps 1-3 come first on purpose: that ordering is what lets attack mode be
 * enabled without breaking SEO, a webhook sender or a customer's CI runner.
 * The rate limit sits after the allow steps for the same reason — a crawler that
 * is *allowed* is never counted against a visitor's budget.
 */
export function compileEdge(input: CompileInput): CompiledEdge {
  const { route, policy } = input;
  const attackMode = input.protection === "attack";
  const bots = [...VERIFIED_BOTS, ...(input.botAllowList ?? [])];

  const ladder: LadderStep[] = [];
  const directives: string[] = [
    `SecRuleEngine On`,
    `SecRule REQUEST_URI "@beginsWith ${route.pathPrefix}" "id:1,phase:1,pass,nolog,ctl:ruleEngine=On"`,
  ];
  let nextId = 10;

  // 1. Verified bots. Each allow is a two-rule chain: the UA match, then the
  //    forward-confirmed reverse-DNS suffix the edge recorded. The pair is what
  //    makes the allow trustworthy — a UA alone is attacker-controlled. Both
  //    rules are pushed so the chain is balanced: the member immediately follows
  //    its starter, and the next bot's starter is not swallowed by it.
  for (const bot of bots) {
    const valid = validateVerifiedBot(bot);
    if (!valid.ok) continue; // never emit a directive from an unvalidated bot
    const id = nextId++;
    const { starter, member } = verifiedBotDirectives(id, bot);
    directives.push(starter, member);
    // The reviewable form shows the whole chain, the way Coraza itself stores a
    // chained rule, so the confirmation is visible without reading SecLang.
    ladder.push({
      id,
      stage: "allow-verified-bot",
      action: "allow",
      directive: `${starter}\n${member}`,
    });
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

  // 3. Trusted sources. Before the deny list on purpose: a webhook sender or CI
  //    runner the customer registered is allowed even in attack mode, and the
  //    match is on the connection's source address, not an attacker-set header.
  //    An address that also appears in the deny list is still allowed — the
  //    operator asked for it twice, and "trust my own IP" is the more specific
  //    instruction. Each value was validated before it reached here.
  for (const source of input.trustedSources ?? []) {
    const valid = validateTrustedSource(source);
    if (!valid.ok) continue; // never emit a directive from an unvalidated value
    const id = nextId++;
    const directive = `SecRule REMOTE_ADDR "@ipMatch ${source.value}" "id:${id},phase:1,pass,nolog,setvar:tx.cloud_wai_trusted=1"`;
    directives.push(directive);
    ladder.push({ id, stage: "allow-trusted-ip", action: "allow", directive });
  }

  // 4. Deny list. Each value was validated before it reached here; a value that
  //    would not match its grammar never becomes a directive.
  //
  //    Each deny is a three-rule chain whose members fail when the trusted
  //    marker or the confirmed-bot marker is set, so a trusted address and a
  //    confirmed crawler really are "never blocked" — otherwise the allow steps
  //    above would mark them and this rule would deny them anyway, and the
  //    operator's own webhook sender would be blocked by a rule they added to
  //    block someone else, or a broad CIDR/ASN sweep would take Googlebot with
  //    it and quietly break SEO. Both markers are only ever set from a validated
  //    address literal and a forward-confirmed DNS name, so neither can be
  //    claimed by a header.
  for (const rule of input.denyList ?? []) {
    const valid = validateDenyRule(rule);
    if (!valid.ok) continue; // never emit a directive from an unvalidated value
    const { target, operator } = denyOperator(rule);
    const id = nextId++;
    const starter = `SecRule ${target} "${operator}" "id:${id},phase:1,deny,status:403,log,msg:'cloud-wai deny list: ${rule.kind}',chain"`;
    const trustedMember = `SecRule TX:cloud_wai_trusted "!@streq 1" "t:none,chain"`;
    const botMember = `SecRule TX:${BOT_MARKER_VARIABLE} "!@rx ^\\d+$" "t:none"`;
    directives.push(starter, trustedMember, botMember);
    ladder.push({
      id,
      stage: "block-deny-list",
      action: "block",
      directive: `${starter}\n${trustedMember}\n${botMember}`,
    });
  }

  // 5. Rate limits. After the allow steps on purpose: a verified bot, an
  //    internal probe or a trusted address has already been marked and is never
  //    counted, so a scraper is throttled without a crawler or a webhook sender
  //    being affected. Each value was validated before it reached here.
  const rateLimits: CompiledRateLimit[] = [];
  for (const rule of input.rateLimits ?? []) {
    const valid = validateRateLimitRule(rule);
    if (!valid.ok) continue; // never emit a descriptor from an unvalidated rule
    const id = nextId++;
    const descriptor = rateLimitDescriptor(rule);
    // Coraza has no rate primitive; Envoy's rate-limit filter enforces it
    // upstream. The directive records the intent so the compiled config is
    // self-describing, and the descriptor below is what the edge actuates.
    const directive = `SecAction "id:${id},phase:1,pass,nolog,setvar:tx.cloud_wai_rate_limit=${rule.limit}/${
      rule.windowSeconds
    }s,setvar:tx.cloud_wai_rate_key=${rule.key}"`;
    directives.push(directive);
    ladder.push({ id, stage: "ratelimit", action: "log", directive });
    rateLimits.push({
      descriptor,
      limit: rule.limit,
      windowSeconds: rule.windowSeconds,
    });
  }

  // 6. Attack mode challenges browsers. It is Envoy that serves the challenge;
  //    the WAF records the intent so the compiled config is self-describing.
  if (attackMode) {
    const id = nextId++;
    const directive = `SecAction "id:${id},phase:1,pass,nolog,setvar:tx.cloud_wai_challenge_browsers=1"`;
    directives.push(directive);
    ladder.push({ id, stage: "challenge", action: "challenge", directive });
  }

  // 7. The WAF rule. Present whenever there is a policy, in every mode: attack
  //    mode adds a challenge, it never weakens inspection.
  //
  //    The variable names are the CRS 4 ones, which is the pinned ruleset. CRS 4
  //    accumulates the inbound score in `tx.blocking_inbound_anomaly_score` and
  //    reads the threshold from `tx.inbound_anomaly_score_threshold`; there is no
  //    `tx.anomaly_score_threshold` in any CRS version, and `tx.anomaly_score` is
  //    a derived value CRS 4 sets in phase 5, after this phase-2 rule has run.
  //    Reading either of those made the rule a no-op, so a request the customer
  //    asked to block was not blocked by this step.
  if (policy) {
    const severity = CORAZA_SEVERITY[policy.riskLevel];
    const action = CORAZA_ACTION[policy.action];
    const thresholdId = nextId++;
    const ruleId = nextId++;
    const threshold = policy.riskLevel === "critical" ? 1 : policy.riskLevel === "high" ? 3 : 5;
    const setThreshold = `SecAction "id:${thresholdId},phase:1,pass,nolog,setvar:tx.inbound_anomaly_score_threshold=${threshold}"`;
    const wafRule = `SecRule TX:BLOCKING_INBOUND_ANOMALY_SCORE "@ge %{tx.inbound_anomaly_score_threshold}" "id:${ruleId},phase:2,severity:${severity},${action},status:403,log"`;
    directives.push(setThreshold, wafRule);
    ladder.push({ id: ruleId, stage: "waf", action: policy.action, directive: wafRule });
  }

  // One fragment per host, primary first. The directives above are shared: they
  // inspect the request, not the host, so a policy deployed with three hosts
  // inspects all three.
  const allRoutes = [route, ...(input.routes ?? [])];
  const seen = new Set<string>();
  // Only the validated address literals reach the fragment: a value that would
  // not be a legal IP/CIDR is dropped here exactly as it is dropped from the WAF
  // directive, so the two layers cannot disagree about whom they trust.
  const skipChallengeAddresses = (input.trustedSources ?? [])
    .filter((source) => validateTrustedSource(source).ok)
    .map((source) => source.value);
  const envoyRoutes: EnvoyRouteFragment[] = [];
  for (const one of allRoutes) {
    if (seen.has(one.host)) continue;
    seen.add(one.host);
    envoyRoutes.push({
      host: one.host,
      pathPrefix: one.pathPrefix,
      cluster: `origin-${one.host.replace(/\./g, "-")}`,
      privateOrigin: one.origin,
      wafEnabled: policy !== undefined,
      challengeBrowsers: attackMode,
      skipChallengeAddresses,
      // Only meaningful while the edge is challenging; the flag is still emitted
      // in every mode so a fragment is self-describing.
      skipChallengeForVerifiedBots: attackMode,
    });
  }

  return {
    corazaDirectives: directives,
    envoyConfig: envoyRoutes[0]!,
    envoyRoutes,
    ladder,
    rateLimits,
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
