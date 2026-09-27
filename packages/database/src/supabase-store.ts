/**
 * Control-plane store backed by Supabase PostgREST.
 *
 * Every method here passes the caller's identity to the database, and the
 * database decides what is visible through RLS. The filters below are the
 * second line of defence, not the first: the API's `requireCapability` guard
 * runs before any of this, and the row-level policies run underneath.
 *
 * Two rules this file keeps:
 *   * The API server uses the service-role key, so it can read a hash and write
 *     a status. Those values never travel back out of a procedure.
 *   * A provider identifier is stored *beside* the Cloud Wai id, never as the
 *     tenant boundary.
 */
import type {
  ApiKeyId,
  DataResourceId,
  DeploymentId,
  DomainId,
  EnvironmentId,
  ExecutionModel,
  JobState,
  OrganizationId,
  ProjectId,
  UserId,
} from "@cloud-wai/contracts";
import type { Membership, OrgRole } from "@cloud-wai/authorization";
import type { PostgrestClient, PostgrestRequest } from "./postgrest.js";
import type {
  ApiKeyCreateInput,
  ApiKeySummary,
  ResolvedApiKey,
  AuditEvent,
  AuditEventInput,
  Budget,
  BudgetSaveInput,
  ControlPlaneStore,
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
  DeploymentCreateInput,
  DeploymentStatusInput,
  Domain,
  DomainCreateInput,
  DomainVerificationInput,
  EnvVarSaveInput,
  GitLinkCreateInput,
  Organization,
  OrganizationMember,
  OrchestrationJob,
  PolicyEventInput,
  PreviewTarget,
  Project,
  ProjectDeploymentTarget,
  ProjectEnvVar,
  ProjectEnvVarSecret,
  ProjectEnvironment,
  ProjectGitLink,
  ProjectProviderInput,
  ProjectUpdateInput,
  PromoteDeploymentInput,
  PromoteDeploymentResult,
  SecurityPolicy,
  SecurityPolicyEvent,
  SecurityPolicyInput,
  SecurityEvent,
  SecurityIncident,
  SecurityIncidentCreateInput,
  SecurityIncidentTransitionInput,
  SecurityRule,
  SecurityRuleCreateInput,
  RateLimit,
  RateLimitCreateInput,
  TrustedSource,
  TrustedSourceCreateInput,
  UsageRecord,
  UsageRecordInput,
} from "./index.js";
import {
  DEFAULT_AUDIT_LIMIT,
  DEFAULT_LIST_LIMIT,
  resolveListLimit,
  type ListPageOptions,
} from "./index.js";

/** A procedure could not reach the control-plane database. */
export class ControlPlaneUnavailableError extends Error {
  constructor(
    readonly operation: string,
    readonly reason: string,
  ) {
    super(`Control-plane database ${operation} failed: ${reason}`);
    this.name = "ControlPlaneUnavailableError";
  }
}

interface Row {
  [key: string]: unknown;
}

function str(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function nullableStr(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

/** A `text[]` column as strings; a non-array is empty, never a fabricated value. */
function strArray(row: Row, key: string): readonly string[] {
  const value = row[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * A row's execution model, defaulting to `container`.
 *
 * A row written before migration 0017 has no `execution_model`, and an absent
 * value must mean the historical behaviour — the container engine — not a new
 * engine chosen by a null. The column's check constraint admits only the two
 * known models, so the fallback is reachable only for an absent column.
 */
function executionModel(row: Row): "container" | "serverless" {
  return row["execution_model"] === "serverless" ? "serverless" : "container";
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

function nullableNum(row: Row, key: string): number | null {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value !== "") return Number(value);
  return null;
}

function bool(row: Row, key: string): boolean {
  return row[key] === true;
}

const q = (value: string) => encodeURIComponent(value);

export interface SupabaseStoreOptions {
  readonly client: PostgrestClient;
  /**
   * A change-driven id source. Injected so ids are test-stable and so a
   * deployment can substitute a UUIDv7 generator without touching this file.
   */
  readonly newId: () => string;
  readonly now?: () => Date;
}

export function createSupabaseControlPlaneStore(options: SupabaseStoreOptions): ControlPlaneStore {
  const { client, newId } = options;
  const now = options.now ?? (() => new Date());
  const iso = () => now().toISOString();

  /**
   * Run a request, turning an adapter failure into a thrown error.
   *
   * A failure to reach the database is never silently returned as an empty
   * list: `[]` reads as "you have no projects", which is a different and false
   * statement.
   */
  async function must<T>(operation: string, req: PostgrestRequest): Promise<T> {
    const result = await client.request<T>(req);
    if (!result.ok) throw new ControlPlaneUnavailableError(operation, result.reason);
    return result.value.rows;
  }

  async function rows(operation: string, req: PostgrestRequest): Promise<Row[]> {
    const value = await must<Row[]>(operation, req);
    return Array.isArray(value) ? value : [];
  }

  function toOrganization(row: Row): Organization {
    return {
      id: str(row, "id") as OrganizationId,
      name: str(row, "name"),
      slug: str(row, "slug"),
      createdAt: str(row, "created_at"),
    };
  }

  function toProject(row: Row): Project {
    return {
      id: str(row, "id") as ProjectId,
      organizationId: str(row, "organization_id") as OrganizationId,
      name: str(row, "name"),
      slug: str(row, "slug"),
      providerResourceId: nullableStr(row, "provider_resource_id"),
      rootDirectory: nullableStr(row, "root_directory"),
      productionDeploymentId: nullableStr(row, "production_deployment_id"),
      executionModel: executionModel(row),
      createdAt: str(row, "created_at"),
    };
  }

  /**
   * A membership joined with its profile.
   *
   * A missing profile is a null address, never a fabricated one.
   */
  function toOrganizationMember(row: Row): OrganizationMember {
    // `user_id` is a to-one relationship, so PostgREST returns the embed as an
    // object rather than the array a to-many embed produces. Both shapes are
    // accepted; reading only the array made every address and name silently
    // null.
    const embedded = row["profiles"];
    const profile = Array.isArray(embedded)
      ? (embedded[0] as Row | undefined)
      : embedded && typeof embedded === "object"
        ? (embedded as Row)
        : undefined;
    return {
      organizationId: str(row, "organization_id") as OrganizationId,
      userId: str(row, "user_id") as UserId,
      role: str(row, "role") as OrgRole,
      email: profile ? nullableStr(profile, "email") : null,
      displayName: profile ? nullableStr(profile, "display_name") : null,
      invitedBy: nullableStr(row, "invited_by") as UserId | null,
      createdAt: str(row, "created_at"),
    };
  }

  function toDeployment(row: Row): Deployment {
    return {
      id: str(row, "id") as DeploymentId,
      organizationId: str(row, "organization_id") as OrganizationId,
      projectId: str(row, "project_id") as ProjectId,
      status: str(row, "status") as Deployment["status"],
      url: nullableStr(row, "url"),
      kind: str(row, "kind") === "preview" ? "preview" : "production",
      environmentId: nullableStr(row, "environment_id") as EnvironmentId | null,
      staged: bool(row, "staged"),
      gitBranch: nullableStr(row, "git_branch"),
      gitCommit: nullableStr(row, "git_commit"),
      pullRequest: nullableNum(row, "pull_request"),
      previewKey: nullableStr(row, "preview_key"),
      providerResourceId: nullableStr(row, "provider_resource_id"),
      deploymentResourceId: nullableStr(row, "deployment_resource_id"),
      isCurrent: bool(row, "is_current"),
      failureReason: nullableStr(row, "failure_reason"),
      createdAt: str(row, "created_at"),
      gitRepository: nullableStr(row, "git_repository"),
      buildPack: nullableStr(row, "build_pack"),
      rootDirectory: nullableStr(row, "root_directory"),
    };
  }

  function toGitLink(row: Row): ProjectGitLink {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      projectId: str(row, "project_id") as ProjectId,
      provider: str(row, "provider") as ProjectGitLink["provider"],
      repository: str(row, "repository"),
      productionBranch: str(row, "production_branch"),
      previewsEnabled: bool(row, "previews_enabled"),
      secretPrefix: str(row, "secret_prefix"),
      createdBy: str(row, "created_by") as UserId,
      createdAt: str(row, "created_at"),
    };
  }

  function toEnvVar(row: Row): ProjectEnvVar {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      projectId: str(row, "project_id") as ProjectId,
      environmentId: str(row, "environment_id") as EnvironmentId,
      key: str(row, "key"),
      valuePrefix: str(row, "value_prefix"),
      isBuildTime: bool(row, "is_build_time"),
      updatedBy: str(row, "updated_by") as UserId,
      createdAt: str(row, "created_at"),
      updatedAt: str(row, "updated_at"),
    };
  }

  function toEnvVarSecret(row: Row): ProjectEnvVarSecret {
    return {
      ...toEnvVar(row),
      valueEncrypted: str(row, "value_encrypted"),
      engineRef: nullableStr(row, "engine_ref"),
    };
  }

  function toEnvironment(row: Row): ProjectEnvironment {
    const kind = str(row, "kind");
    return {
      id: str(row, "id") as EnvironmentId,
      organizationId: str(row, "organization_id") as OrganizationId,
      projectId: str(row, "project_id") as ProjectId,
      name: str(row, "name"),
      // A row written before `0024` carries the column default `custom`, so an
      // unknown value is classified honestly rather than silently called
      // Production.
      kind: kind === "production" || kind === "preview" ? kind : "custom",
      isDefault: bool(row, "is_default"),
      createdAt: str(row, "created_at"),
    };
  }

  function toPreviewTarget(row: Row): PreviewTarget {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      projectId: str(row, "project_id") as ProjectId,
      previewKey: str(row, "preview_key"),
      branch: nullableStr(row, "branch"),
      pullRequest: nullableNum(row, "pull_request"),
      provider: nullableStr(row, "provider"),
      providerResourceId: nullableStr(row, "provider_resource_id"),
    };
  }

  function toDomain(row: Row): Domain {
    return {
      id: str(row, "id") as DomainId,
      organizationId: str(row, "organization_id") as OrganizationId,
      projectId: nullableStr(row, "project_id") as ProjectId | null,
      hostname: str(row, "hostname"),
      verified: bool(row, "verified"),
      provider: nullableStr(row, "provider"),
      providerResourceId: nullableStr(row, "provider_resource_id"),
      verificationToken: nullableStr(row, "verification_token"),
      verifiedAt: nullableStr(row, "verified_at"),
      createdAt: str(row, "created_at"),
    };
  }

  function toDataResource(row: Row): DataResource {
    return {
      id: str(row, "id") as DataResourceId,
      organizationId: str(row, "organization_id") as OrganizationId,
      projectId: nullableStr(row, "project_id") as ProjectId | null,
      kind: str(row, "kind") as DataResource["kind"],
      name: str(row, "name"),
      state: str(row, "state") as DataResource["state"],
      provider: nullableStr(row, "provider"),
      providerResourceId: nullableStr(row, "provider_resource_id"),
      createdAt: str(row, "created_at"),
    };
  }

  function toDataBackup(row: Row): DataBackup {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      dataResourceId: str(row, "data_resource_id") as DataResourceId,
      provider: nullableStr(row, "provider"),
      providerResourceId: nullableStr(row, "provider_resource_id"),
      sizeBytes:
        row["size_bytes"] === null || row["size_bytes"] === undefined
          ? null
          : num(row, "size_bytes"),
      status: str(row, "status") as DataBackup["status"],
      createdAt: str(row, "created_at"),
      finishedAt: nullableStr(row, "finished_at"),
    };
  }

  function toDataRestore(row: Row): DataRestore {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      backupId: str(row, "backup_id"),
      dataResourceId: str(row, "data_resource_id") as DataResourceId,
      provider: nullableStr(row, "provider"),
      providerResourceId: nullableStr(row, "provider_resource_id"),
      status: str(row, "status") as DataRestore["status"],
      createdAt: str(row, "created_at"),
      finishedAt: nullableStr(row, "finished_at"),
    };
  }

  function toApiKey(row: Row): ApiKeySummary {
    return {
      id: str(row, "id") as ApiKeyId,
      organizationId: str(row, "organization_id") as OrganizationId,
      name: str(row, "name"),
      keyPrefix: str(row, "key_prefix"),
      scopes: Array.isArray(row["scopes"]) ? (row["scopes"] as string[]) : [],
      createdAt: str(row, "created_at"),
      lastUsedAt: nullableStr(row, "last_used_at"),
      revokedAt: nullableStr(row, "revoked_at"),
    };
  }

  function toUsageRecord(row: Row): UsageRecord {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      metric: str(row, "metric"),
      quantity: num(row, "quantity"),
      recordedAt: str(row, "recorded_at"),
    };
  }

  function toBudget(row: Row): Budget {
    return {
      organizationId: str(row, "organization_id") as OrganizationId,
      metric: str(row, "metric"),
      limitQuantity: num(row, "limit_quantity"),
      period: "monthly",
      hardCap: bool(row, "hard_cap"),
      updatedBy: (row["updated_by"] ? str(row, "updated_by") : null) as UserId | null,
      createdAt: str(row, "created_at"),
      updatedAt: str(row, "updated_at"),
    };
  }

  function toOrchestrationJob(row: Row): OrchestrationJob {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      kind: str(row, "kind"),
      state: str(row, "state") as JobState,
      attempts: num(row, "attempts"),
      maxAttempts: num(row, "max_attempts"),
      idempotencyKey: str(row, "idempotency_key"),
      createdAt: str(row, "created_at"),
      startedAt: nullableStr(row, "started_at"),
      finishedAt: nullableStr(row, "finished_at"),
      lastError: nullableStr(row, "last_error"),
      leaseExpiresAt: nullableStr(row, "lease_expires_at"),
    };
  }

  function toAuditEvent(row: Row): AuditEvent {
    return {
      id: str(row, "id") as AuditEvent["id"],
      organizationId: str(row, "organization_id") as OrganizationId,
      actorId: nullableStr(row, "actor_id") as UserId | null,
      actorEmail: nullableStr(row, "actor_email"),
      event: str(row, "event"),
      targetType: nullableStr(row, "target_type"),
      targetId: nullableStr(row, "target_id"),
      metadata: (row["metadata"] as Record<string, unknown>) ?? {},
      createdAt: str(row, "created_at"),
    };
  }

  function toPolicy(row: Row): SecurityPolicy {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      name: str(row, "name"),
      riskLevel: str(row, "risk_level") as SecurityPolicy["riskLevel"],
      action: str(row, "action") as SecurityPolicy["action"],
      state: str(row, "state") as SecurityPolicy["state"],
      protectionMode: (nullableStr(row, "protection_mode") ??
        "normal") as SecurityPolicy["protectionMode"],
      protectionExpiresAt: nullableStr(row, "protection_expires_at"),
      version: num(row, "version"),
      createdAt: str(row, "created_at"),
      updatedAt: str(row, "updated_at"),
    };
  }

  function toSecurityRule(row: Row): SecurityRule {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      kind: str(row, "kind") as SecurityRule["kind"],
      value: str(row, "value"),
      note: nullableStr(row, "note"),
      createdBy: str(row, "created_by") as UserId,
      createdAt: str(row, "created_at"),
    };
  }

  function toTrustedSource(row: Row): TrustedSource {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      kind: str(row, "kind") as TrustedSource["kind"],
      value: str(row, "value"),
      note: nullableStr(row, "note"),
      createdBy: str(row, "created_by") as UserId,
      createdAt: str(row, "created_at"),
    };
  }

  function toRateLimit(row: Row): RateLimit {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      key: str(row, "key") as RateLimit["key"],
      headerName: nullableStr(row, "header_name"),
      limit: Number(row["limit_count"]),
      windowSeconds: Number(row["window_seconds"]),
      note: nullableStr(row, "note"),
      createdBy: str(row, "created_by") as UserId,
      createdAt: str(row, "created_at"),
    };
  }

  function toSecurityEvent(row: Row): SecurityEvent {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      host: str(row, "host"),
      stage: str(row, "stage") as SecurityEvent["stage"],
      action: str(row, "action") as SecurityEvent["action"],
      ruleId: nullableNum(row, "rule_id"),
      policyVersion: nullableNum(row, "policy_version"),
      clientIp: nullableStr(row, "client_ip"),
      method: nullableStr(row, "method"),
      path: nullableStr(row, "path"),
      userAgent: nullableStr(row, "user_agent"),
      observedAt: str(row, "observed_at"),
      createdAt: str(row, "created_at"),
    };
  }

  function toSecurityIncident(row: Row): SecurityIncident {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      kind: str(row, "kind"),
      severity: str(row, "severity") as SecurityIncident["severity"],
      summary: str(row, "summary"),
      state: str(row, "state") as SecurityIncident["state"],
      openedAt: str(row, "opened_at"),
      closedAt: nullableStr(row, "closed_at"),
      resolution: nullableStr(row, "resolution"),
      triagedBy: nullableStr(row, "triaged_by") as UserId | null,
      createdAt: str(row, "created_at"),
    };
  }

  function toPolicyEvent(row: Row): SecurityPolicyEvent {
    return {
      id: str(row, "id"),
      organizationId: str(row, "organization_id") as OrganizationId,
      policyId: str(row, "policy_id"),
      fromState: nullableStr(row, "from_state") as SecurityPolicy["state"] | null,
      toState: str(row, "to_state") as SecurityPolicy["state"],
      version: num(row, "version"),
      actorId: nullableStr(row, "actor_id") as UserId | null,
      actorEmail: nullableStr(row, "actor_email"),
      detail: nullableStr(row, "detail"),
      createdAt: str(row, "created_at"),
    };
  }

  return {
    // ---------------------------------------------------------------- reads

    async membershipsFor(userId: string): Promise<readonly Membership[]> {
      const found = await rows("membershipsFor", {
        method: "GET",
        path: `/organization_members?select=organization_id,user_id,role&user_id=eq.${q(userId)}`,
      });
      return found.map((row) => ({
        organizationId: str(row, "organization_id") as OrganizationId,
        userId: str(row, "user_id"),
        role: str(row, "role") as Membership["role"],
      }));
    },

    async listOrganizations(userId: UserId): Promise<readonly Organization[]> {
      // RLS already narrows this to the caller's memberships; the join keeps it
      // correct even when the server uses a service-role key.
      const found = await rows("listOrganizations", {
        method: "GET",
        path: `/organizations?select=*,organization_members!inner(user_id)&organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toOrganization);
    },

    async listOrganizationMembers(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly OrganizationMember[]> {
      // One request, two embeds: `organization_members` is filtered to the
      // caller's own membership (the same tenant re-check every read uses), and
      // `profiles` is embedded through the membership's `user_id` so RLS's
      // "co-member" rule is what decides whose address is visible.
      const found = await rows("listOrganizationMembers", {
        method: "GET",
        path: `/organization_members?select=*,profiles(email,display_name),organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.asc&limit=200`,
      });
      return found.map(toOrganizationMember);
    },

    async updateOrganizationMemberRole(input: {
      userId: UserId;
      organizationId: OrganizationId;
      memberId: UserId;
      role: OrgRole;
    }): Promise<OrganizationMember | null> {
      // `organization_members.user_id=eq.<caller>` is the tenant re-check: the
      // same embedding every scoped read uses, so a caller with no membership
      // here matches nothing and the write is a no-op rather than a leak. The
      // row's own `user_id` is the *target*, so it is filtered separately.
      const updated = await rows("updateOrganizationMemberRole", {
        method: "PATCH",
        path: `/organization_members?select=*,profiles(email,display_name),organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(input.organizationId)}&user_id=eq.${q(input.memberId)}&organizations.organization_members.user_id=eq.${q(input.userId)}`,
        prefer: "return=representation",
        body: { role: input.role },
      });
      const row = updated[0];
      return row ? toOrganizationMember(row) : null;
    },

    async removeOrganizationMember(input: {
      userId: UserId;
      organizationId: OrganizationId;
      memberId: UserId;
    }): Promise<boolean> {
      const removed = await rows("removeOrganizationMember", {
        method: "DELETE",
        path: `/organization_members?select=user_id,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(input.organizationId)}&user_id=eq.${q(input.memberId)}&organizations.organization_members.user_id=eq.${q(input.userId)}`,
        prefer: "return=representation",
      });
      return removed.length > 0;
    },

    async listProjects(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly Project[]> {
      const found = await rows("listProjects", {
        method: "GET",
        path: `/projects?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toProject);
    },

    async getProject(userId: UserId, projectId: ProjectId): Promise<Project | null> {
      const found = await rows("getProject", {
        method: "GET",
        path: `/projects?select=*,organizations!inner(organization_members!inner(user_id))&id=eq.${q(projectId)}&organizations.organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      return row ? toProject(row) : null;
    },

    async getProjectForService(
      organizationId: OrganizationId,
      projectId: ProjectId,
    ): Promise<Project | null> {
      const found = await rows("getProjectForService", {
        method: "GET",
        path: `/projects?select=*&id=eq.${q(projectId)}&organization_id=eq.${q(organizationId)}&limit=1`,
      });
      const row = found[0];
      return row ? toProject(row) : null;
    },

    async listDeployments(
      userId: UserId,
      projectId: ProjectId,
      options?: ListPageOptions | undefined,
    ): Promise<readonly Deployment[]> {
      const limit = resolveListLimit(options?.limit, DEFAULT_LIST_LIMIT);
      // Keyset: strictly older than the cursor, so page N+1 never repeats a row
      // that landed at the head while page N was being read.
      const cursor =
        options?.before !== undefined ? `&created_at=lt.${q(options.before)}` : "";
      const found = await rows("listDeployments", {
        method: "GET",
        path: `/deployments?select=*,organizations!inner(organization_members!inner(user_id))&project_id=eq.${q(projectId)}&organizations.organization_members.user_id=eq.${q(userId)}${cursor}&order=created_at.desc&limit=${limit}`,
      });
      return found.map(toDeployment);
    },

    async getDeployment(userId: UserId, deploymentId: DeploymentId): Promise<Deployment | null> {
      const found = await rows("getDeployment", {
        method: "GET",
        path: `/deployments?select=*,organizations!inner(organization_members!inner(user_id))&id=eq.${q(deploymentId)}&organizations.organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      return row ? toDeployment(row) : null;
    },

    async listAuditEvents(
      userId: UserId,
      organizationId: OrganizationId,
      options?: ListPageOptions | undefined,
    ): Promise<readonly AuditEvent[]> {
      const limit = resolveListLimit(options?.limit, DEFAULT_AUDIT_LIMIT);
      const cursor =
        options?.before !== undefined ? `&created_at=lt.${q(options.before)}` : "";
      const found = await rows("listAuditEvents", {
        method: "GET",
        path: `/audit_logs?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}${cursor}&order=created_at.desc&limit=${limit}`,
      });
      return found.map(toAuditEvent);
    },

    async listDomains(userId: UserId, organizationId: OrganizationId): Promise<readonly Domain[]> {
      const found = await rows("listDomains", {
        method: "GET",
        path: `/domains?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toDomain);
    },

    async getDomain(userId: UserId, domainId: DomainId): Promise<Domain | null> {
      const found = await rows("getDomain", {
        method: "GET",
        path: `/domains?select=*,organizations!inner(organization_members!inner(user_id))&id=eq.${q(domainId)}&organizations.organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      return row ? toDomain(row) : null;
    },

    async deleteDomain(
      userId: UserId,
      organizationId: OrganizationId,
      domainId: DomainId,
    ): Promise<boolean> {
      const deleted = await rows("deleteDomain", {
        method: "DELETE",
        path: `/domains?select=id,organizations!inner(organization_members!inner(user_id))&id=eq.${q(domainId)}&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
      });
      return deleted.length > 0;
    },

    async setDomainVerification(input: DomainVerificationInput): Promise<Domain | null> {
      const updated = await rows("setDomainVerification", {
        method: "PATCH",
        path: `/domains?select=*&id=eq.${q(input.id)}&organization_id=eq.${q(input.organizationId)}`,
        prefer: "return=representation",
        body: {
          verified: input.verified,
          provider: input.provider,
          provider_resource_id: input.providerResourceId,
          verified_at: input.verifiedAt,
        },
      });
      const row = updated[0];
      return row ? toDomain(row) : null;
    },

    async listDataResources(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly DataResource[]> {
      const found = await rows("listDataResources", {
        method: "GET",
        path: `/data_resources?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toDataResource);
    },

    async getDataResource(
      userId: UserId,
      resourceId: DataResourceId,
    ): Promise<DataResource | null> {
      const found = await rows("getDataResource", {
        method: "GET",
        path: `/data_resources?select=*,organizations!inner(organization_members!inner(user_id))&id=eq.${q(resourceId)}&organizations.organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      return row ? toDataResource(row) : null;
    },

    async getDataResourceForService(
      organizationId: OrganizationId,
      resourceId: DataResourceId,
    ): Promise<DataResource | null> {
      const found = await rows("getDataResourceForService", {
        method: "GET",
        path: `/data_resources?select=*&id=eq.${q(resourceId)}&organization_id=eq.${q(organizationId)}&limit=1`,
      });
      const row = found[0];
      return row ? toDataResource(row) : null;
    },

    async listDataBackups(
      userId: UserId,
      resourceId: DataResourceId,
    ): Promise<readonly DataBackup[]> {
      const found = await rows("listDataBackups", {
        method: "GET",
        path: `/data_backups?select=*,organizations!inner(organization_members!inner(user_id))&data_resource_id=eq.${q(resourceId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=50`,
      });
      return found.map(toDataBackup);
    },

    async listApiKeys(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly ApiKeySummary[]> {
      const found = await rows("listApiKeys", {
        method: "GET",
        path: `/api_keys?select=id,organization_id,name,key_prefix,scopes,last_used_at,revoked_at,created_at,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toApiKey);
    },

    async listGitLinks(userId: UserId, projectId: ProjectId): Promise<readonly ProjectGitLink[]> {
      const found = await rows("listGitLinks", {
        method: "GET",
        // The secret columns are not named here, and are not in the client
        // SELECT grant either, so even a widened select cannot return them.
        path: `/project_git_links?select=id,organization_id,project_id,provider,repository,production_branch,previews_enabled,secret_prefix,created_by,created_at,organizations!inner(organization_members!inner(user_id))&project_id=eq.${q(projectId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toGitLink);
    },

    async listEnvVars(userId: UserId, projectId: ProjectId): Promise<readonly ProjectEnvVar[]> {
      const found = await rows("listEnvVars", {
        method: "GET",
        // `value_encrypted` is not named here, and is not in the client SELECT
        // grant either, so even a widened select cannot return it.
        path: `/project_env_vars?select=id,organization_id,project_id,environment_id,key,value_prefix,is_build_time,updated_by,created_at,updated_at,organizations!inner(organization_members!inner(user_id))&project_id=eq.${q(projectId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=key.asc`,
      });
      return found.map(toEnvVar);
    },

    async listEnvironments(
      userId: UserId,
      projectId: ProjectId,
    ): Promise<readonly ProjectEnvironment[]> {
      const found = await rows("listEnvironments", {
        method: "GET",
        // Production first, then Preview, then a customer's own: the order the
        // dashboard's environment picker and the deploy path both want, and the
        // order Vercel's own Environment Variables dialog lists them in.
        path: `/environments?select=id,organization_id,project_id,name,kind,is_default,created_at,organizations!inner(organization_members!inner(user_id))&project_id=eq.${q(projectId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=kind.asc,name.asc`,
      });
      return found.map(toEnvironment);
    },

    async getEnvironment(
      userId: UserId,
      projectId: ProjectId,
      environmentId: EnvironmentId,
    ): Promise<ProjectEnvironment | null> {
      const found = await rows("getEnvironment", {
        method: "GET",
        path: `/environments?select=id,organization_id,project_id,name,kind,is_default,created_at,organizations!inner(organization_members!inner(user_id))&project_id=eq.${q(projectId)}&id=eq.${q(environmentId)}&organizations.organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      return row ? toEnvironment(row) : null;
    },

    async listUsageRecords(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly UsageRecord[]> {
      const found = await rows("listUsageRecords", {
        method: "GET",
        path: `/usage_records?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=recorded_at.desc&limit=500`,
      });
      return found.map(toUsageRecord);
    },

    async recordUsage(input: UsageRecordInput): Promise<UsageRecord> {
      const created = await must<Row[]>("recordUsage", {
        method: "POST",
        path: "/usage_records?select=*",
        prefer: "return=representation",
        body: {
          organization_id: input.organizationId,
          metric: input.metric,
          quantity: input.quantity,
          ...(input.recordedAt ? { recorded_at: input.recordedAt } : {}),
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("recordUsage", "no row returned");
      return toUsageRecord(row);
    },

    async listUsageForService(
      organizationId: OrganizationId,
      metric: string,
      since: string,
    ): Promise<readonly UsageRecord[]> {
      const found = await rows("listUsageForService", {
        method: "GET",
        path: `/usage_records?select=*&organization_id=eq.${q(organizationId)}&metric=eq.${q(metric)}&recorded_at=gte.${q(since)}&limit=5000`,
      });
      return found.map(toUsageRecord);
    },

    async listBudgets(userId: UserId, organizationId: OrganizationId): Promise<readonly Budget[]> {
      const found = await rows("listBudgets", {
        method: "GET",
        path: `/organization_budgets?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=metric.asc`,
      });
      return found.map(toBudget);
    },

    async getBudgetForService(
      organizationId: OrganizationId,
      metric: string,
    ): Promise<Budget | null> {
      const found = await rows("getBudgetForService", {
        method: "GET",
        path: `/organization_budgets?select=*&organization_id=eq.${q(organizationId)}&metric=eq.${q(metric)}&limit=1`,
      });
      const row = found[0];
      return row ? toBudget(row) : null;
    },

    async saveBudget(input: BudgetSaveInput): Promise<Budget> {
      // Upsert on the primary key (organization_id, metric): setting a cap twice
      // replaces it rather than failing, which is what "save the limit" means.
      const created = await must<Row[]>("saveBudget", {
        method: "POST",
        path: "/organization_budgets?select=*&on_conflict=organization_id,metric",
        prefer: "return=representation,resolution=merge-duplicates",
        body: {
          organization_id: input.organizationId,
          metric: input.metric,
          limit_quantity: input.limitQuantity,
          period: "monthly",
          hard_cap: input.hardCap,
          updated_by: input.updatedBy,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("saveBudget", "no row returned");
      return toBudget(row);
    },

    async deleteBudget(
      userId: UserId,
      organizationId: OrganizationId,
      metric: string,
    ): Promise<boolean> {
      const deleted = await rows("deleteBudget", {
        method: "DELETE",
        path: `/organization_budgets?select=organization_id,metric,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&metric=eq.${q(metric)}&organizations.organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
      });
      return deleted.length > 0;
    },

    async listOrchestrationJobs(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly OrchestrationJob[]> {
      const found = await rows("listOrchestrationJobs", {
        method: "GET",
        path: `/orchestration_jobs?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=500`,
      });
      return found.map(toOrchestrationJob);
    },

    async getSecurityPolicy(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<SecurityPolicy | null> {
      const found = await rows("getSecurityPolicy", {
        method: "GET",
        path: `/security_policies?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=version.desc&limit=1`,
      });
      const row = found[0];
      return row ? toPolicy(row) : null;
    },

    async getSecurityPolicyForService(
      organizationId: OrganizationId,
    ): Promise<SecurityPolicy | null> {
      const found = await rows("getSecurityPolicyForService", {
        method: "GET",
        path: `/security_policies?select=*&organization_id=eq.${q(organizationId)}&order=version.desc&limit=1`,
      });
      const row = found[0];
      return row ? toPolicy(row) : null;
    },

    async listSecurityRulesForService(
      organizationId: OrganizationId,
    ): Promise<readonly SecurityRule[]> {
      const found = await rows("listSecurityRulesForService", {
        method: "GET",
        path: `/security_rules?select=*&organization_id=eq.${q(organizationId)}&order=created_at.desc&limit=200`,
      });
      return found.map(toSecurityRule);
    },

    async listTrustedSourcesForService(
      organizationId: OrganizationId,
    ): Promise<readonly TrustedSource[]> {
      const found = await rows("listTrustedSourcesForService", {
        method: "GET",
        path: `/security_trusted_sources?select=*&organization_id=eq.${q(organizationId)}&order=created_at.desc&limit=200`,
      });
      return found.map(toTrustedSource);
    },

    async listRateLimitsForService(organizationId: OrganizationId): Promise<readonly RateLimit[]> {
      const found = await rows("listRateLimitsForService", {
        method: "GET",
        path: `/security_rate_limits?select=*&organization_id=eq.${q(organizationId)}&order=created_at.desc&limit=200`,
      });
      return found.map(toRateLimit);
    },

    async findDomainByHostnameForService(
      organizationId: OrganizationId,
      hostname: string,
    ): Promise<Domain | null> {
      const found = await rows("findDomainByHostnameForService", {
        method: "GET",
        path: `/domains?select=*&organization_id=eq.${q(organizationId)}&hostname=eq.${q(hostname)}&limit=1`,
      });
      const row = found[0];
      return row ? toDomain(row) : null;
    },

    async listRoutableDomainsForService(
      organizationId: OrganizationId,
    ): Promise<readonly Domain[]> {
      const found = await rows("listRoutableDomainsForService", {
        method: "GET",
        path: `/domains?select=*&organization_id=eq.${q(organizationId)}&verified=is.true&order=verified_at.asc`,
      });
      return found.map(toDomain);
    },

    async listPolicyEvents(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly SecurityPolicyEvent[]> {
      const found = await rows("listPolicyEvents", {
        method: "GET",
        path: `/security_policy_events?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=100`,
      });
      return found.map(toPolicyEvent);
    },

    async listSecurityRules(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly SecurityRule[]> {
      const found = await rows("listSecurityRules", {
        method: "GET",
        path: `/security_rules?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=200`,
      });
      return found.map(toSecurityRule);
    },

    async listSecurityEvents(
      userId: UserId,
      organizationId: OrganizationId,
      limit = 100,
    ): Promise<readonly SecurityEvent[]> {
      // A bounded window, newest first: the table is append-only and unbounded
      // by design, so the read states its window rather than paging forever.
      const bounded = Math.max(1, Math.min(limit, 200));
      const found = await rows("listSecurityEvents", {
        method: "GET",
        path: `/security_events?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=observed_at.desc&limit=${bounded}`,
      });
      return found.map(toSecurityEvent);
    },

    async listSecurityIncidents(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly SecurityIncident[]> {
      // Bounded like the decisions read: the table keeps history, and the page
      // states its window rather than paging forever.
      const found = await rows("listSecurityIncidents", {
        method: "GET",
        path: `/security_incidents?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=opened_at.desc&limit=200`,
      });
      return found.map(toSecurityIncident);
    },

    async transitionSecurityIncident(
      input: SecurityIncidentTransitionInput,
    ): Promise<SecurityIncident | null> {
      // The update body carries only the transition columns. The observation
      // columns are not sent at all — sending them would be refused by the
      // column grant in `0019`, and a no-op echo of them would still be a
      // rewrite attempt the trigger has to reject.
      const body: Record<string, unknown> = {
        state: input.state,
        triaged_by: input.triagedBy,
        resolution: input.resolution,
      };
      const updated = await must<Row[]>("transitionSecurityIncident", {
        method: "PATCH",
        path: `/security_incidents?select=organizations!inner(organization_members!inner(user_id))&id=eq.${q(input.incidentId)}&organization_id=eq.${q(input.organizationId)}&organizations.organization_members.user_id=eq.${q(input.triagedBy)}`,
        prefer: "return=representation",
        body,
      });
      const row = Array.isArray(updated) ? updated[0] : undefined;
      // An incident in another organization matches no row: the caller learns
      // nothing rather than being told it exists.
      return row ? toSecurityIncident(row) : null;
    },

    // --------------------------------------------------------------- writes

    async createOrganization(input: {
      name: string;
      slug: string;
      createdBy: UserId;
    }): Promise<Organization> {
      const created = await must<Row[]>("createOrganization", {
        method: "POST",
        path: "/organizations?select=*",
        prefer: "return=representation",
        body: { name: input.name, slug: input.slug, created_by: input.createdBy },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createOrganization", "no row returned");
      const organization = toOrganization(row);

      // The creator becomes owner. The RLS policy permits this exact row: role
      // owner, user_id = auth.uid(), on an organization they created.
      await must<Row[]>("createOrganizationMembership", {
        method: "POST",
        path: "/organization_members",
        prefer: "return=minimal",
        body: {
          organization_id: organization.id,
          user_id: input.createdBy,
          role: "owner",
        },
      });
      return organization;
    },

    async createProject(input: {
      organizationId: OrganizationId;
      name: string;
      slug: string;
      createdBy: UserId;
      executionModel?: ExecutionModel;
      rootDirectory?: string | null;
    }): Promise<Project> {
      const created = await must<Row[]>("createProject", {
        method: "POST",
        path: "/projects?select=*",
        prefer: "return=representation",
        body: {
          organization_id: input.organizationId,
          name: input.name,
          slug: input.slug,
          created_by: input.createdBy,
          ...(input.executionModel ? { execution_model: input.executionModel } : {}),
          ...(input.rootDirectory !== undefined
            ? { root_directory: input.rootDirectory }
            : {}),
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createProject", "no row returned");
      return toProject(row);
    },

    async recordAuditEvent(input: AuditEventInput): Promise<AuditEvent> {
      const created = await must<Row[]>("recordAuditEvent", {
        method: "POST",
        path: "/audit_logs?select=*",
        prefer: "return=representation",
        body: {
          organization_id: input.organizationId,
          actor_id: input.actorId,
          actor_email: input.actorEmail,
          event: input.event,
          target_type: input.targetType ?? null,
          target_id: input.targetId ?? null,
          metadata: input.metadata ?? {},
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("recordAuditEvent", "no row returned");
      return toAuditEvent(row);
    },

    async createDeployment(input: DeploymentCreateInput): Promise<Deployment> {
      const created = await must<Row[]>("createDeployment", {
        method: "POST",
        path: "/deployments?select=*",
        prefer: "return=representation",
        body: {
          organization_id: input.organizationId,
          project_id: input.projectId,
          status: input.status,
          provider: input.provider,
          provider_resource_id: input.providerResourceId,
          url: input.url,
          idempotency_key: input.idempotencyKey,
          requested_by: input.requestedBy,
          failure_reason: input.failureReason,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.environmentId ? { environment_id: input.environmentId } : {}),
          ...(input.staged ? { staged: input.staged } : {}),
          ...(input.gitBranch !== undefined ? { git_branch: input.gitBranch } : {}),
          ...(input.gitCommit !== undefined ? { git_commit: input.gitCommit } : {}),
          ...(input.pullRequest !== undefined ? { pull_request: input.pullRequest } : {}),
          ...(input.previewKey !== undefined ? { preview_key: input.previewKey } : {}),
          ...(input.gitRepository !== undefined ? { git_repository: input.gitRepository } : {}),
          ...(input.buildPack !== undefined ? { build_pack: input.buildPack } : {}),
          ...(input.rootDirectory !== undefined ? { root_directory: input.rootDirectory } : {}),
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createDeployment", "no row returned");
      return toDeployment(row);
    },

    async findDeploymentByIdempotencyKey(
      userId: UserId,
      organizationId: OrganizationId,
      idempotencyKey: string,
    ): Promise<Deployment | null> {
      const found = await rows("findDeploymentByIdempotencyKey", {
        method: "GET",
        path: `/deployments?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&idempotency_key=eq.${q(idempotencyKey)}&organizations.organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      return row ? toDeployment(row) : null;
    },

    async findDeploymentByIdempotencyKeyForService(
      organizationId: OrganizationId,
      idempotencyKey: string,
    ): Promise<Deployment | null> {
      const found = await rows("findDeploymentByIdempotencyKeyForService", {
        method: "GET",
        // No session: `organization_id` is the whole tenant boundary.
        path: `/deployments?select=*&organization_id=eq.${q(organizationId)}&idempotency_key=eq.${q(idempotencyKey)}&limit=1`,
      });
      const row = found[0];
      return row ? toDeployment(row) : null;
    },

    async getDeploymentForService(
      organizationId: OrganizationId,
      deploymentId: DeploymentId,
    ): Promise<Deployment | null> {
      const found = await rows("getDeploymentForService", {
        method: "GET",
        // No session: `organization_id` is the whole tenant boundary.
        path: `/deployments?select=*&organization_id=eq.${q(organizationId)}&id=eq.${q(deploymentId)}&limit=1`,
      });
      const row = found[0];
      return row ? toDeployment(row) : null;
    },

    /**
     * Deployments stranded in a non-terminal state, oldest first.
     *
     * Cross-tenant by design and service-role only: the sweeper looks for rows no
     * tenant list would surface because it does not know the tenants. The filter
     * is `status` plus a `created_at` cutoff, ordered ascending so the oldest
     * stranded row is resolved first and the sweep makes progress across runs.
     */
    async listStrandedDeploymentsForService(
      olderThan: string,
      options?: ListPageOptions | undefined,
    ): Promise<readonly Deployment[]> {
      const limit = resolveListLimit(options?.limit, DEFAULT_LIST_LIMIT);
      const found = await rows("listStrandedDeploymentsForService", {
        method: "GET",
        path: `/deployments?select=*&status=in.(pending,running)&created_at=lt.${q(olderThan)}&order=created_at.asc&limit=${limit}`,
      });
      return found.map(toDeployment);
    },

    /**
     * Advance a deployment's state.
     *
     * Two filters make this safe even with the service role: the row must be in
     * the organization the caller resolved, and it must belong to that tenant's
     * member. The status column has no user-facing UPDATE policy, so this write is
     * only reachable through the service-role connection the API server holds.
     */
    async updateDeploymentStatus(input: DeploymentStatusInput): Promise<Deployment | null> {
      const patch: Record<string, unknown> = { status: input.status };
      if (input.url !== undefined) patch["url"] = input.url;
      if (input.failureReason !== undefined) patch["failure_reason"] = input.failureReason;
      // Set-or-leave, never clear: the engine's deployment handle is written once
      // when the engine issues it, and a later transition (a requeue that still
      // reports `running`) must not erase it. Nothing in Cloud Wai unsets it.
      if (input.providerResourceId != null) {
        patch["provider_resource_id"] = input.providerResourceId;
      }
      if (input.deploymentResourceId != null) {
        patch["deployment_resource_id"] = input.deploymentResourceId;
      }
      if (input.startedAt !== undefined) patch["started_at"] = input.startedAt;
      if (input.finishedAt !== undefined) patch["finished_at"] = input.finishedAt;

      const updated = await rows("updateDeploymentStatus", {
        method: "PATCH",
        path: `/deployments?select=*&id=eq.${q(input.id)}&organization_id=eq.${q(input.organizationId)}`,
        prefer: "return=representation",
        body: patch,
      });
      const row = updated[0];
      return row ? toDeployment(row) : null;
    },

    async setProjectProviderResource(input: ProjectProviderInput): Promise<Project | null> {
      const updated = await rows("setProjectProviderResource", {
        method: "PATCH",
        path: `/projects?select=*&id=eq.${q(input.projectId)}&organization_id=eq.${q(input.organizationId)}`,
        prefer: "return=representation",
        body: {
          provider: input.provider,
          provider_resource_id: input.providerResourceId,
        },
      });
      const row = updated[0];
      return row ? toProject(row) : null;
    },

    /**
     * Move the production pointer to a deployment.
     *
     * The move is one database function so the old flag is cleared and the new
     * one set atomically: a reader between two separate PATCHes would see either
     * zero live deployments or, worse, two. The function is SECURITY DEFINER and
     * only `service_role` may execute it, because it writes an engine-owned
     * column the guard trigger would otherwise refuse.
     *
     * A `false` from the function is the honest "this deployment cannot be made
     * live" (a preview, an in-flight build, a failed run, a row in another
     * tenant); this method never turns that into a success.
     */
    async promoteDeployment(input: PromoteDeploymentInput): Promise<PromoteDeploymentResult> {
      const project = await rows("promoteDeployment:project", {
        method: "GET",
        path: `/projects?select=production_deployment_id&id=eq.${q(input.projectId)}&organization_id=eq.${q(input.organizationId)}&limit=1`,
      });
      const previous = project[0] ? nullableStr(project[0], "production_deployment_id") : null;

      const moved = await must<boolean>("promoteDeployment", {
        method: "POST",
        path: "/rpc/promote_deployment",
        body: {
          p_organization_id: input.organizationId,
          p_project_id: input.projectId,
          p_deployment_id: input.deploymentId,
        },
      });
      // A refused move changes nothing, so report the deployment that is still
      // live rather than a row that was never promoted.
      if (moved !== true) return { deployment: null, previousDeploymentId: previous };

      const promoted = await rows("promoteDeployment:read", {
        method: "GET",
        path: `/deployments?select=*&id=eq.${q(input.deploymentId)}&organization_id=eq.${q(input.organizationId)}&limit=1`,
      });
      const row = promoted[0];
      return { deployment: row ? toDeployment(row) : null, previousDeploymentId: previous };
    },

    async updateProject(input: ProjectUpdateInput): Promise<Project | null> {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch["name"] = input.name;
      if (input.slug !== undefined) patch["slug"] = input.slug;
      if (input.executionModel !== undefined) patch["execution_model"] = input.executionModel;
      if (input.rootDirectory !== undefined) patch["root_directory"] = input.rootDirectory;
      if (Object.keys(patch).length === 0) return null;

      const updated = await rows("updateProject", {
        method: "PATCH",
        path: `/projects?select=*&id=eq.${q(input.projectId)}&organization_id=eq.${q(input.organizationId)}`,
        prefer: "return=representation",
        body: patch,
      });
      const row = updated[0];
      return row ? toProject(row) : null;
    },

    async getProjectDeploymentTarget(
      userId: UserId,
      projectId: ProjectId,
    ): Promise<ProjectDeploymentTarget | null> {
      const found = await rows("getProjectDeploymentTarget", {
        method: "GET",
        path: `/projects?select=provider,provider_resource_id,execution_model,root_directory,organizations!inner(organization_members!inner(user_id))&id=eq.${q(projectId)}&organizations.organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      if (!row) return null;
      return {
        provider: nullableStr(row, "provider"),
        providerResourceId: nullableStr(row, "provider_resource_id"),
        executionModel: executionModel(row),
        rootDirectory: nullableStr(row, "root_directory"),
      };
    },

    async getProjectDeploymentTargetForService(
      organizationId: OrganizationId,
      projectId: ProjectId,
    ): Promise<ProjectDeploymentTarget | null> {
      const found = await rows("getProjectDeploymentTargetForService", {
        method: "GET",
        path: `/projects?select=provider,provider_resource_id,execution_model,root_directory&id=eq.${q(projectId)}&organization_id=eq.${q(organizationId)}&limit=1`,
      });
      const row = found[0];
      if (!row) return null;
      return {
        provider: nullableStr(row, "provider"),
        providerResourceId: nullableStr(row, "provider_resource_id"),
        executionModel: executionModel(row),
        rootDirectory: nullableStr(row, "root_directory"),
      };
    },

    async saveSecurityPolicy(input: SecurityPolicyInput): Promise<SecurityPolicy> {
      // Upsert on (organization_id, name); the version is supplied by the
      // caller and is monotonic, so a concurrent apply loses rather than
      // silently rewinding the edge's configuration.
      const saved = await must<Row[]>("saveSecurityPolicy", {
        method: "POST",
        path: "/security_policies?select=*&on_conflict=organization_id,name",
        prefer: "return=representation,resolution=merge-duplicates",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          name: input.name,
          risk_level: input.riskLevel,
          action: input.action,
          state: input.state,
          protection_mode: input.protectionMode,
          protection_expires_at: input.protectionExpiresAt,
          version: input.version,
          created_by: input.createdBy,
        },
      });
      const row = Array.isArray(saved) ? saved[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("saveSecurityPolicy", "no row returned");
      return toPolicy(row);
    },

    async recordPolicyEvent(input: PolicyEventInput): Promise<SecurityPolicyEvent> {
      const created = await must<Row[]>("recordPolicyEvent", {
        method: "POST",
        path: "/security_policy_events?select=*",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          policy_id: input.policyId,
          from_state: input.fromState,
          to_state: input.toState,
          version: input.version,
          actor_id: input.actorId,
          actor_email: input.actorEmail,
          detail: input.detail,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("recordPolicyEvent", "no row returned");
      return toPolicyEvent(row);
    },

    async openSecurityIncidentForService(
      input: SecurityIncidentCreateInput,
    ): Promise<SecurityIncident> {
      // Service-role write: `0019` drops the client insert grant, because an
      // incident is the control plane's observation of a signal, not something a
      // browser may assert. `state` is left to its `open` default.
      const created = await must<Row[]>("openSecurityIncidentForService", {
        method: "POST",
        path: "/security_incidents?select=*",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          kind: input.kind,
          severity: input.severity,
          summary: input.summary,
          opened_at: input.openedAt,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row)
        throw new ControlPlaneUnavailableError("openSecurityIncidentForService", "no row returned");
      return toSecurityIncident(row);
    },

    async createSecurityRule(input: SecurityRuleCreateInput): Promise<SecurityRule> {
      const created = await must<Row[]>("createSecurityRule", {
        method: "POST",
        path: "/security_rules?select=*",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          kind: input.kind,
          value: input.value,
          note: input.note,
          created_by: input.createdBy,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createSecurityRule", "no row returned");
      return toSecurityRule(row);
    },

    async deleteSecurityRule(
      userId: UserId,
      organizationId: OrganizationId,
      ruleId: string,
    ): Promise<boolean> {
      // Membership is re-asserted in the where clause: a service-role connection
      // must not turn this into a cross-tenant delete.
      await must<Row[]>("deleteSecurityRule", {
        method: "DELETE",
        path: `/security_rules?select=organizations!inner(organization_members!inner(user_id))&id=eq.${q(ruleId)}&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
      });
      return true;
    },

    async listTrustedSources(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly TrustedSource[]> {
      const found = await rows("listTrustedSources", {
        method: "GET",
        path: `/security_trusted_sources?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=200`,
      });
      return found.map(toTrustedSource);
    },

    async createTrustedSource(input: TrustedSourceCreateInput): Promise<TrustedSource> {
      const created = await must<Row[]>("createTrustedSource", {
        method: "POST",
        path: "/security_trusted_sources?select=*",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          kind: input.kind,
          value: input.value,
          note: input.note,
          created_by: input.createdBy,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createTrustedSource", "no row returned");
      return toTrustedSource(row);
    },

    async deleteTrustedSource(
      userId: UserId,
      organizationId: OrganizationId,
      sourceId: string,
    ): Promise<boolean> {
      await must<Row[]>("deleteTrustedSource", {
        method: "DELETE",
        path: `/security_trusted_sources?select=organizations!inner(organization_members!inner(user_id))&id=eq.${q(sourceId)}&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
      });
      return true;
    },

    async listRateLimits(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly RateLimit[]> {
      const found = await rows("listRateLimits", {
        method: "GET",
        path: `/security_rate_limits?select=*,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=200`,
      });
      return found.map(toRateLimit);
    },

    async createRateLimit(input: RateLimitCreateInput): Promise<RateLimit> {
      const created = await must<Row[]>("createRateLimit", {
        method: "POST",
        path: "/security_rate_limits?select=*",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          key: input.key,
          header_name: input.headerName,
          limit_count: input.limit,
          window_seconds: input.windowSeconds,
          note: input.note,
          created_by: input.createdBy,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createRateLimit", "no row returned");
      return toRateLimit(row);
    },

    async deleteRateLimit(
      userId: UserId,
      organizationId: OrganizationId,
      rateLimitId: string,
    ): Promise<boolean> {
      await must<Row[]>("deleteRateLimit", {
        method: "DELETE",
        path: `/security_rate_limits?select=organizations!inner(organization_members!inner(user_id))&id=eq.${q(rateLimitId)}&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
      });
      return true;
    },

    async createDomain(input: DomainCreateInput): Promise<Domain> {
      const created = await must<Row[]>("createDomain", {
        method: "POST",
        path: "/domains?select=*",
        prefer: "return=representation",
        // `verified` is deliberately absent: it defaults to false, and only the
        // edge may set it.
        body: {
          id: input.id,
          organization_id: input.organizationId,
          project_id: input.projectId,
          hostname: input.hostname,
          verification_token: input.verificationToken,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createDomain", "no row returned");
      return toDomain(row);
    },

    async createDataResource(input: DataResourceCreateInput): Promise<DataResource> {
      const created = await must<Row[]>("createDataResource", {
        method: "POST",
        path: "/data_resources?select=*",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          project_id: input.projectId,
          kind: input.kind,
          name: input.name,
          state: input.state,
          provider: input.provider,
          provider_resource_id: input.providerResourceId,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createDataResource", "no row returned");
      return toDataResource(row);
    },

    async createDataBackup(input: DataBackupCreateInput): Promise<DataBackup> {
      const created = await must<Row[]>("createDataBackup", {
        method: "POST",
        path: "/data_backups?select=*",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          data_resource_id: input.dataResourceId,
          provider: input.provider,
          status: input.status,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createDataBackup", "no row returned");
      return toDataBackup(row);
    },

    async setDataResourceState(input: DataResourceStateInput): Promise<DataResource | null> {
      // `organization_id` is in the filter, not only in the body: a transition
      // can only touch a row in the tenant it was resolved for, even though the
      // write runs with the service role.
      const body: Record<string, unknown> = { state: input.state };
      if (input.provider !== undefined) body["provider"] = input.provider;
      if (input.providerResourceId !== undefined) {
        body["provider_resource_id"] = input.providerResourceId;
      }
      const updated = await rows("setDataResourceState", {
        method: "PATCH",
        path: `/data_resources?select=*&id=eq.${q(input.id)}&organization_id=eq.${q(input.organizationId)}`,
        prefer: "return=representation",
        body,
      });
      const row = updated[0];
      return row ? toDataResource(row) : null;
    },

    async updateDataBackupStatus(input: DataBackupStatusInput): Promise<DataBackup | null> {
      const body: Record<string, unknown> = { status: input.status };
      if (input.providerResourceId !== undefined) {
        body["provider_resource_id"] = input.providerResourceId;
      }
      if (input.sizeBytes !== undefined) body["size_bytes"] = input.sizeBytes;
      if (input.finishedAt !== undefined) body["finished_at"] = input.finishedAt;
      const updated = await rows("updateDataBackupStatus", {
        method: "PATCH",
        path: `/data_backups?select=*&id=eq.${q(input.id)}&organization_id=eq.${q(input.organizationId)}`,
        prefer: "return=representation",
        body,
      });
      const row = updated[0];
      return row ? toDataBackup(row) : null;
    },

    async getDataBackupForService(
      organizationId: OrganizationId,
      backupId: string,
    ): Promise<DataBackup | null> {
      const found = await rows("getDataBackupForService", {
        method: "GET",
        path: `/data_backups?select=*&id=eq.${q(backupId)}&organization_id=eq.${q(organizationId)}&limit=1`,
      });
      const row = found[0];
      return row ? toDataBackup(row) : null;
    },

    async createDataRestore(input: DataRestoreCreateInput): Promise<DataRestore> {
      const created = await must<Row[]>("createDataRestore", {
        method: "POST",
        path: "/data_restores?select=*",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          backup_id: input.backupId,
          data_resource_id: input.dataResourceId,
          provider: input.provider,
          status: input.status,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createDataRestore", "no row returned");
      return toDataRestore(row);
    },

    async updateDataRestoreStatus(input: DataRestoreStatusInput): Promise<DataRestore | null> {
      const body: Record<string, unknown> = { status: input.status };
      if (input.providerResourceId !== undefined) {
        body["provider_resource_id"] = input.providerResourceId;
      }
      if (input.finishedAt !== undefined) body["finished_at"] = input.finishedAt;
      const updated = await rows("updateDataRestoreStatus", {
        method: "PATCH",
        path: `/data_restores?select=*&id=eq.${q(input.id)}&organization_id=eq.${q(input.organizationId)}`,
        prefer: "return=representation",
        body,
      });
      const row = updated[0];
      return row ? toDataRestore(row) : null;
    },

    async listDataRestores(
      userId: UserId,
      resourceId: DataResourceId,
    ): Promise<readonly DataRestore[]> {
      const found = await rows("listDataRestores", {
        method: "GET",
        path: `/data_restores?select=*,organizations!inner(organization_members!inner(user_id))&data_resource_id=eq.${q(resourceId)}&organizations.organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=50`,
      });
      return found.map(toDataRestore);
    },

    async createApiKey(input: ApiKeyCreateInput): Promise<ApiKeySummary> {
      const created = await must<Row[]>("createApiKey", {
        method: "POST",
        path: "/api_keys?select=id,organization_id,name,key_prefix,scopes,last_used_at,revoked_at,created_at",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          name: input.name,
          key_hash: input.keyHash,
          key_prefix: input.keyPrefix,
          owner_id: input.ownerId,
          scopes: input.scopes,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createApiKey", "no row returned");
      return toApiKey(row);
    },

    async revokeApiKey(
      userId: UserId,
      organizationId: OrganizationId,
      keyId: ApiKeyId,
    ): Promise<boolean> {
      const updated = await rows("revokeApiKey", {
        method: "PATCH",
        path: `/api_keys?select=id,organization_id,name,key_prefix,scopes,last_used_at,revoked_at,created_at,organizations!inner(organization_members!inner(user_id))&id=eq.${q(keyId)}&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
        body: { revoked_at: iso() },
      });
      return updated.length > 0;
    },

    /**
     * The key row behind a presented secret, addressed by the hash of it.
     *
     * The hash is `unique` in the schema, so this is at most one row. Reads run
     * with the service role because a key is not yet a session: there is no
     * `auth.uid()` to scope by, and `api_keys` has no client SELECT policy that
     * could match a not-yet-authenticated caller. The row carries the tenant, so
     * the caller does not have to trust or look one up.
     */
    async findApiKeyByHash(hash: string): Promise<ResolvedApiKey | null> {
      const found = await rows("findApiKeyByHash", {
        method: "GET",
        path: `/api_keys?select=id,organization_id,owner_id,scopes,created_at,revoked_at&key_hash=eq.${q(hash)}&limit=1`,
      });
      const row = found[0];
      if (!row) return null;
      return {
        id: str(row, "id") as ApiKeyId,
        organizationId: str(row, "organization_id") as OrganizationId,
        ownerId: str(row, "owner_id") as UserId,
        scopes: strArray(row, "scopes"),
        createdAt: str(row, "created_at"),
        revokedAt: nullableStr(row, "revoked_at"),
      };
    },

    /**
     * Record that a key authenticated a request.
     *
     * Bounded by `organization_id` as well as the id, so a stale key id from
     * another tenant can never be stamped. This is the only write a key-auth
     * request performs, and it is deliberately not failure-fatal: a lost
     * `last_used_at` update must not fail an otherwise valid request.
     */
    async markApiKeyUsed(input: {
      readonly organizationId: OrganizationId;
      readonly keyId: ApiKeyId;
    }): Promise<void> {
      await must<Row[]>("markApiKeyUsed", {
        method: "PATCH",
        path: `/api_keys?select=id&id=eq.${q(input.keyId)}&organization_id=eq.${q(input.organizationId)}`,
        prefer: "return=representation",
        body: { last_used_at: iso() },
      });
    },

    /**
     * A profile row by user id.
     *
     * Service-role, because the key path has no session to satisfy
     * `profiles_select`. Only the email is selected: the audit trail needs an
     * actor address and nothing else here, so the read cannot leak more than
     * that even if a caller mishandled the result.
     */
    async getProfileForService(userId: UserId): Promise<{ readonly email: string } | null> {
      const found = await rows("getProfileForService", {
        method: "GET",
        path: `/profiles?select=email&id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      if (!row) return null;
      const email = nullableStr(row, "email");
      return email === null ? null : { email };
    },

    async createGitLink(input: GitLinkCreateInput): Promise<ProjectGitLink> {
      const created = await must<Row[]>("createGitLink", {
        method: "POST",
        // The service role bypasses the client grant, so the ciphertext is
        // returned here — this method is never on a browser-facing read path.
        path: "/project_git_links?select=*",
        prefer: "return=representation",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          project_id: input.projectId,
          provider: input.provider,
          repository: input.repository,
          production_branch: input.productionBranch,
          previews_enabled: input.previewsEnabled,
          secret_encrypted: input.secretEncrypted,
          secret_prefix: input.secretPrefix,
          created_by: input.createdBy,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createGitLink", "no row returned");
      return toGitLink(row);
    },

    async getGitLinkForService(
      organizationId: OrganizationId,
      linkId: string,
    ): Promise<ProjectGitLink | null> {
      const found = await rows("getGitLinkForService", {
        method: "GET",
        // The service role bypasses the client grant. `organization_id` is the
        // tenant boundary, because the receiver has no session to join on.
        path: `/project_git_links?select=id,organization_id,project_id,provider,repository,production_branch,previews_enabled,secret_prefix,created_by,created_at&id=eq.${q(linkId)}&organization_id=eq.${q(organizationId)}&limit=1`,
      });
      const row = found[0];
      return row ? toGitLink(row) : null;
    },

    async getGitLinkSecret(organizationId: OrganizationId, linkId: string): Promise<string | null> {
      const found = await rows("getGitLinkSecret", {
        method: "GET",
        path: `/project_git_links?select=secret_encrypted&id=eq.${q(linkId)}&organization_id=eq.${q(organizationId)}&limit=1`,
      });
      const row = found[0];
      return row ? nullableStr(row, "secret_encrypted") : null;
    },

    async deleteGitLink(
      userId: UserId,
      organizationId: OrganizationId,
      linkId: string,
    ): Promise<boolean> {
      const deleted = await rows("deleteGitLink", {
        method: "DELETE",
        path: `/project_git_links?select=id,organizations!inner(organization_members!inner(user_id))&id=eq.${q(linkId)}&organization_id=eq.${q(organizationId)}&organizations.organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
      });
      return deleted.length > 0;
    },

    async saveEnvVar(input: EnvVarSaveInput): Promise<ProjectEnvVar> {
      const saved = await must<Row[]>("saveEnvVar", {
        method: "POST",
        // An upsert on (project_id, environment_id, key): setting a variable that
        // exists replaces its value and flags rather than failing, which is what
        // "save" means. The conflict target is the unique index from `0025`, so a
        // Preview row and a Production row with one key stay distinct. The service
        // role bypasses the client grant, so the ciphertext is returned here —
        // this method is not on a browser-facing read path.
        path: "/project_env_vars?select=id,organization_id,project_id,environment_id,key,value_prefix,is_build_time,updated_by,created_at,updated_at&on_conflict=project_id,environment_id,key",
        prefer: "return=representation,resolution=merge-duplicates",
        body: {
          id: input.id,
          organization_id: input.organizationId,
          project_id: input.projectId,
          environment_id: input.environmentId,
          key: input.key,
          value_encrypted: input.valueEncrypted,
          value_prefix: input.valuePrefix,
          is_build_time: input.isBuildTime,
          updated_by: input.updatedBy,
        },
      });
      const row = Array.isArray(saved) ? saved[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("saveEnvVar", "no row returned");
      return toEnvVar(row);
    },

    async listEnvVarsForService(
      organizationId: OrganizationId,
      projectId: ProjectId,
      environmentId: EnvironmentId,
    ): Promise<readonly ProjectEnvVarSecret[]> {
      const found = await rows("listEnvVarsForService", {
        method: "GET",
        // Service role only: this read returns the ciphertext, so it is on the
        // write interface where no browser-facing path can reach it. The tenant
        // in the where clause is the boundary for a session-less worker, and the
        // environment is what selects Preview values for a preview build.
        path: `/project_env_vars?select=id,organization_id,project_id,environment_id,key,value_prefix,is_build_time,updated_by,created_at,updated_at,value_encrypted,engine_ref&organization_id=eq.${q(organizationId)}&project_id=eq.${q(projectId)}&environment_id=eq.${q(environmentId)}&order=key.asc`,
      });
      return found.map(toEnvVarSecret);
    },

    async setEnvVarEngineRef(input: {
      readonly organizationId: OrganizationId;
      readonly projectId: ProjectId;
      readonly environmentId: EnvironmentId;
      readonly key: string;
      readonly engineRef: string;
      readonly provider: string | null;
      readonly providerResourceId: string | null;
    }): Promise<ProjectEnvVar | null> {
      const updated = await rows("setEnvVarEngineRef", {
        method: "PATCH",
        path: `/project_env_vars?select=id,organization_id,project_id,environment_id,key,value_prefix,is_build_time,updated_by,created_at,updated_at&organization_id=eq.${q(input.organizationId)}&project_id=eq.${q(input.projectId)}&environment_id=eq.${q(input.environmentId)}&key=eq.${q(input.key)}`,
        prefer: "return=representation",
        body: {
          engine_ref: input.engineRef,
          provider: input.provider,
          provider_resource_id: input.providerResourceId,
        },
      });
      const row = updated[0];
      return row ? toEnvVar(row) : null;
    },

    async getEnvVarEngineRef(
      userId: UserId,
      organizationId: OrganizationId,
      projectId: ProjectId,
      environmentId: EnvironmentId,
      key: string,
    ): Promise<string | null> {
      const found = await rows("getEnvVarEngineRef", {
        method: "GET",
        path: `/project_env_vars?select=engine_ref,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&project_id=eq.${q(projectId)}&environment_id=eq.${q(environmentId)}&key=eq.${q(key)}&organizations.organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      return found.length > 0 ? nullableStr(found[0]!, "engine_ref") : null;
    },

    async deleteEnvVar(
      userId: UserId,
      organizationId: OrganizationId,
      projectId: ProjectId,
      environmentId: EnvironmentId,
      key: string,
    ): Promise<boolean> {
      const deleted = await rows("deleteEnvVar", {
        method: "DELETE",
        path: `/project_env_vars?select=id,organizations!inner(organization_members!inner(user_id))&organization_id=eq.${q(organizationId)}&project_id=eq.${q(projectId)}&environment_id=eq.${q(environmentId)}&key=eq.${q(key)}&organizations.organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
      });
      return deleted.length > 0;
    },

    async listEnvironmentsForService(
      organizationId: OrganizationId,
      projectId: ProjectId,
    ): Promise<readonly ProjectEnvironment[]> {
      const found = await rows("listEnvironmentsForService", {
        method: "GET",
        // Service role: the worker has no session, so `organization_id` is the
        // tenant boundary, exactly like `getProjectDeploymentTargetForService`.
        path: `/environments?select=id,organization_id,project_id,name,kind,is_default,created_at&organization_id=eq.${q(organizationId)}&project_id=eq.${q(projectId)}&order=kind.asc,name.asc`,
      });
      return found.map(toEnvironment);
    },

    async getPreviewTargetForService(
      organizationId: OrganizationId,
      projectId: ProjectId,
      previewKey: string,
    ): Promise<PreviewTarget | null> {
      const found = await rows("getPreviewTargetForService", {
        method: "GET",
        path: `/preview_targets?select=id,organization_id,project_id,preview_key,branch,pull_request,provider,provider_resource_id&organization_id=eq.${q(organizationId)}&project_id=eq.${q(projectId)}&preview_key=eq.${q(previewKey)}&limit=1`,
      });
      const row = found[0];
      return row ? toPreviewTarget(row) : null;
    },

    async createPreviewTarget(input: {
      readonly organizationId: OrganizationId;
      readonly projectId: ProjectId;
      readonly previewKey: string;
      readonly branch: string | null;
      readonly pullRequest: number | null;
      readonly createdBy: UserId;
    }): Promise<PreviewTarget> {
      const created = await must<Row[]>("createPreviewTarget", {
        method: "POST",
        path: "/preview_targets?select=id,organization_id,project_id,preview_key,branch,pull_request,provider,provider_resource_id",
        prefer: "return=representation",
        body: {
          organization_id: input.organizationId,
          project_id: input.projectId,
          preview_key: input.previewKey,
          branch: input.branch,
          pull_request: input.pullRequest,
          created_by: input.createdBy,
        },
      });
      const row = Array.isArray(created) ? created[0] : undefined;
      if (!row) throw new ControlPlaneUnavailableError("createPreviewTarget", "no row returned");
      return toPreviewTarget(row);
    },

    async setPreviewTargetProvider(input: {
      readonly organizationId: OrganizationId;
      readonly projectId: ProjectId;
      readonly previewKey: string;
      readonly provider: string;
      readonly providerResourceId: string;
    }): Promise<PreviewTarget | null> {
      const updated = await rows("setPreviewTargetProvider", {
        method: "PATCH",
        path: `/preview_targets?select=id,organization_id,project_id,preview_key,branch,pull_request,provider,provider_resource_id&organization_id=eq.${q(input.organizationId)}&project_id=eq.${q(input.projectId)}&preview_key=eq.${q(input.previewKey)}`,
        prefer: "return=representation",
        body: { provider: input.provider, provider_resource_id: input.providerResourceId },
      });
      const row = updated[0];
      return row ? toPreviewTarget(row) : null;
    },
  };
}
