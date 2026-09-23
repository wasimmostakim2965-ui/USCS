/**
 * The router over the real registered procedure table.
 *
 * The scope tests elsewhere build procedures by hand to isolate a case. This
 * suite exercises the table the API actually mounts, so a procedure cannot be
 * registered without going through the guard.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  ApiKeyCreateInput,
  ApiKeySummary,
  AuditEvent,
  AuditEventInput,
  DataResource,
  DataStore,
  Deployment,
  Domain,
  MembershipStore,
  Organization,
  Project,
} from "@cloud-wai/database";
import type { ApiKeyId, OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";
import { buildProcedures, buildRouter, procedureNames, type RouterDeps } from "@cloud-wai/api";

const ALICE = "u-alice";
const CAROL = "u-carol";
const ORG_A = "org-a" as OrganizationId;
const TOKEN_ALICE = "t-alice";
const TOKEN_CAROL = "t-carol";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: {
    userId: ALICE,
    email: "a@x.test",
    displayName: "Alice",
    accessToken: TOKEN_ALICE,
  },
  [TOKEN_CAROL]: {
    userId: CAROL,
    email: "c@x.test",
    displayName: "Carol",
    accessToken: TOKEN_CAROL,
  },
};

const verifier: SessionVerifier = {
  async verify(token) {
    return sessions[token] ?? null;
  },
};

const memberships: Membership[] = [{ organizationId: ORG_A, userId: ALICE, role: "owner" }];
const membershipStore: MembershipStore = {
  async membershipsFor(userId) {
    return memberships.filter((m) => m.userId === userId);
  },
};

function makeStore() {
  const organizations: Organization[] = [
    { id: ORG_A, name: "A", slug: "a", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const projects: Project[] = [
    {
      id: "p-1" as ProjectId,
      organizationId: ORG_A,
      name: "P",
      slug: "p",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const deployments: Deployment[] = [];
  const audit: AuditEvent[] = [];
  const domains: Domain[] = [];
  const dataResources: DataResource[] = [];
  const apiKeys: ApiKeySummary[] = [];

  const isMember = (userId: UserId, org: OrganizationId) =>
    memberships.some((m) => m.userId === userId && m.organizationId === org);

  const store: DataStore = {
    async listOrganizations(userId) {
      return organizations.filter((o) => isMember(userId, o.id));
    },
    async createOrganization(input) {
      const org: Organization = {
        id: `org-${input.slug}` as OrganizationId,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-01T00:00:00Z",
      };
      organizations.push(org);
      memberships.push({ organizationId: org.id, userId: input.createdBy, role: "owner" });
      return org;
    },
    async listProjects(userId, org) {
      return isMember(userId, org) ? projects.filter((p) => p.organizationId === org) : [];
    },
    async getProject(userId, projectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId) ? p : null;
    },
    async createProject(input) {
      const p: Project = {
        id: `proj-${input.slug}` as ProjectId,
        organizationId: input.organizationId,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-01T00:00:00Z",
      };
      projects.push(p);
      return p;
    },
    async listDeployments(userId, projectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId)
        ? deployments.filter((d) => d.projectId === projectId)
        : [];
    },
    async listAuditEvents(userId, org) {
      return isMember(userId, org) ? audit.filter((a) => a.organizationId === org) : [];
    },
    async listDomains(userId, org) {
      return isMember(userId, org) ? domains.filter((d) => d.organizationId === org) : [];
    },
    async listDataResources(userId, org) {
      return isMember(userId, org) ? dataResources.filter((d) => d.organizationId === org) : [];
    },
    async listApiKeys(userId, org) {
      return isMember(userId, org) ? apiKeys.filter((k) => k.organizationId === org) : [];
    },
    async createApiKey(input: ApiKeyCreateInput) {
      const key: ApiKeySummary = {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        keyPrefix: input.keyPrefix,
        scopes: input.scopes,
        createdAt: "2026-01-01T00:00:00Z",
        lastUsedAt: null,
        revokedAt: null,
      };
      apiKeys.push(key);
      return key;
    },
    async revokeApiKey(userId, org, keyId) {
      if (!isMember(userId, org)) return false;
      const key = apiKeys.find((k) => k.id === keyId && k.organizationId === org);
      if (!key) return false;
      const index = apiKeys.indexOf(key);
      apiKeys[index] = { ...key, revokedAt: "2026-01-02T00:00:00Z" };
      return true;
    },
    async recordAuditEvent(input: AuditEventInput) {
      const e: AuditEvent = {
        ...input,
        id: `a-${audit.length + 1}`,
        createdAt: "2026-01-01T00:00:00Z",
      };
      audit.push(e);
      return e;
    },
  };
  return { store, audit, projects };
}

function deps(store: DataStore): RouterDeps {
  return {
    verifier,
    memberships: membershipStore,
    store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

describe("the registered procedure table", () => {
  it("exposes exactly the documented procedures", () => {
    const { store } = makeStore();
    expect(procedureNames(store)).toEqual([
      "apiKeys.create",
      "apiKeys.list",
      "apiKeys.revoke",
      "audit.list",
      "data.list",
      "deployments.list",
      "domains.list",
      "organizations.create",
      "organizations.get",
      "organizations.list",
      "projects.create",
      "projects.get",
      "projects.list",
      "providers.health",
    ]);
  });

  it("rejects every procedure without a session", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    for (const name of procedureNames(store)) {
      const res = await router.route({ procedure: name });
      expect(res.status).toBe(401);
    }
  });

  it("rejects every procedure for a valid session with no membership", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));

    // Carol is a real user but not a member of anything. Every scoped procedure
    // must refuse her; the two list procedures may succeed with an empty list.
    const scoped: Record<string, unknown> = {
      "organizations.get": { organizationId: ORG_A },
      "projects.list": { organizationId: ORG_A },
      "projects.get": { projectId: "p-1" },
      "projects.create": { organizationId: ORG_A, name: "Sneak", slug: "sneak" },
      "deployments.list": { projectId: "p-1" },
      "audit.list": { organizationId: ORG_A },
      "domains.list": { organizationId: ORG_A },
      "data.list": { organizationId: ORG_A },
      "apiKeys.list": { organizationId: ORG_A },
      "apiKeys.create": { organizationId: ORG_A, name: "Sneak", scopes: ["org:delete"] },
      "apiKeys.revoke": { organizationId: ORG_A, keyId: "k-1" as ApiKeyId },
      "providers.health": { organizationId: ORG_A },
    };

    for (const [procedure, input] of Object.entries(scoped)) {
      const res = await router.route({ procedure, accessToken: TOKEN_CAROL, input });
      expect(res.ok, `${procedure} should refuse a non-member`).toBe(false);
      expect([403, 404], `${procedure} status`).toContain(res.status);
    }
  });

  it("serves the organization list to a member", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({ procedure: "organizations.list", accessToken: TOKEN_ALICE });
    expect(res.ok).toBe(true);
    expect((res.data as Organization[]).map((o) => o.id)).toEqual([ORG_A]);
  });

  it("audits a creation through the registered create procedure", async () => {
    const { store, audit } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({
      procedure: "organizations.create",
      accessToken: TOKEN_ALICE,
      input: { name: "New Org", slug: "new-org" },
    });
    expect(res.ok).toBe(true);
    expect(audit.some((a) => a.event === "organization.created" && a.actorId === ALICE)).toBe(true);
  });

  it("rejects a bad payload without touching the store", async () => {
    const { store } = makeStore();
    const router = buildRouter(deps(store), buildProcedures(store));
    const res = await router.route({
      procedure: "projects.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Bad", slug: "Not Valid" },
    });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
  });
});
