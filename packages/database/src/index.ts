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

  /** The organization's current security policy, or null when none exists. */
  getSecurityPolicy(userId: UserId, organizationId: OrganizationId): Promise<SecurityPolicy | null>;
  /** Insert or advance the policy. Version increases monotonically. */
  saveSecurityPolicy(input: SecurityPolicyInput): Promise<SecurityPolicy>;
  /** Record a policy state transition. Append-only. */
  recordPolicyEvent(input: PolicyEventInput): Promise<SecurityPolicyEvent>;
  listPolicyEvents(userId: UserId, organizationId: OrganizationId): Promise<readonly SecurityPolicyEvent[]>;

  /** Register a hostname. Always unverified: only the edge may verify it. */
  createDomain(input: DomainCreateInput): Promise<Domain>;
  /** Get a domain by id, scoped to a member's organization. */
  getDomain(userId: UserId, domainId: DomainId): Promise<Domain | null>;

  /** Register a tenant data resource handle. */
  createDataResource(input: DataResourceCreateInput): Promise<DataResource>;
  getDataResource(userId: UserId, resourceId: DataResourceId): Promise<DataResource | null>;
  listDataBackups(userId: UserId, resourceId: DataResourceId): Promise<readonly DataBackup[]>;
  /** Request a backup. The worker performs it; status starts `pending`. */
  createDataBackup(input: DataBackupCreateInput): Promise<DataBackup>;
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

export interface Domain {
  readonly id: DomainId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId | null;
  readonly hostname: string;
  readonly verified: boolean;
  readonly createdAt: string;
}

export interface DataResource {
  readonly id: DataResourceId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId | null;
  readonly kind: "postgres" | "object_storage";
  readonly name: string;
  readonly state: "provisioning" | "ready" | "degraded" | "failed" | "destroying";
  readonly provider: string | null;
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
