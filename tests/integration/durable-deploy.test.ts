/**
 * ADR-0006 phase 3 acceptance: a deploy as a durable job, API to row.
 *
 * The API's own procedures are mounted over the same in-memory store the
 * deployment-writes test uses, a real `InMemoryJobQueue` stands in for the SQL
 * queue, and a real worker drains it with the real hosting adapter. Nothing is
 * mocked away, because the properties that matter — one job per command, the
 * deployment row mirrors the engine, a refused deploy is not a success — are
 * exactly what a mock would hide.
 *
 * The backup and policy halves of the same acceptance live in
 * `tests/isolation/data-security-writes.test.ts`, whose fixture already models
 * the data-resource and policy tables.
 *
 * The store and verifier fixtures are shared with the isolation test rather than
 * copied, so there is one definition of "a member of org A".
 */
import { describe, expect, it } from "vitest";
import { fakeHosting, InMemoryJobQueue, hostingNotConfigured } from "@cloud-wai/adapters";
import type { Engines } from "@cloud-wai/adapters";
import {
  databaseNotConfigured,
  storageNotConfigured,
  securityNotConfigured,
  serverlessNotConfigured,
  domainVerifierNotConfigured,
} from "@cloud-wai/adapters";
import { buildProcedures, buildRouter, type Procedure, type RouterDeps } from "@cloud-wai/api";
import {
  InProcessWorker,
  buildDeploymentApplier,
  buildDeploymentJobHandler,
  DEPLOYMENT_JOB_KIND,
} from "@cloud-wai/worker";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  ControlPlaneWrites,
  DataStore,
  Deployment,
  Organization,
  Project,
  UsageRecord,
} from "@cloud-wai/database";
import type { OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";

const ALICE = "u-alice";
const ORG_A = "org-a" as OrganizationId;
const PROJ_A = "proj-a" as ProjectId;
const TOKEN_ALICE = "t-alice";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: {
    userId: ALICE,
    email: "alice@example.com",
    displayName: "Alice",
    accessToken: TOKEN_ALICE,
  },
};

const verifier: SessionVerifier = {
  async verify(token) {
    return sessions[token] ?? null;
  },
};

const memberships: Membership[] = [{ organizationId: ORG_A, userId: ALICE, role: "owner" }];

/** The store a durable round trip writes to, mirroring the SQL scope rules. */
function makeStore() {
  const organizations: Organization[] = [
    { id: ORG_A, name: "A", slug: "a", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const projects: Project[] = [
    {
      id: PROJ_A,
      organizationId: ORG_A,
      name: "Alpha",
      slug: "alpha",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const deployments: Deployment[] = [];
  const usage: UsageRecord[] = [];
  // The engine-side target lives outside `Project` (the real store selects it
  // from columns `Project` does not expose), so the fixture keeps its own map.
  const targets = new Map<string, { provider: string | null; providerResourceId: string | null }>();
  const deploymentKeys = new Map<string, string>();
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
    async listAuditEvents() {
      return [];
    },
    async listDomains() {
      return [];
    },
    async listDataResources() {
      return [];
    },
    async listApiKeys() {
      return [];
    },
    async createApiKey(input: {
      id: string;
      organizationId: OrganizationId;
      name: string;
      keyPrefix: string;
      scopes: readonly string[];
    }) {
      return {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        keyPrefix: input.keyPrefix,
        scopes: input.scopes,
        createdAt: "2026-01-01T00:00:00Z",
        lastUsedAt: null,
        revokedAt: null,
      };
    },
    async revokeApiKey() {
      return true;
    },
    async listUsageRecords() {
      return [];
    },
    async recordAuditEvent(input: { id?: string }) {
      return { ...input, id: "a-1", createdAt: "2026-01-01T00:00:00Z" };
    },
    async createDeployment(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      idempotencyKey: string;
      requestedBy: UserId;
      status: Deployment["status"];
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
      status: Deployment["status"];
      url?: string | null;
      failureReason?: string | null;
      providerResourceId?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
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
    async recordUsage(input: { organizationId: OrganizationId; metric: string; quantity: number }) {
      usage.push({
        id: `usage-${usage.length + 1}`,
        organizationId: input.organizationId,
        metric: input.metric,
        quantity: input.quantity,
        recordedAt: "2026-01-01T00:00:00Z",
      });
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
      targets.set(`${input.organizationId}::${input.projectId}`, {
        provider: input.provider,
        providerResourceId: input.providerResourceId,
      });
      return p;
    },
    async getProjectDeploymentTarget(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      if (!p || !isMember(userId, p.organizationId)) return null;
      return (
        targets.get(`${p.organizationId}::${p.id}`) ?? { provider: null, providerResourceId: null }
      );
    },
    async getProjectDeploymentTargetForService(
      organizationId: OrganizationId,
      projectId: ProjectId,
    ) {
      const p = projects.find((x) => x.id === projectId && x.organizationId === organizationId);
      if (!p) return null;
      return (
        targets.get(`${organizationId}::${projectId}`) ?? {
          provider: null,
          providerResourceId: null,
        }
      );
    },
  } satisfies DataStore & Partial<ControlPlaneWrites>;

  return { store, deployments, projects, usage };
}

type StoreLike = DataStore & Partial<ControlPlaneWrites>;

function enginesWith(hosting: Engines["hosting"]): Engines {
  return {
    hosting,
    serverless: serverlessNotConfigured("lambda", "x"),
    database: databaseNotConfigured("postgres", "x"),
    storage: storageNotConfigured("minio", "x"),
    securityEdge: securityNotConfigured("envoy", "x"),
    domainVerifier: domainVerifierNotConfigured("dns"),
  };
}

function deps(store: StoreLike): RouterDeps {
  return {
    verifier,
    memberships: {
      async membershipsFor(userId) {
        return memberships.filter((m) => m.userId === userId);
      },
    },
    store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

describe("deploy is recorded in orchestration_jobs and executed by the worker", () => {
  it("enqueues, then mirrors the engine's own success onto the deployment row", async () => {
    const { store, deployments } = makeStore();
    const queue = new InMemoryJobQueue();
    const hosting = fakeHosting();
    const engines = enginesWith(hosting);

    const procedures: readonly Procedure[] = buildProcedures(store, {
      engines,
      newId: () => "gen",
      queue,
    });
    const router = buildRouter(deps(store), procedures);

    const res = await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "durable-1", gitBranch: "main" },
    });
    expect(res.ok).toBe(true);
    expect(deployments[0]?.status).toBe("pending");

    // The worker drains the queue with the durable handler and the applier.
    const worker = new InProcessWorker({
      queue,
      handlers: {
        [DEPLOYMENT_JOB_KIND]: buildDeploymentJobHandler({
          engines,
          writes: {
            getProjectDeploymentTargetForService: (org, project) =>
              store.getProjectDeploymentTargetForService!(org, project),
            setProjectProviderResource: (input) => store.setProjectProviderResource!(input),
          },
          outcome: {
            updateDeploymentStatus: (input) => store.updateDeploymentStatus!(input),
            recordUsage: (input) => store.recordUsage!(input),
          },
        }),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      workerId: "worker-1",
      apply: buildDeploymentApplier({
        engines,
        writes: {
          getProjectDeploymentTargetForService: (org, project) =>
            store.getProjectDeploymentTargetForService!(org, project),
          setProjectProviderResource: (input) => store.setProjectProviderResource!(input),
        },
        outcome: {
          updateDeploymentStatus: (input) => store.updateDeploymentStatus!(input),
          recordUsage: (input) => store.recordUsage!(input),
        },
      }),
    });

    const outcomes = await worker.drain();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("succeeded");
    expect(outcomes[0]?.applied).toBe(true);

    // The customer-facing row now carries the engine's own result.
    expect(deployments[0]?.status).toBe("succeeded");
    expect(deployments[0]?.url).toMatch(/^https:\/\//);
  });

  it("records not_configured on the deployment row when the engine has no credentials", async () => {
    const { store, deployments } = makeStore();
    const queue = new InMemoryJobQueue();
    const hosting = hostingNotConfigured("coolify", "Set COOLIFY_URL.");
    const engines = enginesWith(hosting);

    const procedures: readonly Procedure[] = buildProcedures(store, {
      engines,
      newId: () => "gen",
      queue,
    });
    const router = buildRouter(deps(store), procedures);

    await router.route({
      procedure: "deployments.create",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, idempotencyKey: "durable-nc", gitBranch: "main" },
    });

    const worker = new InProcessWorker({
      queue,
      handlers: {
        [DEPLOYMENT_JOB_KIND]: buildDeploymentJobHandler({
          engines,
          writes: {
            getProjectDeploymentTargetForService: (org, project) =>
              store.getProjectDeploymentTargetForService!(org, project),
            setProjectProviderResource: (input) => store.setProjectProviderResource!(input),
          },
          outcome: {
            updateDeploymentStatus: (input) => store.updateDeploymentStatus!(input),
            recordUsage: (input) => store.recordUsage!(input),
          },
        }),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      workerId: "worker-1",
      apply: buildDeploymentApplier({
        engines,
        writes: {
          getProjectDeploymentTargetForService: (org, project) =>
            store.getProjectDeploymentTargetForService!(org, project),
          setProjectProviderResource: (input) => store.setProjectProviderResource!(input),
        },
        outcome: {
          updateDeploymentStatus: (input) => store.updateDeploymentStatus!(input),
          recordUsage: (input) => store.recordUsage!(input),
        },
      }),
    });

    const outcomes = await worker.drain();
    expect(outcomes[0]?.status).toBe("not_configured");
    // The job is terminated, and the row says the same thing — nothing pretends
    // the deploy happened.
    expect((await queue.get("job-1"))?.state).toBe("failed");
    expect(deployments[0]?.status).toBe("not_configured");
  });
});
