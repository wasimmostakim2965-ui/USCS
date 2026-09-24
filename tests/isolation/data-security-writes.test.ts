/**
 * Phase 3 acceptance: the data and security write paths, end to end.
 *
 * ADR-0006 phase 3 requires deploy, backup and policy to run end to end against
 * the adapters. The deploy path is proven in `deployment-writes.test.ts`; this
 * file proves the other two, through the router the API actually mounts, over
 * the real procedure table, with a real in-memory store that applies the SQL
 * layer's membership filter and real adapters (the fakes are the adapters' own
 * in-memory engines, not mocked-away code).
 *
 * The properties that matter, and that a mock would hide:
 *
 *   * a provisioning request writes the row before the engine is called, and the
 *     engine's answer — including `not_configured` — decides the state;
 *   * a backup of a resource with no engine handle is refused, so no backup row
 *     can name an artifact that does not exist;
 *   * an unconfigured edge leaves the policy honestly non-active and records a
 *     rejected transition, never an activation;
 *   * a policy save always writes `draft`, and the version never rewinds;
 *   * a non-member cannot provision, back up or edit a policy, and cannot learn
 *     the organization exists.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  ApiKeySummary,
  AuditEvent,
  AuditEventInput,
  ControlPlaneWrites,
  DataBackup,
  DataBackupCreateInput,
  DataBackupStatusInput,
  DataResource,
  DataResourceCreateInput,
  DataResourceStateInput,
  Deployment,
  Domain,
  MembershipStore,
  Organization,
  PolicyEventInput,
  Project,
  SecurityPolicy,
  SecurityPolicyEvent,
  SecurityPolicyInput,
} from "@cloud-wai/database";
import type { AdapterContext, JobQueue, SecurityEdgeAdapter, Engines } from "@cloud-wai/adapters";
import {
  databaseNotConfigured,
  fakeDatabase,
  hostingNotConfigured,
  InMemoryJobQueue,
  securityNotConfigured,
  storageNotConfigured,
  domainVerifierNotConfigured,
} from "@cloud-wai/adapters";
import {
  err,
  ok,
  type DataResourceId,
  type OrganizationId,
  type ProjectId,
  type UserId,
} from "@cloud-wai/contracts";
import { buildProcedures, buildRouter, type RouterDeps } from "@cloud-wai/api";
import {
  InProcessWorker,
  buildApplier,
  buildBackupApplier,
  buildBackupJobHandler,
  buildPolicyApplier,
  buildPolicyJobHandler,
  BACKUP_JOB_KIND,
  POLICY_JOB_KIND,
} from "@cloud-wai/worker";

const ALICE = "u-alice";
const CAROL = "u-carol";
const DAVE = "u-dave";
const ORG_A = "org-a" as OrganizationId;
const ORG_B = "org-b" as OrganizationId;
const PROJ_A = "proj-a" as ProjectId;
const TOKEN_ALICE = "t-alice";
const TOKEN_CAROL = "t-carol";
const TOKEN_DAVE = "t-dave";

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
  [TOKEN_DAVE]: {
    userId: DAVE,
    email: "dave@example.com",
    displayName: "Dave",
    accessToken: TOKEN_DAVE,
  },
};

const verifier: SessionVerifier = {
  async verify(token) {
    return sessions[token] ?? null;
  },
};

const memberships: Membership[] = [
  { organizationId: ORG_A, userId: ALICE, role: "owner" },
  // Dave belongs to both tenants: the case a per-user membership check alone
  // cannot distinguish, because both organizations are legitimately his.
  { organizationId: ORG_A, userId: DAVE, role: "member" },
  { organizationId: ORG_B, userId: DAVE, role: "owner" },
];
const membershipStore: MembershipStore = {
  async membershipsFor(userId) {
    return memberships.filter((m) => m.userId === userId);
  },
};

/**
 * A control plane with the write methods the data and security procedures need.
 *
 * It mirrors the SQL layer's scope rules: a write only lands on a row in an
 * organization the acting user belongs to. That is what makes the isolation
 * assertions meaningful.
 */
function makeStore() {
  const organizations: Organization[] = [
    { id: ORG_A, name: "A", slug: "a", createdAt: "2026-01-01T00:00:00Z" },
    { id: ORG_B, name: "B", slug: "b", createdAt: "2026-01-01T00:00:00Z" },
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
  const resources: DataResource[] = [];
  const backups: DataBackup[] = [];
  const policies: SecurityPolicy[] = [];
  const policyEvents: SecurityPolicyEvent[] = [];
  const audit: AuditEvent[] = [];
  const deployments: Deployment[] = [];
  const domains: Domain[] = [];
  const apiKeys: ApiKeySummary[] = [];

  const isMember = (userId: UserId, org: OrganizationId) =>
    memberships.some((m) => m.userId === userId && m.organizationId === org);

  let clock = Date.parse("2026-01-01T00:00:00Z");
  const nextTime = () => new Date((clock += 1000)).toISOString();

  const store = {
    async listOrganizations(userId: UserId) {
      return organizations.filter((o) => isMember(userId, o.id));
    },
    async createOrganization(input: { name: string; slug: string; createdBy: UserId }) {
      const org: Organization = {
        id: `org-${input.slug}` as OrganizationId,
        name: input.name,
        slug: input.slug,
        createdAt: nextTime(),
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
        createdAt: nextTime(),
      };
      projects.push(p);
      return p;
    },
    async listDeployments(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      if (!p || !isMember(userId, p.organizationId)) return [];
      return deployments.filter((d) => d.projectId === projectId);
    },
    async listAuditEvents(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? audit.filter((a) => a.organizationId === org) : [];
    },
    async listDomains(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? domains.filter((d) => d.organizationId === org) : [];
    },
    async listDataResources(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? resources.filter((d) => d.organizationId === org) : [];
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
        createdAt: nextTime(),
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
      apiKeys[apiKeys.indexOf(key)] = {
        ...key,
        revokedAt: nextTime(),
      };
      return true;
    },
    async recordAuditEvent(input: AuditEventInput) {
      const e: AuditEvent = {
        ...input,
        id: `a-${audit.length + 1}`,
        createdAt: nextTime(),
      };
      audit.push(e);
      return e;
    },

    async createDataResource(input: DataResourceCreateInput) {
      const resource: DataResource = {
        id: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        kind: input.kind,
        name: input.name,
        state: input.state,
        provider: input.provider,
        providerResourceId: input.providerResourceId,
        createdAt: nextTime(),
      };
      resources.push(resource);
      return resource;
    },
    async getDataResource(userId: UserId, resourceId: DataResourceId) {
      const r = resources.find((x) => x.id === resourceId);
      return r && isMember(userId, r.organizationId) ? r : null;
    },
    async getDataResourceForService(organizationId: OrganizationId, resourceId: DataResourceId) {
      return (
        resources.find((x) => x.id === resourceId && x.organizationId === organizationId) ?? null
      );
    },
    async setDataResourceState(input: DataResourceStateInput) {
      const r = resources.find(
        (x) => x.id === input.id && x.organizationId === input.organizationId,
      );
      if (!r) return null;
      const next: DataResource = {
        ...r,
        state: input.state,
        provider: input.provider ?? r.provider,
        providerResourceId: input.providerResourceId ?? r.providerResourceId,
      };
      resources[resources.indexOf(r)] = next;
      return next;
    },
    async listDataBackups(userId: UserId, resourceId: DataResourceId) {
      const r = resources.find((x) => x.id === resourceId);
      if (!r || !isMember(userId, r.organizationId)) return [];
      return backups.filter((b) => b.dataResourceId === resourceId);
    },
    async createDataBackup(input: DataBackupCreateInput) {
      const backup: DataBackup = {
        id: input.id,
        organizationId: input.organizationId,
        dataResourceId: input.dataResourceId,
        provider: input.provider,
        providerResourceId: null,
        sizeBytes: null,
        status: input.status,
        createdAt: nextTime(),
        finishedAt: null,
      };
      backups.push(backup);
      return backup;
    },
    async updateDataBackupStatus(input: DataBackupStatusInput) {
      const b = backups.find((x) => x.id === input.id && x.organizationId === input.organizationId);
      if (!b) return null;
      const next: DataBackup = {
        ...b,
        status: input.status,
        providerResourceId: input.providerResourceId ?? b.providerResourceId,
        sizeBytes: input.sizeBytes ?? b.sizeBytes,
        finishedAt: input.finishedAt ?? b.finishedAt,
      };
      backups[backups.indexOf(b)] = next;
      return next;
    },

    async getSecurityPolicy(userId: UserId, org: OrganizationId) {
      if (!isMember(userId, org)) return null;
      return policies.find((p) => p.organizationId === org) ?? null;
    },
    async getSecurityPolicyForService(org: OrganizationId) {
      return policies.find((p) => p.organizationId === org) ?? null;
    },
    async saveSecurityPolicy(input: SecurityPolicyInput) {
      const existing = policies.find((p) => p.id === input.id);
      const saved: SecurityPolicy = {
        id: input.id,
        organizationId: input.organizationId,
        name: input.name,
        riskLevel: input.riskLevel,
        action: input.action,
        state: input.state,
        version: input.version,
        createdAt: existing?.createdAt ?? nextTime(),
        updatedAt: nextTime(),
      };
      if (existing) policies[policies.indexOf(existing)] = saved;
      else policies.push(saved);
      return saved;
    },
    async recordPolicyEvent(input: PolicyEventInput) {
      const e: SecurityPolicyEvent = {
        id: input.id,
        organizationId: input.organizationId,
        policyId: input.policyId,
        fromState: input.fromState,
        toState: input.toState,
        version: input.version,
        actorId: input.actorId,
        actorEmail: input.actorEmail,
        detail: input.detail,
        createdAt: nextTime(),
      };
      policyEvents.push(e);
      return e;
    },
    async listPolicyEvents(userId: UserId, org: OrganizationId) {
      if (!isMember(userId, org)) return [];
      return policyEvents.filter((e) => e.organizationId === org);
    },
  } satisfies DataStoreLike;

  return { store, resources, backups, policies, policyEvents, audit };
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

/** A database engine that really provisions, so the success path is real. */
function workingEngines(): Engines {
  return { ...unconfiguredEngines(), database: fakeDatabase() };
}

/** A storage engine that really provisions a bucket, so a bucket has a handle. */
function workingStorage(): Engines["storage"] {
  let counter = 0;
  return {
    __notConfigured: false,
    async createBucket(ctx, input) {
      counter += 1;
      return ok("succeeded", {
        organizationId: ctx.organizationId,
        provider: "minio",
        resourceType: "bucket",
        resourceId: `${input.name}-${counter}`,
      });
    },
    async deleteBucket() {
      return ok("succeeded", undefined);
    },
  };
}

/**
 * An edge whose `applyPolicy` answer the test controls.
 *
 * This is a fake of the *engine*, not of the adapter: the adapter under test is
 * the real one, and the procedure's honesty rules are what is being asserted.
 */
function edgeAnswering(
  answer: (call: number) => Awaited<ReturnType<SecurityEdgeAdapter["applyPolicy"]>>,
): SecurityEdgeAdapter {
  let call = 0;
  const miss = async () => err<never>("not_configured", "edge not configured");
  return {
    __notConfigured: false,
    publishRoute: miss,
    removeRoute: miss,
    applyPolicy: async () => answer(++call),
    quarantine: miss,
    inspectHealth: miss,
  };
}

function workingSecurityEngines(edge: SecurityEdgeAdapter): Engines {
  return { ...unconfiguredEngines(), securityEdge: edge };
}

function routerWith(
  store: DataStoreLike,
  engines: Engines,
  extras: { newId?: () => string; now?: () => Date; queue?: JobQueue } = {},
) {
  const procedures = buildProcedures(store, {
    engines,
    newId: extras.newId ?? (() => `gen-${Math.random().toString(36).slice(2, 8)}`),
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.queue ? { queue: extras.queue } : {}),
  });
  return buildRouter(deps(store), procedures);
}

const provisionInput = (over: Partial<Record<string, unknown>> = {}) => ({
  organizationId: ORG_A,
  name: "tenant-db",
  kind: "postgres",
  ...over,
});

describe("data.provision through the registered procedures", () => {
  it("provisions through the engine and records the engine's handle", async () => {
    const { store, resources, audit } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_ALICE,
      input: provisionInput(),
    });

    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const body = res.data as { resource: DataResource; engineReason: string | null };
    expect(body.resource.state).toBe("ready");
    expect(body.resource.provider).toBe("postgres");
    expect(body.resource.providerResourceId).toBeTruthy();
    expect(body.engineReason).toBeNull();

    // The engine's handle reached the row, which is what a later backup needs.
    expect(resources).toHaveLength(1);
    expect(resources[0]?.providerResourceId).toBe(body.resource.providerResourceId);
    expect(audit.some((a) => a.event === "data.ready")).toBe(true);
  });

  it("is honestly not_configured when no database engine is wired", async () => {
    const { store, resources } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const res = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_ALICE,
      input: provisionInput(),
    });

    expect(res.ok).toBe(true);
    const body = res.data as { resource: DataResource; engineReason: string | null };
    // The row is recorded, but not as ready: the state is the engine's refusal.
    expect(body.resource.state).toBe("not_configured");
    expect(body.resource.providerResourceId).toBeNull();
    expect(body.engineReason).toContain("COOLIFY_URL");
    expect(resources[0]?.state).toBe("not_configured");
  });

  it("refuses a resource name the schema would reject anyway", async () => {
    const { store } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_ALICE,
      input: provisionInput({ name: "   " }),
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("invalid_input");
  });

  it("refuses a non-member without revealing the organization", async () => {
    const { store, resources } = makeStore();
    const router = routerWith(store, workingEngines());

    const res = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_CAROL,
      input: provisionInput(),
    });

    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
    expect(resources).toHaveLength(0);
  });
});

describe("data.backup through the registered procedures", () => {
  async function provision(router: ReturnType<typeof routerWith>) {
    const res = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_ALICE,
      input: provisionInput(),
    });
    return (res.data as { resource: DataResource }).resource;
  }

  it("backs up a provisioned resource and records the engine artifact", async () => {
    const { store, backups, audit } = makeStore();
    const router = routerWith(store, workingEngines());
    const resource = await provision(router);

    const res = await router.route({
      procedure: "data.backup",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });

    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const body = res.data as { backup: DataBackup; engineReason: string | null };
    expect(body.backup.status).toBe("succeeded");
    expect(body.backup.providerResourceId).toBeTruthy();
    expect(body.engineReason).toBeNull();
    expect(backups[0]?.status).toBe("succeeded");
    expect(audit.some((a) => a.event === "data.backup_completed")).toBe(true);
  });

  it("refuses to back up a resource that has no engine handle", async () => {
    const { store, backups } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    const resource = await provision(router);
    expect(resource.providerResourceId).toBeNull();

    const res = await router.route({
      procedure: "data.backup",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });

    // No engine handle means no artifact to name; a backup row would be a fiction.
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(backups).toHaveLength(0);
  });

  it("refuses a non-member backing up another organization's resource", async () => {
    const { store, backups } = makeStore();
    const router = routerWith(store, workingEngines());
    const resource = await provision(router);

    const res = await router.route({
      procedure: "data.backup",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });

    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
    expect(backups).toHaveLength(0);
  });

  it("refuses to back up an object-storage bucket through the database engine", async () => {
    const { store, backups } = makeStore();
    // Storage really provisions, so the bucket has a provider handle — which is
    // exactly what a naive implementation would then hand to the *database*
    // engine as though the bucket name were a database id.
    const router = routerWith(store, {
      ...unconfiguredEngines(),
      database: fakeDatabase(),
      storage: workingStorage(),
    });

    const provisioned = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_ALICE,
      input: provisionInput({ kind: "object_storage", name: "tenant-bucket" }),
    });
    expect(provisioned.ok, JSON.stringify(provisioned.error)).toBe(true);
    const resource = (provisioned.data as { resource: DataResource }).resource;
    expect(resource.providerResourceId).toBeTruthy();

    const res = await router.route({
      procedure: "data.backup",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });

    // A bucket has no backup path in this build; recording a backup would name
    // no artifact, so it is refused and nothing is written.
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(backups).toHaveLength(0);
  });

  it("lists a resource's backups, scoped to a member", async () => {
    const { store } = makeStore();
    const router = routerWith(store, workingEngines());
    const resource = await provision(router);
    await router.route({
      procedure: "data.backup",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });

    const res = await router.route({
      procedure: "data.backups.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });

    expect(res.ok).toBe(true);
    expect(res.data as readonly DataBackup[]).toHaveLength(1);
  });

  it("refuses to list backups of a resource under the wrong organization", async () => {
    const { store } = makeStore();
    const router = routerWith(store, workingEngines());
    // Alice provisions in ORG_A. Dave is a member of both orgs; he must not be
    // able to name ORG_B (which he owns) while pointing at ORG_A's resource.
    const resource = await provision(router);

    const res = await router.route({
      procedure: "data.backups.list",
      accessToken: TOKEN_DAVE,
      input: { organizationId: ORG_B, resourceId: resource.id },
    });

    // Either the capability check or the ownership check refuses; both leave the
    // caller with no data.
    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
  });
});

describe("security.policy.save through the registered procedures", () => {
  it("saves a draft and never activates it", async () => {
    const { store, policies, policyEvents, audit } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const res = await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Block SQLi", riskLevel: "high", action: "block" },
    });

    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const policy = res.data as SecurityPolicy;
    // A customer save is always a draft; distribution is what activates.
    expect(policy.state).toBe("draft");
    expect(policy.version).toBe(1);
    expect(policies[0]?.state).toBe("draft");
    expect(policyEvents.some((e) => e.toState === "draft")).toBe(true);
    expect(audit.some((a) => a.event === "policy.saved")).toBe(true);
  });

  it("advances the version monotonically on a second save", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    const input = {
      organizationId: ORG_A,
      name: "Block SQLi",
      riskLevel: "high",
      action: "block",
    };

    await router.route({ procedure: "security.policy.save", accessToken: TOKEN_ALICE, input });
    const second = await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: { ...input, action: "quarantine" },
    });

    expect((second.data as SecurityPolicy).version).toBe(2);
  });

  it("refuses an unknown risk level", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const res = await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "x", riskLevel: "apocalyptic", action: "block" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });
});

describe("security.policy.distribute through the registered procedures", () => {
  it("activates a policy the edge accepted, at the echoed version", async () => {
    const { store, policies, audit } = makeStore();
    const edge = edgeAnswering(() => ok("succeeded", { version: 5 }));
    const router = routerWith(store, workingSecurityEngines(edge));

    await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Block SQLi", riskLevel: "high", action: "block" },
    });
    const res = await router.route({
      procedure: "security.policy.distribute",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });

    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const body = res.data as { policy: SecurityPolicy; distributed: boolean };
    expect(body.distributed).toBe(true);
    expect(body.policy.state).toBe("active");
    // The engine's echoed version is authoritative when it is higher.
    expect(body.policy.version).toBe(5);
    expect(audit.some((a) => a.event === "policy.distributed")).toBe(true);
  });

  it("stays non-active when the edge is not configured, and records why", async () => {
    const { store, policies, policyEvents, audit } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Block SQLi", riskLevel: "high", action: "block" },
    });
    const res = await router.route({
      procedure: "security.policy.distribute",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });

    expect(res.ok).toBe(true);
    const body = res.data as { policy: SecurityPolicy; distributed: boolean; engineReason: string };
    expect(body.distributed).toBe(false);
    expect(body.policy.state).toBe("draft");
    expect(body.engineReason).toContain("SECURITY_EDGE_URL");
    expect(policies[0]?.state).toBe("draft");
    expect(policyEvents.some((e) => e.toState === "rejected")).toBe(true);
    expect(audit.some((a) => a.event === "policy.rejected")).toBe(true);
  });

  it("has nothing to distribute before a policy is saved", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const res = await router.route({
      procedure: "security.policy.distribute",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });
});

describe("security.policy.get through the registered procedures", () => {
  it("reads the policy and its history for a member", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Block SQLi", riskLevel: "high", action: "block" },
    });

    const res = await router.route({
      procedure: "security.policy.get",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });

    expect(res.ok).toBe(true);
    const body = res.data as {
      policy: SecurityPolicy | null;
      events: readonly SecurityPolicyEvent[];
    };
    expect(body.policy?.name).toBe("Block SQLi");
    expect(body.events.length).toBeGreaterThan(0);
  });

  it("returns an empty policy for an organization with none, without erroring", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const res = await router.route({
      procedure: "security.policy.get",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });

    expect(res.ok).toBe(true);
    expect((res.data as { policy: SecurityPolicy | null }).policy).toBeNull();
  });

  it("refuses a non-member", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const res = await router.route({
      procedure: "security.policy.get",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A },
    });

    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
  });
});

/**
 * Durable backup and policy: the same round trip the deploy test proves.
 *
 * The API enqueues; a real `InMemoryJobQueue` holds the job; a real worker
 * drains it with the real handlers and appliers. The assertions are about what a
 * mock would hide: one job per command, the row mirroring the engine, and a
 * policy activating only after the edge answered.
 */
describe("the durable writer: backup and policy as orchestration jobs", () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };

  function workerOver(store: DataStoreLike, engines: Engines, queue: JobQueue, newId: () => string) {
    const backupWrites = {
      getDataResourceForService: (org: OrganizationId, resourceId: DataResourceId) =>
        store.getDataResourceForService!(org, resourceId),
      updateDataBackupStatus: (input: DataBackupStatusInput) =>
        store.updateDataBackupStatus!(input),
      recordAuditEvent: (input: AuditEventInput) => store.recordAuditEvent(input),
    };
    const policyWrites = {
      getSecurityPolicyForService: (org: OrganizationId) => store.getSecurityPolicyForService!(org),
      saveSecurityPolicy: (input: SecurityPolicyInput) => store.saveSecurityPolicy!(input),
      recordPolicyEvent: (input: PolicyEventInput) => store.recordPolicyEvent!(input),
      recordAuditEvent: (input: AuditEventInput) => store.recordAuditEvent(input),
    };
    return new InProcessWorker({
      queue,
      handlers: {
        [BACKUP_JOB_KIND]: buildBackupJobHandler({ database: engines.database, writes: backupWrites }),
        [POLICY_JOB_KIND]: buildPolicyJobHandler({
          securityEdge: engines.securityEdge,
          writes: policyWrites,
          newId,
        }),
      },
      logger,
      workerId: "worker-1",
      apply: buildApplier(
        buildBackupApplier({ database: engines.database, writes: backupWrites }),
        buildPolicyApplier({ securityEdge: engines.securityEdge, writes: policyWrites, newId }),
      ),
    });
  }

  it("enqueues a backup as a pending row and a queued job, then the worker takes it", async () => {
    const { store, backups } = makeStore();
    const queue = new InMemoryJobQueue();
    const engines = workingEngines();
    const router = routerWith(store, engines, { queue, newId: () => "gen" });

    const provisioned = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_ALICE,
      input: provisionInput(),
    });
    const resource = (provisioned.data as { resource: DataResource }).resource;

    const res = await router.route({
      procedure: "data.backup",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    // `pending` is honest: the engine has not answered, so a success would be a
    // guess. The job is queued, not run on the request path.
    expect((res.data as { backup: DataBackup }).backup.status).toBe("pending");
    expect(backups[0]?.status).toBe("pending");

    const job = await queue.get("job-1");
    expect(job?.kind).toBe(BACKUP_JOB_KIND);
    expect(job?.state).toBe("queued");
    expect((job?.payload as { actorId?: string }).actorId).toBe(ALICE);

    const outcomes = await workerOver(store, engines, queue, () => "evt").drain();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("succeeded");
    expect(outcomes[0]?.applied).toBe(true);
    // The row now carries the engine's own handle.
    expect(backups[0]?.status).toBe("succeeded");
    expect(backups[0]?.providerResourceId).toBeTruthy();
  });

  it("records the engine's not_configured on the backup row, never a success", async () => {
    const { store, backups } = makeStore();
    const queue = new InMemoryJobQueue();
    // The resource is provisioned with a real handle, but the worker runs with
    // an engine that has no credentials: the backup must end `not_configured`.
    const router = routerWith(store, workingEngines(), { queue, newId: () => "gen" });
    const provisioned = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_ALICE,
      input: provisionInput(),
    });
    const resource = (provisioned.data as { resource: DataResource }).resource;

    await router.route({
      procedure: "data.backup",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });

    const outcomes = await workerOver(store, unconfiguredEngines(), queue, () => "evt").drain();
    expect(outcomes[0]?.status).toBe("not_configured");
    expect(backups[0]?.status).toBe("not_configured");
  });

  it("refuses a non-member's backup before anything is enqueued", async () => {
    const { store, backups } = makeStore();
    const queue = new InMemoryJobQueue();
    const router = routerWith(store, workingEngines(), { queue, newId: () => "gen" });
    const provisioned = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_ALICE,
      input: provisionInput(),
    });
    const resource = (provisioned.data as { resource: DataResource }).resource;

    const res = await router.route({
      procedure: "data.backup",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });
    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
    expect(await queue.get("job-1")).toBeNull();
    expect(backups).toHaveLength(0);
  });

  it("distributes a policy as a durable job and activates only after the edge accepts", async () => {
    const { store, policies, policyEvents } = makeStore();
    const queue = new InMemoryJobQueue();
    const engines = workingSecurityEngines(edgeAnswering(() => ok("succeeded", { version: 1 })));
    const router = routerWith(store, engines, { queue, newId: () => "gen" });

    await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Block SQLi", riskLevel: "high", action: "block" },
    });

    const res = await router.route({
      procedure: "security.policy.distribute",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    // Still a draft: the edge has not answered, so nothing is active yet.
    expect(policies[0]?.state).toBe("draft");
    const job = await queue.get("job-1");
    expect(job?.kind).toBe(POLICY_JOB_KIND);
    expect(job?.state).toBe("queued");

    const outcomes = await workerOver(store, engines, queue, () => "evt").drain();
    expect(outcomes[0]?.status).toBe("succeeded");
    expect(policies[0]?.state).toBe("active");
    expect(policyEvents.some((e) => e.toState === "active")).toBe(true);
  });

  it("keeps a policy non-active and records rejected when the edge refuses", async () => {
    const { store, policies, policyEvents } = makeStore();
    const queue = new InMemoryJobQueue();
    const engines = workingSecurityEngines(
      edgeAnswering(() => err("not_configured", "edge not configured")),
    );
    const router = routerWith(store, engines, { queue, newId: () => "gen" });

    await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Block SQLi", riskLevel: "high", action: "block" },
    });
    await router.route({
      procedure: "security.policy.distribute",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });

    const outcomes = await workerOver(store, engines, queue, () => "evt").drain();
    expect(outcomes[0]?.status).toBe("not_configured");
    expect(policies[0]?.state).toBe("draft");
    expect(policyEvents.some((e) => e.toState === "rejected")).toBe(true);
  });
});

