/**
 * The production wiring for the security edge.
 *
 * `packages/adapters` compiles Cloud Wai policy into Envoy/Coraza syntax, but it
 * never reaches into the control plane for the facts it compiles from. This
 * module is that seam: it reads the *stored* route, policy, deny list and trusted
 * sources on the service role (a distribution job has no session) and hands the
 * adapter a `CompilerInput`. It lives in `packages/database` because it is the
 * control-plane read side and because both the API and the worker need the same
 * implementation — one loader, not two that can drift.
 *
 * Two rules are kept here:
 *   * A route's origin is *deployment config*, never customer input. A public
 *     origin would be reachable directly, which is the one thing the edge exists
 *     to prevent, so the origin comes from the environment and is validated as
 *     private before it is used.
 *   * Nothing is fabricated. An organization with no policy, no verified route,
 *     or no edge origin yields `null`, and the adapter turns that into an honest
 *     refusal rather than a made-up route.
 */
import type { OrganizationId, ProviderRef } from "@cloud-wai/contracts";
import {
  buildEngines,
  createControlPlaneSecurityEdge,
  engineConfigFromEnv,
  type CompileInput,
  type DenyRule,
  type EdgeRoute,
  type EngineConfig,
  type Engines,
  type RateLimitRule,
  type TrustedSource,
  type VerifiedBot,
  validateVerifiedBot,
} from "@cloud-wai/adapters";
import { protectionIsActive } from "./protection.js";
import type { ControlPlaneStore } from "./index.js";

/** The default path prefix a published route serves at. */
const DEFAULT_PATH_PREFIX = "/";

/**
 * The private-address grammar an edge origin must satisfy.
 *
 * Mirrors the adapter's own check on purpose: a value that passes here must also
 * pass there, or a route would be assembled and then refused one layer down. A
 * public host is refused, because the whole point of the edge is that the origin
 * is not reachable directly.
 */
const PRIVATE_ORIGIN =
  /^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|\[?f[cd][0-9a-f]{2}:)/;

export interface SecurityEdgeEnvConfig {
  /** The edge's admin URL, e.g. `https://edge.internal:9443`. */
  readonly edgeUrl: string;
  /**
   * The private origin the edge forwards to. Deployment config, validated as a
   * private address; a public value is refused rather than quietly accepted.
   */
  readonly origin: string;
  /** Per-organization edge admin tokens, keyed by organization id. */
  readonly tokens: Readonly<Record<string, string>>;
  /**
   * Extra verified bots this deployment trusts, on top of the curated directory.
   *
   * This is the operator overlay the compiler's `botAllowList` expects — the
   * customer's own webhook providers and uptime monitors, which are deployment
   * config, never customer input. A malformed entry is dropped, which is
   * fail-closed: the bot is simply not pre-allowed and is challenged like any
   * other caller, so a typo can never turn into a bypass.
   */
  readonly botAllowList: readonly VerifiedBot[];
}

/** One allow-list entry: `name:userAgent:confirmSuffix`. */
function parseBotAllowList(raw: string | undefined): VerifiedBot[] {
  if (!raw) return [];
  const bots: VerifiedBot[] = [];
  for (const entry of raw.split(";")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split(":");
    if (parts.length !== 3) continue;
    const [name, userAgent, confirmSuffix] = parts as [string, string, string];
    const bot: VerifiedBot = { name: name.trim(), userAgent: userAgent.trim(), confirmSuffix: confirmSuffix.trim() };
    if (validateVerifiedBot(bot).ok) bots.push(bot);
  }
  return bots;
}

/**
 * Read the security edge's configuration from the environment.
 *
 * Returns `null` when the edge is not configured — no URL, no private origin, or
 * a non-private origin. The adapter then reports `not_configured`, which is the
 * honest state of a deployment with no edge host, not a failure.
 *
 * Tokens are per organization (`SECURITY_EDGE_TOKEN__<organizationId>`), because
 * the edge is per tenant: a shared token would erase the tenant boundary, the
 * same reason Coolify's token is per organization.
 */
export function securityEdgeConfigFromEnv(
  env: Record<string, string | undefined>,
): SecurityEdgeEnvConfig | null {
  const edgeUrl = env.SECURITY_EDGE_URL?.trim();
  const origin = env.SECURITY_EDGE_ORIGIN?.trim();
  if (!edgeUrl || !origin) return null;
  if (!PRIVATE_ORIGIN.test(origin)) return null;

  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^SECURITY_EDGE_TOKEN__(.+)$/);
    if (match && value && value.trim() !== "") tokens[match[1]!] = value.trim();
  }
  if (Object.keys(tokens).length === 0) return null;

  return {
    edgeUrl,
    origin,
    tokens,
    botAllowList: parseBotAllowList(env.SECURITY_EDGE_BOT_ALLOWLIST),
  };
}

export interface SecurityEdgeLoaders {
  /** The stored route for a hostname, or null when there is no verified one. */
  readonly loadRoute: (ref: ProviderRef) => Promise<EdgeRoute | null>;
  /** The stored policy compiled with its route, mode, deny list and trusted sources. */
  readonly loadPolicy: (ref: ProviderRef) => Promise<CompileInput | null>;
}

/**
 * Build the control-plane loaders the edge adapter resolves references through.
 *
 * `loadRoute` resolves a hostname to the route the edge serves: the host is the
 * customer's domain, but the origin is the deployment's private address. It
 * returns null unless the domain is verified, so a hostname that does not point
 * at this deployment is never published.
 *
 * `loadPolicy` assembles the full compile input: the organization's stored
 * policy (level, action, version and current protection mode), its deny list, its
 * trusted sources, and the route the policy's compiled artifact carries. It
 * returns null when there is no policy or no verified route to target, so a
 * distribution is refused honestly instead of naming a host nobody serves.
 */
export function createSecurityEdgeLoaders(
  store: ControlPlaneStore,
  config: SecurityEdgeEnvConfig,
): SecurityEdgeLoaders {
  const routeFor = (host: string, organizationId: OrganizationId): EdgeRoute => ({
    host,
    origin: config.origin,
    pathPrefix: DEFAULT_PATH_PREFIX,
    organizationId,
  });

  return {
    async loadRoute(ref): Promise<EdgeRoute | null> {
      const domain = await store.findDomainByHostnameForService(ref.organizationId, ref.resourceId);
      if (!domain || !domain.verified) return null;
      return routeFor(domain.hostname, ref.organizationId);
    },

    async loadPolicy(ref): Promise<CompileInput | null> {
      const policy = await store.getSecurityPolicyForService(ref.organizationId);
      if (!policy) return null;

      const routes = await store.listRoutableDomainsForService(ref.organizationId);
      if (routes.length === 0) return null;

      const rules = await store.listSecurityRulesForService(ref.organizationId);
      const trusted = await store.listTrustedSourcesForService(ref.organizationId);
      const limits = await store.listRateLimitsForService(ref.organizationId);

      const denyList: DenyRule[] = rules.map((rule) => ({
        kind: rule.kind,
        value: rule.value,
      }));
      const trustedSources: TrustedSource[] = trusted
        // A trusted source's grammar is IP or CIDR only; a row of any other kind
        // is dropped rather than emitted, matching the compiler's refusal.
        .filter(
          (source): source is typeof source & { kind: "ip" | "cidr" } =>
            source.kind === "ip" || source.kind === "cidr",
        )
        .map((source) => ({ kind: source.kind, value: source.value }));
      // A header-keyed limit carries its header name; the others carry none, so
      // the compiler's pairing check is satisfied by construction.
      const rateLimits: RateLimitRule[] = limits.map((limit) => ({
        id: limit.id,
        key: limit.key,
        ...(limit.key === "header" && limit.headerName ? { headerName: limit.headerName } : {}),
        limit: limit.limit,
        windowSeconds: limit.windowSeconds,
      }));

      const [primary, ...rest] = routes.map((domain) =>
        routeFor(domain.hostname, ref.organizationId),
      );

      return {
        route: primary!,
        // Every verified host, not just the first: one policy artifact must
        // cover the organization's whole domain set, or a second domain is
        // served without inspection.
        routes: rest,
        policy: {
          riskLevel: policy.riskLevel,
          action: policy.action,
          version: policy.version,
        },
        protection: protectionIsActive(policy) ? "attack" : "normal",
        denyList,
        trustedSources,
        rateLimits,
        // The deployment's own trusted crawlers/webhook senders, on top of the
        // curated directory. Operator config, so a customer cannot widen the
        // allow-list through the dashboard.
        ...(config.botAllowList.length > 0 ? { botAllowList: config.botAllowList } : {}),
      };
    },
  };
}

/**
 * Build this deployment's engines, including a *reachable* security edge.
 *
 * `engineConfigFromEnv` alone leaves the edge `not_configured`, because
 * `buildEngines` only accepts a pre-built edge adapter and cannot construct one
 * without control-plane readers. This is where those readers are supplied: when
 * the environment names an edge URL, a private origin and a token, the real
 * adapter is built over the store, so a policy distribution actually reaches the
 * edge. Without that configuration the honest `not_configured` edge is built
 * instead — never a stub that pretends to succeed.
 *
 * Both the API and the worker call this, so a deployment cannot wire the edge in
 * one process and forget it in the other.
 */
export function buildDeploymentEngines(
  env: Record<string, string | undefined>,
  store: ControlPlaneStore,
): Engines {
  const config: EngineConfig = engineConfigFromEnv(env);
  const edge = securityEdgeConfigFromEnv(env);
  if (!edge) return buildEngines(config);

  const loaders = createSecurityEdgeLoaders(store, edge);
  return buildEngines({
    ...config,
    securityEdge: createControlPlaneSecurityEdge({
      edgeUrl: edge.edgeUrl,
      tokenFor: (organizationId) => edge.tokens[organizationId] ?? null,
      loadRoute: loaders.loadRoute,
      loadPolicy: loaders.loadPolicy,
    }),
  });
}
