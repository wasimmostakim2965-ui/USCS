/**
 * @cloud-wai/database — control-plane repositories and migration helpers.
 *
 * This package talks ONLY to the control-plane Supabase PostgreSQL database.
 * Customer tenant databases are a separate data plane and must never be reached
 * from here — that happens through `@cloud-wai/adapters`.
 */
import type {
  ApiKeyId,
  AuditEventId,
  DataResourceId,
  DeploymentId,
  DomainId,
  EngineStatus,
  OrganizationId,
  ProjectId,
  UserId,
} from "@cloud-wai/contracts";
import type { Membership } from "@cloud-wai/authorization";

/** Tables that make up the control-plane schema (see supabase/migrations). */
export const CONTROL_PLANE_TABLES = [
  "profiles",
  "organizations",
  "organization_members",
  "projects",
  "environments",
  "deployments",
  "data_resources",
  "domains",
  "security_policies",
  "api_keys",
  "orchestration_jobs",
  "usage_records",
  "audit_logs",
] as const;

export type ControlPlaneTable = (typeof CONTROL_PLANE_TABLES)[number];

export interface ControlPlaneConfig {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
}

/**
 * Read control-plane configuration from the environment.
 *
 * Returns `null` rather than throwing when the control plane is not configured,
 * so callers can surface an honest `not_configured` state instead of a crash.
 */
export function controlPlaneConfig(
  env: Record<string, string | undefined> = process.env,
): ControlPlaneConfig | null {
  const url = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceRoleKey) return null;
  return { url, anonKey, serviceRoleKey };
}

/**
 * Resolve a principal's memberships.
 *
 * Implementations MUST read memberships server-side from the control plane. A
 * response body, a request parameter or a client-supplied JWT claim is never an
 * acceptable source.
 */
export interface MembershipStore {
  membershipsFor(userId: string): Promise<readonly Membership[]>;
}

export interface DataStore {
  listOrganizations(userId: UserId): Promise<readonly Organization[]>;
  createOrganization(input: {
    name: string;
    slug: string;
    createdBy: UserId;
  }): Promise<Organization>;
  listProjects(userId: UserId, organizationId: OrganizationId): Promise<readonly Project[]>;
  getProject(userId: UserId, projectId: ProjectId): Promise<Project | null>;
  createProject(input: {
    organizationId: OrganizationId;
    name: string;
    slug: string;
    createdBy: UserId;
  }): Promise<Project>;
  listDeployments(userId: UserId, projectId: ProjectId): Promise<readonly Deployment[]>;
  listAuditEvents(userId: UserId, organizationId: OrganizationId): Promise<readonly AuditEvent[]>;
  /** Append-only: returns the recorded event. */
  recordAuditEvent(input: AuditEventInput): Promise<AuditEvent>;

  /** Domains belong to an organization, verified out of band by the edge. */
  listDomains(userId: UserId, organizationId: OrganizationId): Promise<readonly Domain[]>;
  /** Data resources are tenant database and bucket handles. */
  listDataResources(
    userId: UserId,
    organizationId: OrganizationId,
  ): Promise<readonly DataResource[]>;
  /** API keys, hash stripped — a list response can never contain a usable key. */
  listApiKeys(userId: UserId, organizationId: OrganizationId): Promise<readonly ApiKeySummary[]>;
  /** Persist a newly issued key. The secret is never part of this input. */
  createApiKey(input: ApiKeyCreateInput): Promise<ApiKeySummary>;
  /** Revoke a key. Idempotent: revoking a revoked key succeeds. */
  revokeApiKey(userId: UserId, organizationId: OrganizationId, keyId: ApiKeyId): Promise<boolean>;
}

/**
 * The write operations a control plane needs beyond the reads above.
 *
 * Kept in its own interface so a caller that can only read (a report, a test
 * double, a first deployment) does not have to implement a half-real version of
 * a deployment request. A procedure that needs a write checks for this
 * capability and reports `engine_unavailable` when it is absent, rather than
 * writing nothing and answering `ok`.
 */
export interface ControlPlaneWrites {
  /** Create a deployment row. Status is `pending`; only the worker advances it. */
  createDeployment(input: DeploymentCreateInput): Promise<Deployment>;
  /** The existing deployment for an idempotency key, or null. */
  findDeploymentByIdempotencyKey(
    userId: UserId,
    organizationId: OrganizationId,
    idempotencyKey: string,
  ): Promise<Deployment | null>;
  /** A deployment by id, scoped to a member's organization. */
  getDeployment(userId: UserId, deploymentId: DeploymentId): Promise<Deployment | null>;
  /**
   * Advance a deployment's state machine.
   *
   * Written with the service-role connection the browser never holds, which is
   * what stops a client from marking its own deployment succeeded. A deployment
   * row that is not in the caller's organization is not updated, so a write can
   * never reach across a tenant boundary.
   */
  updateDeploymentStatus(input: DeploymentStatusInput): Promise<Deployment | null>;
  /**
   * Remember the hosting engine's application for a project.
   *
   * The first deployment creates the engine-side application; without persisting
   * its reference every later deployment would create a second application.
   */
  setProjectProviderResource(input: ProjectProviderInput): Promise<Project | null>;
  /** The engine-side target for a project, scoped to a member's organization. */
  getProjectDeploymentTarget(
    userId: UserId,
    projectId: ProjectId,
  ): Promise<ProjectDeploymentTarget | null>;
  /**
   * The engine-side target for a project, scoped by organization only.
   *
   * For a caller with no session — the worker draining a job. There is no
   * membership to join, so `organization_id` in the where clause *is* the tenant
   * boundary. It is on the write interface, not the read interface, so it is
   * never reachable from a browser-facing read path.
   */
  getProjectDeploymentTargetForService(
    organizationId: OrganizationId,
    projectId: ProjectId,
  ): Promise<ProjectDeploymentTarget | null>;

  /** The organization's current security policy, or null when none exists. */
  getSecurityPolicy(userId: UserId, organizationId: OrganizationId): Promise<SecurityPolicy | null>;
  /**
   * The organization's current policy, scoped by organization only.
   *
   * For a caller with no session — the worker draining a distribution job. As
   * with the other `…ForService` reads, `organization_id` in the where clause is
   * the tenant boundary, and it sits on the write interface so no browser-facing
   * read path can reach it.
   */
  getSecurityPolicyForService(organizationId: OrganizationId): Promise<SecurityPolicy | null>;
  /** Insert or advance the policy. Version increases monotonically. */
  saveSecurityPolicy(input: SecurityPolicyInput): Promise<SecurityPolicy>;
  /** Record a policy state transition. Append-only. */
  recordPolicyEvent(input: PolicyEventInput): Promise<SecurityPolicyEvent>;
  listPolicyEvents(
    userId: UserId,
    organizationId: OrganizationId,
  ): Promise<readonly SecurityPolicyEvent[]>;

  /** Register a hostname. Always unverified: only the edge may verify it. */
  createDomain(input: DomainCreateInput): Promise<Domain>;
  /** Get a domain by id, scoped to a member's organization. */
  getDomain(userId: UserId, domainId: DomainId): Promise<Domain | null>;
  /** Remove a hostname. Idempotent: removing an absent domain reports false. */
  deleteDomain(
    userId: UserId,
    organizationId: OrganizationId,
    domainId: DomainId,
  ): Promise<boolean>;
  /**
   * Record that the edge confirmed or withdrew a hostname.
   *
   * Only the edge's answer may set `verified`. A client cannot reach this: there
   * is no procedure that accepts a verified flag, and the write happens after the
   * adapter has answered.
   */
  setDomainVerification(input: DomainVerificationInput): Promise<Domain | null>;

  /** Register a tenant data resource handle. */
  createDataResource(input: DataResourceCreateInput): Promise<DataResource>;
  getDataResource(userId: UserId, resourceId: DataResourceId): Promise<DataResource | null>;
  /**
   * A data resource by id, scoped by organization only.
   *
   * For a caller with no session — the worker draining a backup job, which needs
   * the engine handle recorded at provisioning. There is no membership to join,
   * so `organization_id` is the tenant boundary. On the write interface, so it is
   * not reachable from a browser-facing read path.
   */
  getDataResourceForService(
    organizationId: OrganizationId,
    resourceId: DataResourceId,
  ): Promise<DataResource | null>;
  listDataBackups(userId: UserId, resourceId: DataResourceId): Promise<readonly DataBackup[]>;
  /** Request a backup. The worker performs it; status starts `pending`. */
  createDataBackup(input: DataBackupCreateInput): Promise<DataBackup>;
  /**
   * Record the engine's answer about a resource's lifecycle.
   *
   * `state` and the engine identifiers are the engine's to report, never a
   * client's assertion: there is no procedure that accepts a state from the
   * browser, and the guard trigger refuses a client write even through
   * PostgREST.
   */
  setDataResourceState(input: DataResourceStateInput): Promise<DataResource | null>;
  /** Record the outcome of a backup. Written only from the adapter's answer. */
  updateDataBackupStatus(input: DataBackupStatusInput): Promise<DataBackup | null>;
}

/** The full store a control-plane deployment needs. */
export interface ControlPlaneStore extends DataStore, MembershipStore, ControlPlaneWrites {}

export interface DeploymentCreateInput {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly idempotencyKey: string;
  readonly requestedBy: UserId;
  readonly status: EngineStatus;
  readonly provider: string | null;
  readonly providerResourceId: string | null;
  readonly url: string | null;
  readonly failureReason: string | null;
}

/**
 * A deployment state-machine transition.
 *
 * `organizationId` is part of the where clause, not a convenience: a transition
 * can only ever touch a row in the tenant it was resolved for, even though the
 * write itself runs with the service role.
 */
export interface DeploymentStatusInput {
  readonly id: DeploymentId;
  readonly organizationId: OrganizationId;
  readonly status: EngineStatus;
  readonly url?: string | null;
  readonly failureReason?: string | null;
  readonly providerResourceId?: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

/** Record the hosting engine's application against the project it belongs to. */
export interface ProjectProviderInput {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly provider: string;
  readonly providerResourceId: string;
}

/**
 * The engine-side target a project deploys to.
 *
 * Server-side only: a provider identifier is never returned by a procedure, so
 * it cannot become a cross-tenant handle in the browser.
 */
export interface ProjectDeploymentTarget {
  readonly provider: string | null;
  readonly providerResourceId: string | null;
}

export interface SecurityPolicy {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly action: "allow" | "log" | "challenge" | "block" | "quarantine";
  readonly state: "draft" | "compiled" | "distributed" | "active" | "rejected" | "degraded";
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SecurityPolicyInput {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly riskLevel: SecurityPolicy["riskLevel"];
  readonly action: SecurityPolicy["action"];
  readonly state: SecurityPolicy["state"];
  /** Monotonic per organization; the edge rejects a lower version. */
  readonly version: number;
  readonly createdBy: UserId;
}

export interface SecurityPolicyEvent {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly policyId: string;
  readonly fromState: SecurityPolicy["state"] | null;
  readonly toState: SecurityPolicy["state"];
  readonly version: number;
  readonly actorId: UserId | null;
  readonly actorEmail: string | null;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface PolicyEventInput {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly policyId: string;
  readonly fromState: SecurityPolicy["state"] | null;
  readonly toState: SecurityPolicy["state"];
  readonly version: number;
  readonly actorId: UserId | null;
  readonly actorEmail: string | null;
  readonly detail: string | null;
}

export interface DomainCreateInput {
  readonly id: DomainId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId | null;
  readonly hostname: string;
  /** The generated DNS challenge the customer must publish. */
  readonly verificationToken: string;
}

/**
 * The edge's verdict on a hostname.
 *
 * `verified` is the edge's answer, never a client's request: there is no
 * procedure that accepts a verified flag from the browser. `verifiedAt` is set
 * to the moment the verdict was recorded, or null when it was not confirmed.
 */
export interface DomainVerificationInput {
  readonly id: DomainId;
  readonly organizationId: OrganizationId;
  readonly verified: boolean;
  readonly provider: string | null;
  readonly providerResourceId: string | null;
  readonly verifiedAt: string | null;
}

export interface DataResourceCreateInput {
  readonly id: DataResourceId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId | null;
  readonly kind: DataResource["kind"];
  readonly name: string;
  readonly state: DataResource["state"];
  readonly provider: string | null;
  readonly providerResourceId: string | null;
}

export interface DataBackup {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly dataResourceId: DataResourceId;
  readonly provider: string | null;
  readonly providerResourceId: string | null;
  readonly sizeBytes: number | null;
  readonly status: EngineStatus;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface DataBackupCreateInput {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly dataResourceId: DataResourceId;
  readonly provider: string | null;
  readonly status: EngineStatus;
}

/**
 * A resource lifecycle change the engine reported.
 *
 * `organizationId` is part of the where clause, not a convenience: the write runs
 * with the service role, so the tenant is what stops it crossing a boundary.
 */
export interface DataResourceStateInput {
  readonly id: DataResourceId;
  readonly organizationId: OrganizationId;
  readonly state: DataResource["state"];
  readonly provider?: string | null;
  readonly providerResourceId?: string | null;
}

/** A backup outcome. Only the adapter's answer may set `status`. */
export interface DataBackupStatusInput {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly status: EngineStatus;
  readonly providerResourceId?: string | null;
  readonly sizeBytes?: number | null;
  readonly finishedAt?: string | null;
}

export interface Domain {
  readonly id: DomainId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId | null;
  readonly hostname: string;
  readonly verified: boolean;
  /** The edge that owns the hostname, when one has claimed it. */
  readonly provider: string | null;
  readonly providerResourceId: string | null;
  /**
   * The DNS challenge the customer must publish at
   * `_cloud-wai-challenge.<hostname>`. Not a secret: it is meant to be public.
   */
  readonly verificationToken: string | null;
  /** When the edge last confirmed the hostname; null means never. */
  readonly verifiedAt: string | null;
  readonly createdAt: string;
}

export interface DataResource {
  readonly id: DataResourceId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId | null;
  readonly kind: "postgres" | "object_storage";
  readonly name: string;
  /**
   * Mirrors the `data_resource_state` enum in the control-plane schema. It used
   * to drift (`degraded`/`destroying` here, `restoring`/`not_configured` in SQL),
   * which meant a state the database rejects was reachable from TypeScript and a
   * state the database can hold could not be named.
   */
  readonly state: "provisioning" | "ready" | "restoring" | "failed" | "not_configured";
  readonly provider: string | null;
  /**
   * The engine's own handle for this resource, needed to address a backup or
   * restore at the engine. Null until the engine has answered a provisioning
   * call; recorded only from that answer, never supplied by a client.
   */
  readonly providerResourceId: string | null;
  readonly createdAt: string;
}

/** An API key as it may leave the API: identity and scopes, never the hash. */
export interface ApiKeySummary {
  readonly id: ApiKeyId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  /** Short display prefix, not a usable credential. */
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface ApiKeyCreateInput {
  readonly id: ApiKeyId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly ownerId: UserId;
  readonly scopes: readonly string[];
}

export interface Organization {
  readonly id: OrganizationId;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: string;
}

export interface Project {
  readonly id: ProjectId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: string;
}

export interface Deployment {
  readonly id: DeploymentId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly status: EngineStatus;
  readonly url: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
}

export interface AuditEventInput {
  readonly organizationId: OrganizationId;
  readonly actorId: UserId | null;
  readonly actorEmail: string | null;
  readonly event: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface AuditEvent extends AuditEventInput {
  readonly id: AuditEventId;
  readonly createdAt: string;
}

export * from "./postgrest.js";
export * from "./supabase-store.js";
export * from "./sql-queue.js";
