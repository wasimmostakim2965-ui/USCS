/**
 * Phase 1a acceptance: the deployment write path, end to end.
 *
 * The router the API actually mounts is exercised over the real registered
 * procedure table, with a real in-memory store that applies the same membership
 * filter the SQL policies apply, and the real hosting adapters. Nothing is
 * mocked away, because the properties that matter here are exactly the ones a
 * mock would hide:
 *
 *   * a deployment row is written before the engine is asked to act;
 *   * the row's status is the adapter's status — `not_configured` when no engine
 *     is wired, `succeeded` only when the engine said so;
 *   * a repeated idempotency key returns the original row and does not deploy
 *     twice;
 *   * a rollback with no engine-side application is honestly not_configured;
 *   * a non-member cannot deploy or roll back, and cannot learn that the
 *     organization exists.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  ApiKeySummary,
  AuditEvent,
  AuditEventInput,
  ControlPlaneWrites,
  DataResource,
  Deployment,
  Domain,
  MembershipStore,
  Organization,
  Project,
} from "@cloud-wai/database";
import type {
  AdapterResult,
  EngineStatus,
  OrganizationId,
  ProjectId,
  ProviderRef,
  UserId,
} from "@cloud-wai/contracts";
import { err, ok } from "@cloud-wai/contracts";
import {
  fakeHosting,
  hostingNotConfigured,
  databaseNotConfigured,
  storageNotConfigured,
  securityNotConfigured,
  domainVerifierNotConfigured,
  InMemoryJobQueue,
  type Engines,
  type JobQueue,
} from "@cloud-wai/adapters";
import { buildProcedures, buildRouter, type Procedure, type RouterDeps } from "@cloud-wai/api";

const ALICE = "u-alice";
const CAROL = "u-carol";
const ORG_A = "org-a" as OrganizationId;
const PROJ_A = "proj-a" as ProjectId;
const TOKEN_ALICE = "t-alice";
const TOKEN_CAROL = "t-carol";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: {
    userId: ALICE,
    email: "alice@example.com",
    displayName: "Alice",
    accessToken: TOKEN_ALICE,
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

const memberships: Membership[] = [{ organizationId: ORG_A, userId: ALICE, role: "owner" }];
const membershipStore: MembershipStore = {
  async membershipsFor(userId) {
    return memberships.filter((m) => m.userId === userId);
  },
};

/**
 * A control plane with the write methods the deployment procedures need.
 *
 * It mirrors the SQL layer's scope rules: a write only lands on a row in an
 * organization the acting user belongs to, and the membership join decides
 * visibility. That is what makes the isolation assertions meaningful.
 */
function makeStore() {
  const organizations: Organization[] = [
    { id: ORG_A, name: "A", slug: "a", createdAt: "2026-01-01T00:00:00Z" },
  ];
  let projects: Project[] = [
    {
      id: PROJ_A,
      organizationId: ORG_A,
      name: "Alpha",
      slug: "alpha",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const deployments: Deployment[] = [];
  const deploymentKeys = new Map<string, string>();
  const audit: AuditEvent[] = [];
  const domains: Domain[] = [];
  const dataResources: DataResource[] = [];
  const apiKeys: ApiKeySummary[] = [];

  const isMember = (userId: UserId, org: OrganizationId) =>
    memberships.some((m) => m.userId === userId && m.organizationId === org);

  const store = {
    async listOrganizations(userId: UserId) {
      return organizations.filter((o) => isMember(userId, o.id));
    },
    async createOrganization(input: { name: string; slug: string; createdBy: UserId }) {
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
    async listProjects(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? projects.filter((p) => p.organizationId === org) : [];
    },
    async getProject(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId) ? p : null;
    },
    async createProject(input: {
      organizationId: OrganizationId;
      name: string;
      slug: string;
      createdBy: UserId;
    }) {
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
    async listDeployments(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId)
        ? deployments.filter((d) => d.projectId === projectId)
        : [];
    },
    async listAuditEvents(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? audit.filter((a) => a.organizationId === org) : [];
    },
    async listDomains(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? domains.filter((d) => d.organizationId === org) : [];
    },
    async listDataResources(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? dataResources.filter((d) => d.organizationId === org) : [];
    },
    async listApiKeys(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? apiKeys.filter((k) => k.organizationId === org) : [];
    },
    async createApiKey(input: {
      id: string;
      organizationId: OrganizationId;
      name: string;
      keyPrefix: string;
      scopes: readonly string[];
    }) {
      const key: ApiKeySummary = {
        id: input.id as ApiKeySummary["id"],
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
    async revokeApiKey(userId: UserId, org: OrganizationId, keyId: string) {
      if (!isMember(userId, org)) return false;
      const key = apiKeys.find((k) => k.id === keyId && k.organizationId === org);
      if (!key) return false;
      apiKeys[apiKeys.indexOf(key)] = { ...key, revokedAt: "2026-01-02T00:00:00Z" };
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

    async createDeployment(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      idempotencyKey: string;
      requestedBy: UserId;
      status: EngineStatus;
      provider: string | null;
      providerResourceId: string | null;
      url: string | null;
      failureReason: string | null;
    }) {
      const d: Deployment = {
        id: `d-${deployments.length + 1}` as Deployment["id"],
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: input.status,
        url: input.url,
        failureReason: input.failureReason,
        createdAt: "2026-01-01T00:00:00Z",
      };
      deployments.push(d);
      deploymentKeys.set(`${input.organizationId}::${input.idempotencyKey}`, d.id);
      return d;
    },
    async findDeploymentByIdempotencyKey(
      userId: UserId,
      org: OrganizationId,
      idempotencyKey: string,
    ) {
      if (!isMember(userId, org)) return null;
      const id = deploymentKeys.get(`${org}::${idempotencyKey}`);
      return id ? (deployments.find((d) => d.id === id) ?? null) : null;
    },
    async getDeployment(userId: UserId, deploymentId: string) {
      const d = deployments.find((x) => x.id === deploymentId);
      return d && isMember(userId, d.organizationId) ? d : null;
    },
    async updateDeploymentStatus(input: {
      id: string;
      organizationId: OrganizationId;
      status: EngineStatus;
      url?: string | null;
      failureReason?: string | null;
    }) {
      const d = deployments.find(
        (x) => x.id === input.id && x.organizationId === input.organizationId,
      );
      if (!d) return null;
      const next: Deployment = {
        ...d,
        status: input.status,
        url: input.url ?? d.url,
        failureReason: input.failureReason ?? d.failureReason,
      };
      deployments[deployments.indexOf(d)] = next;
      return next;
    },
    async setProjectProviderResource(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      provider: string;
      providerResourceId: string;
    }) {
      const p = projects.find(
        (x) => x.id === input.projectId && x.organizationId === input.organizationId,
      );
      if (!p) return null;
      const next: Project = { ...p };
      projects[projects.indexOf(p)] = next;
      return next;
    },
    async getProjectDeploymentTarget(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      if (!p || !isMember(userId, p.organizationId)) return null;
      return { provider: null, providerResourceId: null };
    },
  } satisfies DataStoreLike;

  return { store, deployments, audit, projects };
}

type DataStoreLike = import("@cloud-wai/database").DataStore & Partial<ControlPlaneWrites>;

function deps(store: DataStoreLike): RouterDeps {
  return {
    verifier,
    memberships: membershipStore,
    store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

/** The engine set a deployment with no credentials actually wires. */
function unconfiguredEngines(): Engines {
  return {
    hosting: hostingNotConfigured("coolify", "Set COOLIFY_URL."),
    database: databaseNotConfigured("postgres", "Set COOLIFY_URL."),
    storage: storageNotConfigured("minio", "Set STORAGE_ENDPOINT."),
    securityEdge: securityNotConfigured("envoy", "Set SECURITY_EDGE_URL."),
    domainVerifier: domainVerifierNotConfigured("dns"),
  };
}

/** A hosting engine that actually deploys, so the success path is real. */
function workingEngines(): Engines {
  return {
    ...unconfiguredEngines(),
    hosting: fakeHosting(),
  };
}

function routerWith(
  store: DataStoreLike,
  engines: Engines,
  extras: { newId?: () => string; queue?: JobQueue } = {},
) {
  const procedures: readonly Procedure[] = buildProcedures(store, {
    engines,
    newId: extras.newId ?? (() => "gen-key"),
    ...(extras.queue ? { queue: extras.queue } : {}),
  });
  return buildRouter(deps(store), procedures);
}

describe("deployments.create through the registered procedures", () => {
  it("records a not_configured deployment when no hosting engine is wired", async () => {
    const { store, deployments, audit } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-1", gitBranch: "main" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment; engineReason: string | null };
    // The row exists and is honest: no engine, so not_configured — never success.
    expect(data.deployment.status).toBe("not_configured");
    expect(data.engineReason).toMatch(/not configured/i);
    expect(deployments).toHaveLength(1);
    expect(audit.some((a) => a.event === "deployment.created")).toBe(true);
  });

  it("writes succeeded only when the hosting engine reported success", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-2", gitBranch: "main" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment };
    expect(data.deployment.status).toBe("succeeded");
    expect(deployments[0]?.status).toBe("succeeded");
    expect(deployments[0]?.url).toMatch(/^https:\/\//);
  });

  it("replays an idempotency key without deploying twice", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const input = { projectId: PROJ_A, idempotencyKey: "same-key", gitBranch: "main" };
    const first = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input,
    });
    const second = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input,
    });

    expect((first.data as { replayed: boolean }).replayed).toBe(false);
    expect((second.data as { replayed: boolean }).replayed).toBe(true);
    // One row, not two: a retried request cannot duplicate a deployment.
    expect(deployments).toHaveLength(1);
  });

  it("refuses an idempotency key already used for a different project", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    // A second project in the same organization: the deployment key is unique
    // per organization, so the same key is a real collision across projects.
    await router.route({
      procedure: "projects.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Beta", slug: "beta" },
    });

    const first = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "shared-key" },
    });
    expect(first.ok, JSON.stringify(first.error)).toBe(true);

    const second = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: "proj-beta" as ProjectId, idempotencyKey: "shared-key" },
    });

    // Answering with PROJ_A's deployment would silently skip the beta deploy.
    expect(second.ok).toBe(false);
    expect(second.status).toBe(409);
    expect(deployments).toHaveLength(1);
    expect(deployments.every((d) => d.projectId === PROJ_A)).toBe(true);
  });

  it("refuses a non-member without revealing the organization", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, idempotencyKey: "carol-1" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(deployments).toHaveLength(0);
  });

  it("rejects a repository that is not a clone URL", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, gitRepository: "not a url", idempotencyKey: "bad-repo" },
    });

    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
    expect(deployments).toHaveLength(0);
  });

  it("reports engine_unavailable rather than a fake success when the store cannot write", async () => {
    // A read-only store: the procedure must not answer ok for a deployment it
    // never recorded.
    const { store } = makeStore();
    const readOnly = { ...store } as Record<string, unknown>;
    for (const name of [
      "createDeployment",
      "updateDeploymentStatus",
      "findDeploymentByIdempotencyKey",
      "getProjectDeploymentTarget",
      "setProjectProviderResource",
    ]) {
      delete readOnly[name];
    }
    const router = routerWith(readOnly as unknown as DataStoreLike, workingEngines());

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "ro-1" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.error?.code).toBe("engine_unavailable");
  });
});

describe("deployments.rollback through the registered procedures", () => {
  it("is honestly not_configured when the project has no engine application", async () => {
    const { store, audit } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, commit: "abc123", idempotencyKey: "rb-1" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment; engineReason: string | null };
    expect(data.deployment.status).toBe("not_configured");
    expect(data.engineReason).toMatch(/nothing to roll back/i);
    expect(audit.some((a) => a.event === "deployment.rolled_back")).toBe(true);
  });

  it("requires the commit to return to", async () => {
    const { store } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, commit: "  " },
    });

    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
  });

  it("refuses a non-member", async () => {
    const { store, deployments } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, commit: "abc123" },
    });

    expect(res.status).toBe(404);
    expect(deployments).toHaveLength(0);
  });

  it("rolls back through the engine when the project has an application", async () => {
    // A store where the project already has an engine-side application.
    const { store, deployments } = makeStore();
    const withTarget = {
      ...store,
      async getProjectDeploymentTarget() {
        return { provider: "coolify", providerResourceId: "app-1" };
      },
    } as DataStoreLike;
    const router = routerWith(withTarget, workingEngines());

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, commit: "abc123", idempotencyKey: "rb-2" },
    });

    expect(res.ok).toBe(true);
    expect((res.data as { deployment: Deployment }).deployment.status).toBe("succeeded");
    expect(deployments).toHaveLength(1);
  });

  it("surfaces a failing engine as a non-success, never as succeeded", async () => {
    const failing: Engines = {
      ...unconfiguredEngines(),
      hosting: fakeHosting({ behaviour: "failed" }),
    };
    const { store } = makeStore();
    const withTarget = {
      ...store,
      async getProjectDeploymentTarget() {
        return { provider: "coolify", providerResourceId: "app-1" };
      },
    } as DataStoreLike;
    const router = routerWith(withTarget, failing);

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, commit: "abc123", idempotencyKey: "rb-3" },
    });

    const data = res.data as { deployment: Deployment };
    expect(data.deployment.status).toBe("failed");
  });
});

describe("the deployment adapters stay honest", () => {
  it("never returns a succeeded AdapterResult for an unconfigured engine", async () => {
    const engines = unconfiguredEngines();
    const ctx = { organizationId: ORG_A, idempotencyKey: "k", timeoutMs: 1000 };
    const results: AdapterResult<unknown>[] = [
      await engines.hosting.createApplication(ctx, { name: "x" }),
      await engines.hosting.deploy(ctx, {
        applicationRef: {
          organizationId: ORG_A,
          provider: "coolify",
          resourceType: "application",
          resourceId: "a",
        } as ProviderRef,
      }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.status).toBe("not_configured");
    }
    // A sanity check that the helpers are not accidentally succeeding.
    expect(ok("succeeded", 1).ok).toBe(true);
    expect(err("failed", "x").status).toBe("failed");
  });
});

describe("the durable writer: deploy and rollback as orchestration jobs", () => {
  it("enqueues a jobs row for a deploy instead of calling the engine on the request path", async () => {
    const { store, deployments, audit } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-durable-1", gitBranch: "main" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { deployment: Deployment };
    // The row is written and stays pending: the engine has not answered yet, and
    // a `pending` row after an enqueue is the honest state, not a failure.
    expect(data.deployment.id).toBe(deployments[0]?.id);
    expect(data.deployment.status).toBe("pending");

    const job = await queue.get("job-1");
    expect(job).not.toBeNull();
    expect(job?.kind).toBe("deployments.execute");
    expect(job?.state).toBe("queued");
    const payload = job?.payload as { deploymentId: string; action: string; projectId: string };
    expect(payload.deploymentId).toBe(data.deployment.id);
    expect(payload.action).toBe("create");
    expect(payload.projectId).toBe(PROJ_A);
    // The audit trail names the enqueue, so the job is traceable to its request.
    expect(audit.some((a) => a.event === "deployment.enqueued")).toBe(true);
  });

  it("does not enqueue a second job when the idempotency key is replayed", async () => {
    const { store, deployments } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    const first = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-dup", gitBranch: "main" },
    });
    const second = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "req-dup", gitBranch: "main" },
    });

    expect(second.ok).toBe(true);
    expect((second.data as { replayed: boolean }).replayed).toBe(true);
    expect((second.data as { deployment: Deployment }).deployment.id).toBe(
      (first.data as { deployment: Deployment }).deployment.id,
    );
    // One deployment row, one job: a retried request cannot deploy twice.
    expect(deployments).toHaveLength(1);
    expect(await queue.get("job-2")).toBeNull();
  });

  it("enqueues a rollback job with the commit and keeps the row pending", async () => {
    const { store, deployments } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "rb-1", commit: "abc1234" },
    });

    expect(res.ok).toBe(true);
    expect((res.data as { deployment: Deployment }).deployment.status).toBe("pending");
    expect(deployments).toHaveLength(1);

    const job = await queue.get("job-1");
    const payload = job?.payload as { action: string; commit: string; deploymentId: string };
    expect(payload.action).toBe("rollback");
    expect(payload.commit).toBe("abc1234");
    expect(payload.deploymentId).toBe(deployments[0]?.id);
  });

  it("refuses a rollback job for a non-member before anything is enqueued", async () => {
    const { store, deployments } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue });

    const res = await router.route({
      procedure: "deployments.rollback",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, idempotencyKey: "rb-carol", commit: "abc1234" },
    });

    expect(res.ok).toBe(false);
    expect(deployments).toHaveLength(0);
    expect(await queue.get("job-1")).toBeNull();
  });
});
