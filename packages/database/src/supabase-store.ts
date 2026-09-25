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
  GitLinkCreateInput,
  Organization,
  OrganizationMember,
  OrchestrationJob,
  PolicyEventInput,
  PreviewTarget,
  Project,
  ProjectDeploymentTarget,
  ProjectGitLink,
  ProjectProviderInput,
  ProjectUpdateInput,
  SecurityPolicy,
  SecurityPolicyEvent,
  SecurityPolicyInput,
  SecurityRule,
  SecurityRuleCreateInput,
  UsageRecord,
  UsageRecordInput,
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
      createdAt: str(row, "created_at"),
    };
  }

  /**
   * A membership joined with its profile.
   *
   * PostgREST returns an embedded table as an array here (a to-one embed is
   * still shaped as a list by the client), so the profile is read from the first
   * element. A missing profile is a null address, never a fabricated one.
   */
  function toOrganizationMember(row: Row): OrganizationMember {
    const embedded = row["profiles"];
    const profile = Array.isArray(embedded) ? (embedded[0] as Row | undefined) : undefined;
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
      gitBranch: nullableStr(row, "git_branch"),
      gitCommit: nullableStr(row, "git_commit"),
      pullRequest: nullableNum(row, "pull_request"),
      previewKey: nullableStr(row, "preview_key"),
      providerResourceId: nullableStr(row, "provider_resource_id"),
      deploymentResourceId: nullableStr(row, "deployment_resource_id"),
      failureReason: nullableStr(row, "failure_reason"),
      createdAt: str(row, "created_at"),
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
        path: `/organizations?select=*&organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
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
        path: `/organization_members?select=*,profiles(email,display_name)&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.asc&limit=200`,
      });
      return found.map(toOrganizationMember);
    },

    async listProjects(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly Project[]> {
      const found = await rows("listProjects", {
        method: "GET",
        path: `/projects?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toProject);
    },

    async getProject(userId: UserId, projectId: ProjectId): Promise<Project | null> {
      const found = await rows("getProject", {
        method: "GET",
        path: `/projects?select=*&id=eq.${q(projectId)}&organization_members.user_id=eq.${q(userId)}&limit=1`,
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

    async listDeployments(userId: UserId, projectId: ProjectId): Promise<readonly Deployment[]> {
      const found = await rows("listDeployments", {
        method: "GET",
        path: `/deployments?select=*&project_id=eq.${q(projectId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=100`,
      });
      return found.map(toDeployment);
    },

    async getDeployment(userId: UserId, deploymentId: DeploymentId): Promise<Deployment | null> {
      const found = await rows("getDeployment", {
        method: "GET",
        path: `/deployments?select=*&id=eq.${q(deploymentId)}&organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      return row ? toDeployment(row) : null;
    },

    async listAuditEvents(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly AuditEvent[]> {
      const found = await rows("listAuditEvents", {
        method: "GET",
        path: `/audit_logs?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=200`,
      });
      return found.map(toAuditEvent);
    },

    async listDomains(userId: UserId, organizationId: OrganizationId): Promise<readonly Domain[]> {
      const found = await rows("listDomains", {
        method: "GET",
        path: `/domains?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toDomain);
    },

    async getDomain(userId: UserId, domainId: DomainId): Promise<Domain | null> {
      const found = await rows("getDomain", {
        method: "GET",
        path: `/domains?select=*&id=eq.${q(domainId)}&organization_members.user_id=eq.${q(userId)}&limit=1`,
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
        path: `/domains?select=id&id=eq.${q(domainId)}&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}`,
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
        path: `/data_resources?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toDataResource);
    },

    async getDataResource(
      userId: UserId,
      resourceId: DataResourceId,
    ): Promise<DataResource | null> {
      const found = await rows("getDataResource", {
        method: "GET",
        path: `/data_resources?select=*&id=eq.${q(resourceId)}&organization_members.user_id=eq.${q(userId)}&limit=1`,
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
        path: `/data_backups?select=*&data_resource_id=eq.${q(resourceId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=50`,
      });
      return found.map(toDataBackup);
    },

    async listApiKeys(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly ApiKeySummary[]> {
      const found = await rows("listApiKeys", {
        method: "GET",
        path: `/api_keys?select=id,organization_id,name,key_prefix,scopes,last_used_at,revoked_at,created_at&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toApiKey);
    },

    async listGitLinks(userId: UserId, projectId: ProjectId): Promise<readonly ProjectGitLink[]> {
      const found = await rows("listGitLinks", {
        method: "GET",
        // The secret columns are not named here, and are not in the client
        // SELECT grant either, so even a widened select cannot return them.
        path: `/project_git_links?select=id,organization_id,project_id,provider,repository,production_branch,previews_enabled,secret_prefix,created_by,created_at&project_id=eq.${q(projectId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc`,
      });
      return found.map(toGitLink);
    },

    async listUsageRecords(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly UsageRecord[]> {
      const found = await rows("listUsageRecords", {
        method: "GET",
        path: `/usage_records?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=recorded_at.desc&limit=500`,
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
        path: `/organization_budgets?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=metric.asc`,
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
        path: `/organization_budgets?select=organization_id,metric&organization_id=eq.${q(organizationId)}&metric=eq.${q(metric)}&organization_members.user_id=eq.${q(userId)}`,
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
        path: `/orchestration_jobs?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=500`,
      });
      return found.map(toOrchestrationJob);
    },

    async getSecurityPolicy(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<SecurityPolicy | null> {
      const found = await rows("getSecurityPolicy", {
        method: "GET",
        path: `/security_policies?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=version.desc&limit=1`,
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

    async listPolicyEvents(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly SecurityPolicyEvent[]> {
      const found = await rows("listPolicyEvents", {
        method: "GET",
        path: `/security_policy_events?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=100`,
      });
      return found.map(toPolicyEvent);
    },

    async listSecurityRules(
      userId: UserId,
      organizationId: OrganizationId,
    ): Promise<readonly SecurityRule[]> {
      const found = await rows("listSecurityRules", {
        method: "GET",
        path: `/security_rules?select=*&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=200`,
      });
      return found.map(toSecurityRule);
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
          ...(input.gitBranch !== undefined ? { git_branch: input.gitBranch } : {}),
          ...(input.gitCommit !== undefined ? { git_commit: input.gitCommit } : {}),
          ...(input.pullRequest !== undefined ? { pull_request: input.pullRequest } : {}),
          ...(input.previewKey !== undefined ? { preview_key: input.previewKey } : {}),
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
        path: `/deployments?select=*&organization_id=eq.${q(organizationId)}&idempotency_key=eq.${q(idempotencyKey)}&organization_members.user_id=eq.${q(userId)}&limit=1`,
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

    async updateProject(input: ProjectUpdateInput): Promise<Project | null> {
      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch["name"] = input.name;
      if (input.slug !== undefined) patch["slug"] = input.slug;
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
        path: `/projects?select=provider,provider_resource_id&id=eq.${q(projectId)}&organization_members.user_id=eq.${q(userId)}&limit=1`,
      });
      const row = found[0];
      if (!row) return null;
      return {
        provider: nullableStr(row, "provider"),
        providerResourceId: nullableStr(row, "provider_resource_id"),
      };
    },

    async getProjectDeploymentTargetForService(
      organizationId: OrganizationId,
      projectId: ProjectId,
    ): Promise<ProjectDeploymentTarget | null> {
      const found = await rows("getProjectDeploymentTargetForService", {
        method: "GET",
        path: `/projects?select=provider,provider_resource_id&id=eq.${q(projectId)}&organization_id=eq.${q(organizationId)}&limit=1`,
      });
      const row = found[0];
      if (!row) return null;
      return {
        provider: nullableStr(row, "provider"),
        providerResourceId: nullableStr(row, "provider_resource_id"),
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
        path: `/security_rules?id=eq.${q(ruleId)}&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}`,
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
        path: `/data_restores?select=*&data_resource_id=eq.${q(resourceId)}&organization_members.user_id=eq.${q(userId)}&order=created_at.desc&limit=50`,
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
        path: `/api_keys?select=id,organization_id,name,key_prefix,scopes,last_used_at,revoked_at,created_at&id=eq.${q(keyId)}&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
        body: { revoked_at: iso() },
      });
      return updated.length > 0;
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
        path: `/project_git_links?select=id&id=eq.${q(linkId)}&organization_id=eq.${q(organizationId)}&organization_members.user_id=eq.${q(userId)}`,
        prefer: "return=representation",
      });
      return deleted.length > 0;
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
