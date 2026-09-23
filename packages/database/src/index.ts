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
