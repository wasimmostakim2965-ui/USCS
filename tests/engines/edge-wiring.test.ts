/**
 * The production security-edge wiring (audit finding A7).
 *
 * The adapter and the compiler are proven in `tests/engines/security-edge.test.ts`.
 * What that cannot prove is whether a *deployment* ever hands the adapter a real
 * route and policy: until this, `buildEngines` was called with no `securityEdge`,
 * so the edge stayed `not_configured` in production no matter how it was
 * configured. These pin the wiring that closes that gap, using a real store over
 * an in-process PostgREST stand-in — not a mock of the loaders.
 *
 * The stand-in speaks the same request shape as PostgREST and applies the same
 * tenant rule (every read is scoped by `organization_id`), so a loader that
 * forgot the tenant filter would read another organization's rows and fail here.
 */
import { describe, expect, it } from "vitest";
import {
  buildDeploymentEngines,
  createPostgrestClient,
  createSecurityEdgeLoaders,
  createSupabaseControlPlaneStore,
  securityEdgeConfigFromEnv,
} from "@cloud-wai/database";
import type { OrganizationId, ProviderRef } from "@cloud-wai/contracts";

const ORG_A = "org-a" as OrganizationId;
const ORG_B = "org-b" as OrganizationId;

type Row = Record<string, unknown>;

/** A PostgREST stand-in that honours `eq.` filters and tenant scoping. */
function fakePostgrest(tables: Record<string, Row[]>) {
  const requests: string[] = [];
  const respond = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl = (async (url: string) => {
    const path = url.replace(/^.*\/rest\/v1/, "");
    requests.push(path);
    const [table, query = ""] = path.replace(/^\//, "").split("?");
    const rows = tables[table ?? ""] ?? [];
    const filters: [string, string][] = [];
    for (const part of query.split("&")) {
      const [key, raw] = part.split("=");
      if (!key || raw === undefined || !raw.startsWith("eq.")) continue;
      filters.push([key, decodeURIComponent(raw.slice(3))]);
    }
    const isTrue = query.includes("verified=is.true");
    const matched = rows.filter(
      (row) =>
        filters.every(([key, value]) => String(row[key]) === value) &&
        (!isTrue || row.verified === true),
    );
    return respond(matched);
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function storeOver(tables: Record<string, Row[]>) {
  const { fetchImpl, requests } = fakePostgrest(tables);
  const client = createPostgrestClient({
    url: "https://db.test",
    serviceRoleKey: "service-role",
    fetchImpl,
  });
  const store = createSupabaseControlPlaneStore({ client, newId: () => "new-id" });
  return { store, requests };
}

const domainRow = (org: string, hostname: string, verified: boolean, verifiedAt: string | null) => ({
  id: `dom-${hostname}`,
  organization_id: org,
  project_id: null,
  hostname,
  verified,
  provider: null,
  provider_resource_id: null,
  verification_token: null,
  verified_at: verifiedAt,
  created_at: "2026-01-01T00:00:00.000Z",
});

const policyRow = (org: string) => ({
  id: "pol-1",
  organization_id: org,
  name: "default",
  risk_level: "high",
  action: "block",
  state: "active",
  protection_mode: "attack",
  protection_expires_at: null,
  version: 3,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const ref = (organizationId: OrganizationId, resourceId: string): ProviderRef => ({
  organizationId,
  provider: "envoy",
  resourceType: "domain",
  resourceId,
});

const ENV = {
  SECURITY_EDGE_URL: "https://edge.internal:9443",
  SECURITY_EDGE_ORIGIN: "10.0.1.5",
  SECURITY_EDGE_TOKEN__org_a: "token-a",
};

describe("security edge environment config", () => {
  it("is null without a URL, a private origin, or a token", () => {
    expect(securityEdgeConfigFromEnv({})).toBeNull();
    expect(
      securityEdgeConfigFromEnv({ SECURITY_EDGE_URL: "https://edge.test" }),
    ).toBeNull();
    expect(
      securityEdgeConfigFromEnv({
        SECURITY_EDGE_URL: "https://edge.test",
        SECURITY_EDGE_ORIGIN: "10.0.0.1",
      }),
    ).toBeNull();
  });

  it("refuses a public origin rather than publishing a reachable origin", () => {
    expect(
      securityEdgeConfigFromEnv({
        SECURITY_EDGE_URL: "https://edge.test",
        SECURITY_EDGE_ORIGIN: "app.example.com",
        SECURITY_EDGE_TOKEN__org_a: "t",
      }),
    ).toBeNull();
    expect(
      securityEdgeConfigFromEnv({
        SECURITY_EDGE_URL: "https://edge.test",
        SECURITY_EDGE_ORIGIN: "203.0.113.9",
        SECURITY_EDGE_TOKEN__org_a: "t",
      }),
    ).toBeNull();
  });

  it("accepts a private origin and per-organization tokens", () => {
    const config = securityEdgeConfigFromEnv(ENV);
    expect(config).not.toBeNull();
    expect(config?.origin).toBe("10.0.1.5");
    expect(config?.tokens["org_a"]).toBe("token-a");
  });
});

describe("security edge loaders", () => {
  it("resolves a verified domain to a route with the deployment's private origin", async () => {
    const { store } = storeOver({
      domains: [domainRow("org-a", "app.example.com", true, "2026-01-02T00:00:00.000Z")],
    });
    const loaders = createSecurityEdgeLoaders(store, securityEdgeConfigFromEnv(ENV)!);
    const route = await loaders.loadRoute(ref(ORG_A, "app.example.com"));
    expect(route).toEqual({
      host: "app.example.com",
      origin: "10.0.1.5",
      pathPrefix: "/",
      organizationId: ORG_A,
    });
  });

  it("refuses an unverified domain, so a host that does not point here is never published", async () => {
    const { store } = storeOver({
      domains: [domainRow("org-a", "app.example.com", false, null)],
    });
    const loaders = createSecurityEdgeLoaders(store, securityEdgeConfigFromEnv(ENV)!);
    expect(await loaders.loadRoute(ref(ORG_A, "app.example.com"))).toBeNull();
  });

  it("does not serve another organization's hostname", async () => {
    const { store } = storeOver({
      domains: [domainRow("org-b", "app.example.com", true, "2026-01-02T00:00:00.000Z")],
    });
    const loaders = createSecurityEdgeLoaders(store, securityEdgeConfigFromEnv(ENV)!);
    // Scoped to org-a: org-b's row is invisible, so this is null, not a leak.
    expect(await loaders.loadRoute(ref(ORG_A, "app.example.com"))).toBeNull();
  });

  it("compiles the stored policy with its mode, deny list and trusted sources", async () => {
    const { store } = storeOver({
      security_policies: [policyRow("org-a")],
      domains: [domainRow("org-a", "app.example.com", true, "2026-01-02T00:00:00.000Z")],
      security_rules: [
        {
          id: "rule-1",
          organization_id: "org-a",
          kind: "ip",
          value: "198.51.100.7",
          note: null,
          created_by: "user-1",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      security_trusted_sources: [
        {
          id: "src-1",
          organization_id: "org-a",
          kind: "cidr",
          value: "203.0.113.0/24",
          note: null,
          created_by: "user-1",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const loaders = createSecurityEdgeLoaders(store, securityEdgeConfigFromEnv(ENV)!);
    const input = await loaders.loadPolicy(ref(ORG_A, "pol-1"));
    expect(input?.policy).toEqual({ riskLevel: "high", action: "block", version: 3 });
    expect(input?.protection).toBe("attack");
    expect(input?.denyList).toEqual([{ kind: "ip", value: "198.51.100.7" }]);
    expect(input?.trustedSources).toEqual([{ kind: "cidr", value: "203.0.113.0/24" }]);
    expect(input?.route.host).toBe("app.example.com");
  });

  it("refuses to compile a policy for an organization with no verified route", async () => {
    const { store } = storeOver({
      security_policies: [policyRow("org-a")],
      domains: [],
    });
    const loaders = createSecurityEdgeLoaders(store, securityEdgeConfigFromEnv(ENV)!);
    expect(await loaders.loadPolicy(ref(ORG_A, "pol-1"))).toBeNull();
  });
});

describe("buildDeploymentEngines", () => {
  it("builds the honest not_configured edge when no edge is configured", () => {
    const { store } = storeOver({});
    const engines = buildDeploymentEngines({}, store);
    expect((engines.securityEdge as { __notConfigured?: boolean }).__notConfigured).toBe(true);
  });

  it("builds a reachable edge when the environment configures one", () => {
    const { store } = storeOver({});
    const engines = buildDeploymentEngines(ENV, store);
    expect((engines.securityEdge as { __notConfigured?: boolean }).__notConfigured).toBeUndefined();
  });
});
