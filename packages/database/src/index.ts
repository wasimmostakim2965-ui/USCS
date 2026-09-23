/**
 * @cloud-wai/database — control-plane repositories and migration helpers.
 *
 * This package talks ONLY to the control-plane Supabase PostgreSQL database.
 * Customer tenant databases are a separate data plane and must never be reached
 * from here — that happens through `@cloud-wai/adapters`.
 */
import type {
  AuditEventId,
  DeploymentId,
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
