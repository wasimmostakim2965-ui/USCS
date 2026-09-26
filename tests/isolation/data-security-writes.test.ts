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
  UsageRecord,
  AuditEvent,
  AuditEventInput,
  ControlPlaneWrites,
  DataBackup,
  DataBackupCreateInput,
  DataBackupStatusInput,
  DataRestore,
  DataRestoreCreateInput,
  DataRestoreStatusInput,
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
  SecurityRule,
  SecurityRuleCreateInput,
  SecurityEvent,
  TrustedSource,
  TrustedSourceCreateInput,
  RateLimit,
  RateLimitCreateInput,
} from "@cloud-wai/database";
import type { AdapterContext, JobQueue, SecurityEdgeAdapter, Engines } from "@cloud-wai/adapters";
import {
  databaseNotConfigured,
  fakeDatabase,
  hostingNotConfigured,
  InMemoryJobQueue,
  securityNotConfigured,
  serverlessNotConfigured,
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
  buildRestoreApplier,
  buildRestoreJobHandler,
  BACKUP_JOB_KIND,
  POLICY_JOB_KIND,
  RESTORE_JOB_KIND,
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
  const restores: DataRestore[] = [];
  const policies: SecurityPolicy[] = [];
  const policyEvents: SecurityPolicyEvent[] = [];
  const securityRules: SecurityRule[] = [];
  const trustedSources: TrustedSource[] = [];
  const rateLimits: RateLimit[] = [];
  const securityEvents: SecurityEvent[] = [];
  const audit: AuditEvent[] = [];
  const deployments: Deployment[] = [];
  const domains: Domain[] = [];
  const apiKeys: ApiKeySummary[] = [];
  const usage: UsageRecord[] = [];

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
    async listUsageRecords(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? usage.filter((u) => u.organizationId === org) : [];
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
    async getDataBackupForService(organizationId: OrganizationId, backupId: string) {
      return backups.find((b) => b.id === backupId && b.organizationId === organizationId) ?? null;
    },
    async createDataRestore(input: DataRestoreCreateInput) {
      const restore: DataRestore = {
        id: input.id,
        organizationId: input.organizationId,
        backupId: input.backupId,
        dataResourceId: input.dataResourceId,
        provider: input.provider,
        providerResourceId: null,
        status: input.status,
        createdAt: nextTime(),
        finishedAt: null,
      };
      restores.push(restore);
      return restore;
    },
    async updateDataRestoreStatus(input: DataRestoreStatusInput) {
      const r = restores.find(
        (x) => x.id === input.id && x.organizationId === input.organizationId,
      );
      if (!r) return null;
      const next: DataRestore = {
        ...r,
        status: input.status,
        providerResourceId: input.providerResourceId ?? r.providerResourceId,
        finishedAt: input.finishedAt ?? r.finishedAt,
      };
      restores[restores.indexOf(r)] = next;
      return next;
    },
    async listDataRestores(userId: UserId, resourceId: DataResourceId) {
      const r = resources.find((x) => x.id === resourceId);
      if (!r || !isMember(userId, r.organizationId)) return [];
      return restores.filter((x) => x.dataResourceId === resourceId);
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
        protectionMode: input.protectionMode,
        protectionExpiresAt: input.protectionExpiresAt,
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
    async listSecurityRules(userId: UserId, org: OrganizationId) {
      if (!isMember(userId, org)) return [];
      return securityRules.filter((r) => r.organizationId === org);
    },
    async listSecurityEvents(userId: UserId, org: OrganizationId, limit = 100) {
      if (!isMember(userId, org)) return [];
      return securityEvents
        .filter((e) => e.organizationId === org)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
        .slice(0, limit);
    },
    async createSecurityRule(input: SecurityRuleCreateInput) {
      const rule: SecurityRule = {
        id: input.id,
        organizationId: input.organizationId,
        kind: input.kind,
        value: input.value,
        note: input.note,
        createdBy: input.createdBy,
        createdAt: nextTime(),
      };
      securityRules.push(rule);
      return rule;
    },
    async deleteSecurityRule(userId: UserId, org: OrganizationId, ruleId: string) {
      if (!isMember(userId, org)) return false;
      const index = securityRules.findIndex((r) => r.id === ruleId && r.organizationId === org);
      if (index < 0) return false;
      securityRules.splice(index, 1);
      return true;
    },
    async listTrustedSources(userId: UserId, org: OrganizationId) {
      if (!isMember(userId, org)) return [];
      return trustedSources.filter((s) => s.organizationId === org);
    },
    async createTrustedSource(input: TrustedSourceCreateInput) {
      const source: TrustedSource = {
        id: input.id,
        organizationId: input.organizationId,
        kind: input.kind,
        value: input.value,
        note: input.note,
        createdBy: input.createdBy,
        createdAt: nextTime(),
      };
      trustedSources.push(source);
      return source;
    },
    async deleteTrustedSource(userId: UserId, org: OrganizationId, sourceId: string) {
      if (!isMember(userId, org)) return false;
      const index = trustedSources.findIndex((s) => s.id === sourceId && s.organizationId === org);
      if (index < 0) return false;
      trustedSources.splice(index, 1);
      return true;
    },
    async listRateLimits(userId: UserId, org: OrganizationId) {
      if (!isMember(userId, org)) return [];
      return rateLimits.filter((r) => r.organizationId === org);
    },
    async createRateLimit(input: RateLimitCreateInput) {
      const limit: RateLimit = {
        id: input.id,
        organizationId: input.organizationId,
        key: input.key,
        headerName: input.headerName,
        limit: input.limit,
        windowSeconds: input.windowSeconds,
        note: input.note,
        createdBy: input.createdBy,
        createdAt: nextTime(),
      };
      rateLimits.push(limit);
      return limit;
    },
    async deleteRateLimit(userId: UserId, org: OrganizationId, rateLimitId: string) {
      if (!isMember(userId, org)) return false;
      const index = rateLimits.findIndex((r) => r.id === rateLimitId && r.organizationId === org);
      if (index < 0) return false;
      rateLimits.splice(index, 1);
      return true;
    },
  } satisfies DataStoreLike;

  return {
    store,
    resources,
    backups,
    restores,
    policies,
    policyEvents,
    securityRules,
    trustedSources,
    rateLimits,
    securityEvents,
    audit,
  };
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
    serverless: serverlessNotConfigured("lambda", "Set AWS credentials."),
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

describe("data.rotateCredentials through the registered procedures", () => {
  async function provisionPostgres(router: ReturnType<typeof routerWith>) {
    const res = await router.route({
      procedure: "data.provision",
      accessToken: TOKEN_ALICE,
      input: provisionInput(),
    });
    return (res.data as { resource: DataResource }).resource;
  }

  it("rotates a provisioned database, and never returns the new credential", async () => {
    const { store, audit } = makeStore();
    const router = routerWith(store, workingEngines());
    const resource = await provisionPostgres(router);

    const res = await router.route({
      procedure: "data.rotateCredentials",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id, confirmName: resource.name },
    });

    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const body = res.data as { engineReason: string | null };
    expect(body.engineReason).toBeNull();
    // The engine holds the new password; the control plane keeps no copy, so the
    // response carries no credential-shaped field at all.
    expect(JSON.stringify(body)).not.toMatch(/password|secret|credential["']?\s*:/i);
    expect(audit.some((a) => a.event === "data.credentials_rotated")).toBe(true);
  });

  it("refuses rotation until the resource's own name is typed", async () => {
    const { store, audit } = makeStore();
    const router = routerWith(store, workingEngines());
    const resource = await provisionPostgres(router);

    const res = await router.route({
      procedure: "data.rotateCredentials",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id, confirmName: "not-the-name" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(audit.some((a) => a.event === "data.credentials_rotated")).toBe(false);
  });

  it("refuses rotation for a resource with no engine handle", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    const resource = await provisionPostgres(router);
    expect(resource.providerResourceId).toBeNull();

    const res = await router.route({
      procedure: "data.rotateCredentials",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id, confirmName: resource.name },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
  });

  it("refuses to rotate a bucket through the database engine", async () => {
    const { store } = makeStore();
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
    const resource = (provisioned.data as { resource: DataResource }).resource;

    const res = await router.route({
      procedure: "data.rotateCredentials",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id, confirmName: resource.name },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });

  it("refuses a non-member rotating another organization's credentials", async () => {
    const { store, audit } = makeStore();
    const router = routerWith(store, workingEngines());
    const resource = await provisionPostgres(router);

    const res = await router.route({
      procedure: "data.rotateCredentials",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A, resourceId: resource.id, confirmName: resource.name },
    });

    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
    expect(audit.some((a) => a.event === "data.credentials_rotated")).toBe(false);
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

  it("raises the protection posture to attack and clears it on the way back to normal", async () => {
    const { store, policies } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const raised = await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        name: "Block SQLi",
        riskLevel: "high",
        action: "block",
        protectionMode: "attack",
      },
    });
    expect(raised.ok, JSON.stringify(raised.error)).toBe(true);
    expect((raised.data as SecurityPolicy).protectionMode).toBe("attack");

    // Back to normal: the expiry is dropped, so a lapsed posture leaves nothing
    // behind that a later save could resurrect.
    const lowered = await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        name: "Block SQLi",
        riskLevel: "high",
        action: "block",
        protectionMode: "normal",
      },
    });
    const policy = lowered.data as SecurityPolicy;
    expect(policy.protectionMode).toBe("normal");
    expect(policy.protectionExpiresAt).toBeNull();
    expect(policies[0]?.protectionMode).toBe("normal");
  });

  it("keeps a live attack mode across a routine save that does not mention it", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        name: "Block SQLi",
        riskLevel: "high",
        action: "block",
        protectionMode: "attack",
        protectionExpiresAt: "2026-09-25T00:00:00.000Z",
      },
    });
    // A save that only changes the risk level must not drop the posture.
    const res = await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, name: "Block SQLi", riskLevel: "critical", action: "block" },
    });
    const policy = res.data as SecurityPolicy;
    expect(policy.protectionMode).toBe("attack");
    expect(policy.protectionExpiresAt).toBe("2026-09-25T00:00:00.000Z");
  });

  it("refuses an attack window longer than a day, and a malformed one", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const tooLong = await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        name: "Block SQLi",
        riskLevel: "high",
        action: "block",
        protectionMode: "attack",
        protectionExpiresAt: "2027-01-01T00:00:00.000Z",
      },
    });
    expect(tooLong.ok).toBe(false);
    expect(tooLong.status).toBe(400);

    const malformed = await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        name: "Block SQLi",
        riskLevel: "high",
        action: "block",
        protectionMode: "attack",
        protectionExpiresAt: "not-a-date",
      },
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.status).toBe(400);
  });
});

describe("security.rules through the registered procedures", () => {
  it("adds a rule the compiler will emit, and reads it back for a member", async () => {
    const { store, securityRules, audit } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const added = await router.route({
      procedure: "security.rules.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, kind: "ip", value: "203.0.113.9", note: "abuse report" },
    });
    expect(added.ok, JSON.stringify(added.error)).toBe(true);
    expect(securityRules).toHaveLength(1);
    expect(audit.some((a) => a.event === "security_rule.added")).toBe(true);

    const listed = await router.route({
      procedure: "security.rules.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(listed.ok).toBe(true);
    expect(listed.data as readonly SecurityRule[]).toHaveLength(1);
  });

  it("refuses a rule value that would become directive syntax", async () => {
    const { store, securityRules } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const res = await router.route({
      procedure: "security.rules.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, kind: "user-agent", value: 'x" \nSecRuleEngine Off' },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    // Nothing was written, so the compiler never sees it either.
    expect(securityRules).toHaveLength(0);
  });

  it("removes a rule, and reports an absent one honestly", async () => {
    const { store, securityRules } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const added = await router.route({
      procedure: "security.rules.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, kind: "ip", value: "203.0.113.9" },
    });
    const rule = added.data as SecurityRule;

    const removed = await router.route({
      procedure: "security.rules.remove",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, ruleId: rule.id },
    });
    expect(removed.ok).toBe(true);
    expect(securityRules).toHaveLength(0);

    // Removing again is idempotent, not an error, because a retried click must
    // not fail.
    const again = await router.route({
      procedure: "security.rules.remove",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, ruleId: rule.id },
    });
    expect(again.ok).toBe(true);
    expect((again.data as { removed: boolean }).removed).toBe(false);
  });

  it("refuses a member who is not an admin", async () => {
    const { store, securityRules } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    // Dave is only a member of ORG_A (he owns ORG_B), so the admin-only add is
    // refused even though he legitimately belongs to the organization.
    const res = await router.route({
      procedure: "security.rules.add",
      accessToken: TOKEN_DAVE,
      input: { organizationId: ORG_A, kind: "ip", value: "203.0.113.9" },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(securityRules).toHaveLength(0);
  });

  it("lists the verified-bot directory a member can rely on in attack mode", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    const res = await router.route({
      procedure: "security.bots.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const bots = (res.data as { bots: readonly { name: string }[] }).bots;
    expect(bots.some((b) => b.name === "googlebot")).toBe(true);
  });
});

describe("security.trustedSources through the registered procedures", () => {
  it("trusts an address literal the compiler will emit, and reads it back", async () => {
    const { store, trustedSources, audit } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const added = await router.route({
      procedure: "security.trustedSources.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, kind: "cidr", value: "192.0.2.0/24", note: "CI runners" },
    });
    expect(added.ok, JSON.stringify(added.error)).toBe(true);
    expect(trustedSources).toHaveLength(1);
    expect(audit.some((a) => a.event === "security_trusted_source.added")).toBe(true);

    const listed = await router.route({
      procedure: "security.trustedSources.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(listed.ok).toBe(true);
    expect(listed.data as readonly TrustedSource[]).toHaveLength(1);
  });

  it("refuses a trusted value that is not an address literal", async () => {
    const { store, trustedSources } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    // A hostname would have to be resolved, and the DNS answer is
    // attacker-influenced, so it must never become a rule.
    const hostname = await router.route({
      procedure: "security.trustedSources.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, kind: "ip", value: "hooks.example.com" },
    });
    expect(hostname.ok).toBe(false);
    expect(hostname.status).toBe(400);

    const injection = await router.route({
      procedure: "security.trustedSources.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, kind: "cidr", value: '" \nSecRuleEngine Off' },
    });
    expect(injection.ok).toBe(false);
    expect(trustedSources).toHaveLength(0);
  });

  it("removes a trusted source, and reports an absent one honestly", async () => {
    const { store, trustedSources } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const added = await router.route({
      procedure: "security.trustedSources.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, kind: "ip", value: "198.51.100.7" },
    });
    const source = added.data as TrustedSource;

    const removed = await router.route({
      procedure: "security.trustedSources.remove",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, sourceId: source.id },
    });
    expect(removed.ok).toBe(true);
    expect(trustedSources).toHaveLength(0);

    const again = await router.route({
      procedure: "security.trustedSources.remove",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, sourceId: source.id },
    });
    expect(again.ok).toBe(true);
    expect((again.data as { removed: boolean }).removed).toBe(false);
  });

  it("refuses a member who is not an admin", async () => {
    const { store, trustedSources } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    const res = await router.route({
      procedure: "security.trustedSources.add",
      accessToken: TOKEN_DAVE,
      input: { organizationId: ORG_A, kind: "ip", value: "198.51.100.7" },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(trustedSources).toHaveLength(0);
  });

  it("keeps one organization's trusted sources out of another's list", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    await router.route({
      procedure: "security.trustedSources.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, kind: "ip", value: "198.51.100.7" },
    });

    // Dave legitimately belongs to both tenants, so a per-user check alone
    // cannot separate them: the organization scope must. ORG_A's source is
    // visible to him there, and absent from ORG_B's list.
    const inA = await router.route({
      procedure: "security.trustedSources.list",
      accessToken: TOKEN_DAVE,
      input: { organizationId: ORG_A },
    });
    expect(inA.ok, JSON.stringify(inA.error)).toBe(true);
    expect(inA.data as readonly TrustedSource[]).toHaveLength(1);

    const inB = await router.route({
      procedure: "security.trustedSources.list",
      accessToken: TOKEN_DAVE,
      input: { organizationId: ORG_B },
    });
    expect(inB.ok, JSON.stringify(inB.error)).toBe(true);
    expect(inB.data as readonly TrustedSource[]).toHaveLength(0);
  });
});

describe("security.rateLimits through the registered procedures", () => {
  it("sets a per-address limit the compiler will emit, and reads it back", async () => {
    const { store, rateLimits, audit } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const added = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, key: "ip", limit: 60, windowSeconds: 60, note: "Scraper" },
    });
    expect(added.ok, JSON.stringify(added.error)).toBe(true);
    expect(rateLimits).toHaveLength(1);
    expect(audit.some((a) => a.event === "security_rate_limit.added")).toBe(true);

    const listed = await router.route({
      procedure: "security.rateLimits.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(listed.ok).toBe(true);
    expect(listed.data as readonly RateLimit[]).toHaveLength(1);
  });

  it("pairs a header key with its header name, and refuses a half-specified rule", async () => {
    const { store, rateLimits } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const ok = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        key: "header",
        headerName: "x-api-key",
        limit: 1000,
        windowSeconds: 3600,
      },
    });
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    expect(rateLimits[0]!.headerName).toBe("x-api-key");

    // A header key with no header name is half-specified.
    const missing = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, key: "header", limit: 10, windowSeconds: 60 },
    });
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(400);

    // A non-header key that names a header is refused rather than ignored.
    const spurious = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        key: "ip",
        headerName: "x-api-key",
        limit: 10,
        windowSeconds: 60,
      },
    });
    expect(spurious.ok).toBe(false);
    expect(rateLimits).toHaveLength(1);
  });

  it("refuses a second limit for the same key, naming the clash", async () => {
    const { store, rateLimits } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const first = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, key: "ip", limit: 60, windowSeconds: 60 },
    });
    expect(first.ok, JSON.stringify(first.error)).toBe(true);

    // A second ip-keyed limit would leave two competing budgets for the same
    // traffic. It is refused as a conflict with a message the caller can act on,
    // not surfaced as an opaque engine error.
    const duplicate = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, key: "ip", limit: 999, windowSeconds: 60 },
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.status).toBe(409);
    expect(rateLimits).toHaveLength(1);
    expect(rateLimits[0]!.limit).toBe(60);

    // The clash is per key/header pair, not per key alone: a header-keyed limit
    // for a different header is a different budget and is allowed.
    const header = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        key: "header",
        headerName: "x-api-key",
        limit: 600,
        windowSeconds: 60,
      },
    });
    expect(header.ok, JSON.stringify(header.error)).toBe(true);

    const sameHeader = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        key: "header",
        headerName: "x-api-key",
        limit: 5,
        windowSeconds: 60,
      },
    });
    expect(sameHeader.ok).toBe(false);
    expect(sameHeader.status).toBe(409);
    expect(rateLimits).toHaveLength(2);
  });

  it("refuses an out-of-range allowance, so a limit cannot deny everyone", async () => {
    const { store, rateLimits } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const zero = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, key: "ip", limit: 0, windowSeconds: 60 },
    });
    expect(zero.ok).toBe(false);
    expect(zero.status).toBe(400);

    const longWindow = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, key: "ip", limit: 60, windowSeconds: 86_401 },
    });
    expect(longWindow.ok).toBe(false);
    expect(rateLimits).toHaveLength(0);
  });

  it("refuses injection through a header name, never escaping it into a directive", async () => {
    const { store, rateLimits } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    const res = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        key: "header",
        headerName: '" \nSecRuleEngine Off',
        limit: 10,
        windowSeconds: 60,
      },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(rateLimits).toHaveLength(0);
  });

  it("removes a limit, and reports an absent one honestly", async () => {
    const { store, rateLimits } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    const added = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, key: "global", limit: 100000, windowSeconds: 1 },
    });
    const limit = added.data as RateLimit;

    const removed = await router.route({
      procedure: "security.rateLimits.remove",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, rateLimitId: limit.id },
    });
    expect(removed.ok).toBe(true);
    expect(rateLimits).toHaveLength(0);

    const again = await router.route({
      procedure: "security.rateLimits.remove",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, rateLimitId: limit.id },
    });
    expect(again.ok).toBe(true);
    expect((again.data as { removed: boolean }).removed).toBe(false);
  });

  it("refuses a member who is not an admin", async () => {
    const { store, rateLimits } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    const res = await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_DAVE,
      input: { organizationId: ORG_A, key: "ip", limit: 60, windowSeconds: 60 },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(rateLimits).toHaveLength(0);
  });

  it("keeps one organization's limits out of another's list", async () => {
    const { store } = makeStore();
    const router = routerWith(store, unconfiguredEngines());

    await router.route({
      procedure: "security.rateLimits.add",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, key: "ip", limit: 60, windowSeconds: 60 },
    });

    // Dave belongs to both tenants, so only the organization scope can separate
    // them: ORG_A's limit is visible to him there, absent from ORG_B's list.
    const inA = await router.route({
      procedure: "security.rateLimits.list",
      accessToken: TOKEN_DAVE,
      input: { organizationId: ORG_A },
    });
    expect(inA.ok, JSON.stringify(inA.error)).toBe(true);
    expect(inA.data as readonly RateLimit[]).toHaveLength(1);

    const inB = await router.route({
      procedure: "security.rateLimits.list",
      accessToken: TOKEN_DAVE,
      input: { organizationId: ORG_B },
    });
    expect(inB.ok, JSON.stringify(inB.error)).toBe(true);
    expect(inB.data as readonly RateLimit[]).toHaveLength(0);
  });
});

describe("security.events.list through the registered procedures", () => {
  function seedEvent(org: OrganizationId, over: Partial<SecurityEvent> = {}): SecurityEvent {
    const event: SecurityEvent = {
      id: `evt-${org}-${over.observedAt ?? "x"}`,
      organizationId: org,
      host: "app.example.com",
      stage: "block-deny-list",
      action: "block",
      ruleId: 9,
      policyVersion: 3,
      clientIp: "203.0.113.9",
      method: "GET",
      path: "/admin",
      userAgent: "curl/8",
      observedAt: "2026-01-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      ...over,
    };
    return event;
  }

  it("returns only the caller's own organization's decisions, newest first", async () => {
    const { store, securityEvents } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    securityEvents.push(
      seedEvent(ORG_A, { id: "a-old", observedAt: "2026-01-01T00:00:00Z" }),
      seedEvent(ORG_A, { id: "a-new", observedAt: "2026-01-02T00:00:00Z" }),
      seedEvent(ORG_B, { id: "b-only", observedAt: "2026-01-03T00:00:00Z" }),
    );

    const res = await router.route({
      procedure: "security.events.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const events = (res.data as { events: readonly SecurityEvent[] }).events;
    expect(events.map((e) => e.id)).toEqual(["a-new", "a-old"]);
  });

  it("refuses a caller who is not a member of the organization", async () => {
    const { store, securityEvents } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    securityEvents.push(seedEvent(ORG_A, { id: "a-only" }));

    // Carol belongs to no organization, so the read is refused by the guard.
    const res = await router.route({
      procedure: "security.events.list",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A },
    });
    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
  });

  it("never returns another tenant's rows, even for a caller who belongs to both", async () => {
    const { store, securityEvents } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    securityEvents.push(seedEvent(ORG_A, { id: "a-only" }), seedEvent(ORG_B, { id: "b-only" }));

    // Dave belongs to A and B. Asking for B must return only B's rows.
    const res = await router.route({
      procedure: "security.events.list",
      accessToken: TOKEN_DAVE,
      input: { organizationId: ORG_B },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const events = (res.data as { events: readonly SecurityEvent[] }).events;
    expect(events.map((e) => e.id)).toEqual(["b-only"]);
  });

  it("honours the limit window", async () => {
    const { store, securityEvents } = makeStore();
    const router = routerWith(store, unconfiguredEngines());
    for (let i = 0; i < 5; i += 1) {
      securityEvents.push(
        seedEvent(ORG_A, {
          id: `a-${i}`,
          observedAt: `2026-01-0${i + 1}T00:00:00Z`,
        }),
      );
    }
    const res = await router.route({
      procedure: "security.events.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, limit: 2 },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect((res.data as { events: readonly SecurityEvent[] }).events).toHaveLength(2);
  });

  it("answers with the honest engine_unavailable when the store cannot read events", async () => {
    const { store } = makeStore();
    // A deployment that predates the read: the method is absent.
    const withoutRead = { ...store } as Record<string, unknown>;
    delete withoutRead.listSecurityEvents;
    const router = routerWith(withoutRead as DataStoreLike, unconfiguredEngines());
    const res = await router.route({
      procedure: "security.events.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(res.error?.message).toContain("cannot read edge decisions");
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

  function workerOver(
    store: DataStoreLike,
    engines: Engines,
    queue: JobQueue,
    newId: () => string,
  ) {
    const backupWrites = {
      getDataResourceForService: (org: OrganizationId, resourceId: DataResourceId) =>
        store.getDataResourceForService!(org, resourceId),
      updateDataBackupStatus: (input: DataBackupStatusInput) =>
        store.updateDataBackupStatus!(input),
      recordAuditEvent: (input: AuditEventInput) => store.recordAuditEvent(input),
    };
    const restoreWrites = {
      getDataResourceForService: (org: OrganizationId, resourceId: DataResourceId) =>
        store.getDataResourceForService!(org, resourceId),
      getDataBackupForService: (org: OrganizationId, backupId: string) =>
        store.getDataBackupForService!(org, backupId),
      updateDataRestoreStatus: (input: DataRestoreStatusInput) =>
        store.updateDataRestoreStatus!(input),
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
        [BACKUP_JOB_KIND]: buildBackupJobHandler({
          database: engines.database,
          writes: backupWrites,
        }),
        [RESTORE_JOB_KIND]: buildRestoreJobHandler({
          database: engines.database,
          writes: restoreWrites,
        }),
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
        buildRestoreApplier({ database: engines.database, writes: restoreWrites }),
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

  it("preserves the attack posture through distribution, not just the save", async () => {
    const { store, policies } = makeStore();
    const queue = new InMemoryJobQueue();
    const engines = workingSecurityEngines(edgeAnswering(() => ok("succeeded", { version: 1 })));
    const router = routerWith(store, engines, { queue, newId: () => "gen" });

    await router.route({
      procedure: "security.policy.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        name: "Under attack",
        riskLevel: "critical",
        action: "challenge",
        protectionMode: "attack",
      },
    });
    await router.route({
      procedure: "security.policy.distribute",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });

    await workerOver(store, engines, queue, () => "evt").drain();
    // The activation write carries the posture: a distribution must not quietly
    // drop the attack mode the customer turned on.
    expect(policies[0]?.state).toBe("active");
    expect(policies[0]?.protectionMode).toBe("attack");
  });

  /**
   * `data.restore` — matrix B5 / gate 9. The adapter's `restore` existed and was
   * tested in isolation, but no procedure reached it. These tests prove the
   * procedure exists, is a durable job, and refuses every dishonest path: a
   * backup of another tenant, a backup that never completed, and a confirmation
   * that does not echo the database name.
   */
  async function provisionAndBackup(
    router: ReturnType<typeof routerWith>,
    queue: InMemoryJobQueue,
    store: DataStoreLike,
    engines: Engines,
  ) {
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
    // Drain so the backup reaches `succeeded` and gets an engine handle: a
    // restore only accepts a completed backup. The same engine instance takes
    // the backup and the restore, so the restore can find the artifact.
    await workerOver(store, engines, queue, () => "evt").drain();
    return resource;
  }

  it("restores from a completed backup and mirrors the engine's handle", async () => {
    const { store, backups, restores } = makeStore();
    const queue = new InMemoryJobQueue();
    const engines = workingEngines();
    const router = routerWith(store, engines, { queue, newId: () => "gen" });

    const resource = await provisionAndBackup(router, queue, store, engines);
    const backup = backups[0]!;
    expect(backup.status).toBe("succeeded");

    const res = await router.route({
      procedure: "data.restore",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        resourceId: resource.id,
        backupId: backup.id,
        confirmName: "tenant-db",
      },
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect((res.data as { restore: DataRestore }).restore.status).toBe("pending");
    expect(restores[0]?.status).toBe("pending");

    const job = await queue.get("job-2");
    expect(job?.kind).toBe(RESTORE_JOB_KIND);
    expect((job?.payload as { restoreId?: string }).restoreId).toBe(restores[0]?.id);

    const outcomes = await workerOver(store, engines, queue, () => "evt").drain();
    expect(outcomes[0]?.status).toBe("succeeded");
    expect(restores[0]?.status).toBe("succeeded");
    expect(restores[0]?.providerResourceId).toBeTruthy();
  });

  it("refuses a restore unless the operator echoes the database name", async () => {
    const { store, backups, restores } = makeStore();
    const queue = new InMemoryJobQueue();
    const engines = workingEngines();
    const router = routerWith(store, engines, { queue, newId: () => "gen" });
    const resource = await provisionAndBackup(router, queue, store, engines);

    const res = await router.route({
      procedure: "data.restore",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        resourceId: resource.id,
        backupId: backups[0]!.id,
        confirmName: "not-the-name",
      },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(restores).toHaveLength(0);
    expect(await queue.get("job-2")).toBeNull();
  });

  it("refuses a restore from a backup that never completed", async () => {
    const { store, backups, restores } = makeStore();
    const queue = new InMemoryJobQueue();
    const engines = workingEngines();
    const router = routerWith(store, engines, { queue, newId: () => "gen" });

    // Provision, then back up WITHOUT draining: the row stays `pending` and has
    // no engine handle, so there is nothing to restore from.
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
    expect(backups[0]?.status).toBe("pending");

    const res = await router.route({
      procedure: "data.restore",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        resourceId: resource.id,
        backupId: backups[0]!.id,
        confirmName: "tenant-db",
      },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(restores).toHaveLength(0);
  });

  it("refuses a restore from a backup that names no artifact", async () => {
    const { store, restores } = makeStore();
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
      procedure: "data.restore",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        resourceId: resource.id,
        // A backup id that belongs to no resource in ORG_A.
        backupId: "b-does-not-exist",
        confirmName: "tenant-db",
      },
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(restores).toHaveLength(0);
  });

  it("refuses a non-member's restore before anything is enqueued", async () => {
    const { store, backups, restores } = makeStore();
    const queue = new InMemoryJobQueue();
    const engines = workingEngines();
    const router = routerWith(store, engines, { queue, newId: () => "gen" });
    const resource = await provisionAndBackup(router, queue, store, engines);

    const res = await router.route({
      procedure: "data.restore",
      accessToken: TOKEN_CAROL,
      input: {
        organizationId: ORG_A,
        resourceId: resource.id,
        backupId: backups[0]!.id,
        confirmName: "tenant-db",
      },
    });
    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
    expect(restores).toHaveLength(0);
  });

  it("lists a resource's restores, scoped to a member", async () => {
    const { store, backups, restores } = makeStore();
    const queue = new InMemoryJobQueue();
    const engines = workingEngines();
    const router = routerWith(store, engines, { queue, newId: () => "gen" });
    const resource = await provisionAndBackup(router, queue, store, engines);
    await router.route({
      procedure: "data.restore",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        resourceId: resource.id,
        backupId: backups[0]!.id,
        confirmName: "tenant-db",
      },
    });

    const listed = await router.route({
      procedure: "data.restores.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });
    expect(listed.ok).toBe(true);
    expect((listed.data as DataRestore[]).length).toBe(restores.length);

    const asOutsider = await router.route({
      procedure: "data.restores.list",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A, resourceId: resource.id },
    });
    expect(asOutsider.ok).toBe(false);
  });
});
