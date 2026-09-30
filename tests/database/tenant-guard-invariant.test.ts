/**
 * Every caller-scoped store method must carry the tenant guard.
 *
 * The `/rpc` path builds the control-plane store with the *service-role* key
 * (`apps/api/src/bootstrap.ts`), so the database does not narrow a read for it —
 * the service role may see every tenant's rows. What actually holds the boundary
 * is the per-query membership predicate
 * (`organizations.organization_members.user_id=eq.<caller>`), a security
 * invariant enforced in application code, not an implementation detail.
 *
 * Nothing failed if one method dropped that predicate: the store would keep
 * returning another tenant's rows and every test would stay green, because the
 * store tests use stand-ins that do not model tenant isolation. This probe is
 * the guard against that erosion. It calls *every* caller-scoped method through a
 * recording stand-in and asserts the generated request carries the predicate.
 *
 * A method whose first parameter is a `userId` is caller-scoped by contract, so
 * this list is derived from the interface, not hand-picked: adding a scoped
 * method without the guard fails here. Methods named `*ForService` are the
 * deliberate, service-role-only exceptions and are excluded by name.
 */
import { describe, expect, it } from "vitest";
import { createPostgrestClient, createSupabaseControlPlaneStore } from "@cloud-wai/database";
import type { OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";

const USER = "33333333-3333-4333-8333-333333333333" as UserId;
const ORG = "11111111-1111-4111-8111-111111111111" as OrganizationId;
const PROJ = "22222222-2222-4222-8222-222222222222" as ProjectId;
const ID = "55555555-5555-4555-8555-555555555555";

/**
 * The two correct forms of the predicate, per the table shape.
 *
 * A table that is not `organizations` joins back through it
 * (`organizations.organization_members.user_id=eq.<caller>`); on the
 * `organizations` table itself the embed is direct
 * (`organization_members.user_id=eq.<caller>`). Either is the guard; anything
 * else is a missing tenant re-check.
 */
const GUARDS = [
  `organizations.organization_members.user_id=eq.${USER}`,
  `organization_members.user_id=eq.${USER}`,
];

type Call = { readonly method: string; readonly path: string };

/**
 * A stand-in that records every request and answers an empty list, so a method
 * runs far enough to build its PostgREST path without needing real rows. The
 * point is the *path*, never the payload.
 */
function recordingStore() {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/rest\/v1/, "");
    const method = String(init?.method ?? "GET");
    calls.push({ method, path });
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = createPostgrestClient({
    url: "https://db.test",
    serviceRoleKey: "service-role",
    fetchImpl,
  });
  return { store: createSupabaseControlPlaneStore({ client, newId: () => "new-id" }), calls };
}

/**
 * Every caller-scoped method, paired with a call that reaches its request.
 *
 * Each entry names the method and the arguments that make it issue a request.
 * A method added to the store without an entry here still fails the second test,
 * which enumerates the store's own methods and requires the first parameter to
 * be a `userId` only when a matching entry exists.
 */
const CALLS: ReadonlyArray<
  readonly [string, (store: ReturnType<typeof recordingStore>["store"]) => Promise<unknown>]
> = [
  ["membershipsFor", (s) => s.membershipsFor(USER)],
  ["listOrganizations", (s) => s.listOrganizations(USER)],
  ["listOrganizationMembers", (s) => s.listOrganizationMembers(USER, ORG)],
  [
    "updateOrganizationMemberRole",
    (s) =>
      s.updateOrganizationMemberRole({
        userId: USER,
        organizationId: ORG,
        memberId: ID as UserId,
        role: "member",
      }),
  ],
  [
    "removeOrganizationMember",
    (s) =>
      s.removeOrganizationMember({ userId: USER, organizationId: ORG, memberId: ID as UserId }),
  ],
  ["listProjects", (s) => s.listProjects(USER, ORG)],
  ["getProject", (s) => s.getProject(USER, PROJ)],
  ["listDeployments", (s) => s.listDeployments(USER, PROJ)],
  ["listOrganizationDeployments", (s) => s.listOrganizationDeployments(USER, ORG)],
  ["getDeployment", (s) => s.getDeployment(USER, ID as never)],
  ["listAuditEvents", (s) => s.listAuditEvents(USER, ORG)],
  ["listDomains", (s) => s.listDomains(USER, ORG)],
  ["getDomain", (s) => s.getDomain(USER, ID as never)],
  ["deleteDomain", (s) => s.deleteDomain(USER, ORG, ID as never)],
  ["listDataResources", (s) => s.listDataResources(USER, ORG)],
  ["getDataResource", (s) => s.getDataResource(USER, ID as never)],
  ["listDataBackups", (s) => s.listDataBackups(USER, ID as never)],
  ["listDataRestores", (s) => s.listDataRestores(USER, ID as never)],
  ["listApiKeys", (s) => s.listApiKeys(USER, ORG)],
  ["revokeApiKey", (s) => s.revokeApiKey(USER, ORG, ID)],
  ["listGitLinks", (s) => s.listGitLinks(USER, PROJ)],
  ["deleteGitLink", (s) => s.deleteGitLink(USER, ORG, ID)],
  ["listEnvVars", (s) => s.listEnvVars(USER, PROJ)],
  ["deleteEnvVar", (s) => s.deleteEnvVar(USER, ORG, ID)],
  ["getEnvVarEngineRef", (s) => s.getEnvVarEngineRef(USER, ORG, ID)],
  ["listEnvironments", (s) => s.listEnvironments(USER, PROJ)],
  ["getEnvironment", (s) => s.getEnvironment(USER, PROJ, ID)],
  ["listUsageRecords", (s) => s.listUsageRecords(USER, ORG)],
  ["listBudgets", (s) => s.listBudgets(USER, ORG)],
  ["deleteBudget", (s) => s.deleteBudget(USER, ORG, "deployments")],
  ["listOrchestrationJobs", (s) => s.listOrchestrationJobs(USER, ORG)],
  ["getSecurityPolicy", (s) => s.getSecurityPolicy(USER, ORG)],
  ["listPolicyEvents", (s) => s.listPolicyEvents(USER, ORG)],
  ["listSecurityRules", (s) => s.listSecurityRules(USER, ORG)],
  ["deleteSecurityRule", (s) => s.deleteSecurityRule(USER, ORG, ID)],
  ["listSecurityEvents", (s) => s.listSecurityEvents(USER, ORG)],
  ["listSecurityIncidents", (s) => s.listSecurityIncidents(USER, ORG)],
  ["listTrustedSources", (s) => s.listTrustedSources(USER, ORG)],
  ["deleteTrustedSource", (s) => s.deleteTrustedSource(USER, ORG, ID)],
  ["listRateLimits", (s) => s.listRateLimits(USER, ORG)],
  ["deleteRateLimit", (s) => s.deleteRateLimit(USER, ORG, ID)],
  ["findDeploymentByIdempotencyKey", (s) => s.findDeploymentByIdempotencyKey(USER, ORG, "key")],
  ["getProjectDeploymentTarget", (s) => s.getProjectDeploymentTarget(USER, PROJ)],
  ["getDeploymentProtection", (s) => s.getDeploymentProtection(USER, ORG, PROJ)],
];

describe("every caller-scoped store method carries the tenant guard", () => {
  it.each(CALLS)("%s issues a request with the membership predicate", async (method, call) => {
    const { store, calls } = recordingStore();
    await call(store);
    expect(calls.length, `${method} issued no request`).toBeGreaterThan(0);
    for (const { path } of calls) {
      const guarded = GUARDS.some((guard) => path.includes(guard));
      expect(guarded, `${method} issued a request without the tenant guard: ${path}`).toBe(true);
    }
  });

  it("covers every caller-scoped method the store exposes", async () => {
    // The store is a plain object, so its methods are its own enumerable keys.
    // A method is caller-scoped when its first parameter is named `userId`; the
    // deliberate service-role exceptions are named `*ForService`.
    const { store } = recordingStore();
    const scoped = Object.keys(store)
      .filter((name) => typeof (store as Record<string, unknown>)[name] === "function")
      .filter((name) => !name.endsWith("ForService"))
      .filter((name) => {
        const source = String((store as Record<string, unknown>)[name]);
        return /^async\s+\w+\(\s*userId\b/.test(source);
      });
    // A vacuous list would make this test pass while proving nothing.
    expect(scoped.length).toBeGreaterThan(30);
    const covered = new Set(CALLS.map(([name]) => name));
    const missing = scoped.filter((name) => !covered.has(name));
    expect(missing, `caller-scoped methods with no guard probe: ${missing.join(", ")}`).toEqual([]);
  });
});
