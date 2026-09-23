/**
 * Phase 2 acceptance: the API layer must not let one organization reach
 * another, and must not let a client write state it does not own.
 *
 * The store here is a real in-memory implementation of `DataStore`, not a mock:
 * it applies the same membership filter the SQL policies apply, so the test
 * exercises the procedure logic and the scope guard for real. The SQL layer is
 * proven separately by tests/isolation/rls/10_isolation_probe.sql against
 * PostgreSQL.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  AuditEvent,
  AuditEventInput,
  DataStore,
  Deployment,
  MembershipStore,
  Organization,
  Project,
} from "@cloud-wai/database";
import type { OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";
import {
  ApiError,
  buildContext,
  buildRouter,
  getOrganization,
  getProject,
  listDeployments,
  listOrganizations,
  listProjects,
  type Procedure,
  type RouterDeps,
} from "@cloud-wai/api";

const ALICE = "u-alice";
const BOB = "u-bob";
const CAROL = "u-carol";
const ORG_A = "org-a" as OrganizationId;
const ORG_B = "org-b" as OrganizationId;
const PROJ_A = "proj-a" as ProjectId;
const PROJ_B = "proj-b" as ProjectId;

const TOKEN_ALICE = "token-alice";
const TOKEN_BOB = "token-bob";
const TOKEN_CAROL = "token-carol";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: {
    userId: ALICE,
    email: "alice@example.com",
    displayName: "Alice",
    accessToken: TOKEN_ALICE,
  },
  [TOKEN_BOB]: {
    userId: BOB,
    email: "bob@example.com",
    displayName: "Bob",
    accessToken: TOKEN_BOB,
  },
  [TOKEN_CAROL]: {
    userId: CAROL,
    email: "carol@example.com",
    displayName: "Carol",
    accessToken: TOKEN_CAROL,
  },
};

const verifier: SessionVerifier = {
  async verify(token) {
    return sessions[token] ?? null;
  },
};

const memberships: Membership[] = [
  { organizationId: ORG_A, userId: ALICE, role: "owner" },
  { organizationId: ORG_B, userId: BOB, role: "owner" },
  // Alice is only a viewer in org B — enough to read, not to write.
  { organizationId: ORG_B, userId: ALICE, role: "viewer" },
];

const membershipStore: MembershipStore = {
  async membershipsFor(userId) {
    return memberships.filter((m) => m.userId === userId);
  },
};

/**
 * In-memory control plane. Mirrors the SQL policies: rows are visible only to
 * members, and writes are attributed to the acting user.
 */
function makeStore() {
  const organizations: Organization[] = [
    { id: ORG_A, name: "Org A", slug: "org-a", createdAt: "2026-01-01T00:00:00Z" },
    { id: ORG_B, name: "Org B", slug: "org-b", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const projects: Project[] = [
    {
      id: PROJ_A,
      organizationId: ORG_A,
      name: "Alpha",
      slug: "alpha",
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      id: PROJ_B,
      organizationId: ORG_B,
      name: "Beta",
      slug: "beta",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const deployments: Deployment[] = [
    {
      id: "dep-a",
      organizationId: ORG_A,
      projectId: PROJ_A,
      status: "succeeded",
      url: "https://alpha.example.com",
      failureReason: null,
      createdAt: "2026-01-02T00:00:00Z",
    },
    {
      id: "dep-b",
      organizationId: ORG_B,
      projectId: PROJ_B,
      status: "succeeded",
      url: "https://beta.example.com",
      failureReason: null,
      createdAt: "2026-01-02T00:00:00Z",
    },
  ];
  const audit: AuditEvent[] = [];

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
        createdAt: "2026-01-03T00:00:00Z",
      };
      organizations.push(org);
      memberships.push({ organizationId: org.id, userId: input.createdBy, role: "owner" });
      return org;
    },
    async listProjects(userId, organizationId) {
      if (!isMember(userId, organizationId)) return [];
      return projects.filter((p) => p.organizationId === organizationId);
    },
    async getProject(userId, projectId) {
      const project = projects.find((p) => p.id === projectId);
      // Not a member => indistinguishable from absent.
      if (!project || !isMember(userId, project.organizationId)) return null;
      return project;
    },
    async createProject(input) {
      const project: Project = {
        id: `proj-${input.slug}` as ProjectId,
        organizationId: input.organizationId,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-03T00:00:00Z",
      };
      projects.push(project);
      return project;
    },
    async listDeployments(userId, projectId) {
      const project = projects.find((p) => p.id === projectId);
      if (!project || !isMember(userId, project.organizationId)) return [];
      return deployments.filter((d) => d.projectId === projectId);
    },
    async listAuditEvents(userId, organizationId) {
      if (!isMember(userId, organizationId)) return [];
      return audit.filter((a) => a.organizationId === organizationId);
    },
    async recordAuditEvent(input: AuditEventInput) {
      const event: AuditEvent = {
        ...input,
        id: `audit-${audit.length + 1}`,
        createdAt: "2026-01-03T00:00:00Z",
      };
      audit.push(event);
      return event;
    },
  };

  return { store, projects, deployments, audit, organizations };
}

function depsFor(store: DataStore): RouterDeps {
  return { verifier, memberships: membershipStore, store, logger: silentLogger() };
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function procedures(): Procedure[] {
  return [
    { name: "organizations.list", handler: (ctx, deps) => listOrganizations(ctx, deps as never) },
    {
      name: "projects.list",
      handler: (ctx, deps, input) =>
        listProjects(
          ctx,
          deps as never,
          (input as { organizationId: OrganizationId }).organizationId,
        ),
    },
    {
      name: "projects.get",
      handler: (ctx, deps, input) =>
        getProject(ctx, deps as never, (input as { projectId: ProjectId }).projectId),
    },
    {
      name: "organization.get",
      handler: (ctx, deps, input) =>
        getOrganization(
          ctx,
          deps as never,
          (input as { organizationId: OrganizationId }).organizationId,
        ),
    },
    {
      name: "deployments.list",
      handler: (ctx, deps, input) =>
        listDeployments(ctx, deps as never, (input as { projectId: ProjectId }).projectId),
    },
  ];
}

describe("API scope enforcement", () => {
  it("requires a session for every procedure", async () => {
    const { store } = makeStore();
    const router = buildRouter(depsFor(store), procedures());
    const res = await router.route({ procedure: "organizations.list" });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.error?.code).toBe("unauthenticated");
  });

  it("rejects a token the verifier does not recognise", async () => {
    const { store } = makeStore();
    const router = buildRouter(depsFor(store), procedures());
    const res = await router.route({ procedure: "organizations.list", accessToken: "forged" });
    expect(res.status).toBe(401);
  });

  it("scopes the organization list to the caller's memberships", async () => {
    const { store } = makeStore();
    const router = buildRouter(depsFor(store), procedures());
    const res = await router.route({ procedure: "organizations.list", accessToken: TOKEN_ALICE });
    expect(res.ok).toBe(true);
    const ids = (res.data as Organization[]).map((o) => o.id).sort();
    expect(ids).toEqual([ORG_A, ORG_B].sort());
  });

  it("returns nothing for a non-member, not an error about the tenant", async () => {
    const { store } = makeStore();
    const router = buildRouter(depsFor(store), procedures());
    const res = await router.route({
      procedure: "organizations.list",
      accessToken: TOKEN_CAROL,
    });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual([]);
  });

  it("refuses to read another organization's projects", async () => {
    const { store } = makeStore();
    const ctx = await buildContext(
      { verifier, memberships: membershipStore },
      { accessToken: TOKEN_ALICE },
    );

    // Alice is a viewer in org B: she may read, but org A's rows must not leak.
    const projects = await listProjects(ctx, { store }, ORG_A);
    expect(projects.map((p) => p.id)).toEqual([PROJ_A]);

    const bProjects = await listProjects(ctx, { store }, ORG_B);
    expect(bProjects.map((p) => p.id)).toEqual([PROJ_B]);
  });

  it("404s a project id from another tenant instead of leaking its existence", async () => {
    const { store } = makeStore();
    const ctx = await buildContext(
      { verifier, memberships: membershipStore },
      { accessToken: TOKEN_CAROL },
    );

    await expect(getProject(ctx, { store }, PROJ_A)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(getProject(ctx, { store }, PROJ_B)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("404s a get for an organization the caller is not in", async () => {
    const { store } = makeStore();
    const ctx = await buildContext(
      { verifier, memberships: membershipStore },
      { accessToken: TOKEN_CAROL },
    );
    await expect(getOrganization(ctx, { store }, ORG_A)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("does not let a client reach deployments of a foreign project", async () => {
    const { store } = makeStore();
    const ctx = await buildContext(
      { verifier, memberships: membershipStore },
      { accessToken: TOKEN_ALICE },
    );

    const own = await listDeployments(ctx, { store }, PROJ_A);
    expect(own.map((d) => d.id)).toEqual(["dep-a"]);

    // Alice is a viewer in B, so she can list B's deployments — but they are
    // B's rows, and org A's are never included.
    const foreign = await listDeployments(ctx, { store }, PROJ_B);
    expect(foreign.map((d) => d.id)).toEqual(["dep-b"]);
    expect(foreign.some((d) => d.organizationId === ORG_A)).toBe(false);
  });

  it("attributes an audit event to the acting principal", async () => {
    const { store, audit } = makeStore();
    const ctx = await buildContext(
      { verifier, memberships: membershipStore },
      { accessToken: TOKEN_ALICE },
    );

    const { createOrganization } = await import("@cloud-wai/api");
    const org = await createOrganization(ctx, { store }, { name: "Org C", slug: "org-c" });
    const recorded = audit.find((a) => a.organizationId === org.id);
    expect(recorded?.actorId).toBe(ALICE);
    expect(recorded?.actorEmail).toBe("alice@example.com");
  });

  it("rejects a malformed slug before it reaches the database", async () => {
    const { store } = makeStore();
    const ctx = await buildContext(
      { verifier, memberships: membershipStore },
      { accessToken: TOKEN_ALICE },
    );
    const { createProject } = await import("@cloud-wai/api");
    await expect(
      createProject(ctx, { store }, { organizationId: ORG_A, name: "Bad", slug: "Not A Slug" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("forbids a viewer from creating a project", async () => {
    const { store } = makeStore();
    const ctx = await buildContext(
      { verifier, memberships: membershipStore },
      { accessToken: TOKEN_ALICE },
    );
    const { createProject } = await import("@cloud-wai/api");
    // Alice is only a viewer in org B.
    await expect(
      createProject(ctx, { store }, { organizationId: ORG_B, name: "Sneak", slug: "sneak" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("normalises an unexpected failure without echoing its detail", async () => {
    const { store } = makeStore();
    const broken: DataStore = {
      ...store,
      async listOrganizations() {
        throw new Error("connection string postgres://user:hunter2@db");
      },
    };
    const router = buildRouter(depsFor(broken), procedures());
    const res = await router.route({ procedure: "organizations.list", accessToken: TOKEN_ALICE });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res)).not.toContain("hunter2");
  });

  it("returns a 404 for an unknown procedure", async () => {
    const { store } = makeStore();
    const router = buildRouter(depsFor(store), procedures());
    const res = await router.route({ procedure: "does.not.exist", accessToken: TOKEN_ALICE });
    expect(res.status).toBe(404);
  });

  it("exposes ApiError as a typed, satisfiable error", () => {
    const error = new ApiError("forbidden", "nope");
    expect(error.code).toBe("forbidden");
    expect(error).toBeInstanceOf(Error);
  });
});
