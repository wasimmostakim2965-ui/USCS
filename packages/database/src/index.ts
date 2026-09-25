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
  JobState,
  OrganizationId,
  ProjectId,
  UserId,
} from "@cloud-wai/contracts";
import type { Membership, OrgRole } from "@cloud-wai/authorization";

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
  /**
   * The members of an organization, oldest first.
   *
   * Scoped to a caller who is a member, exactly like every other read: the
   * store re-filters by user so the list is correct even when the server holds
   * a service-role key. Emails and names come from `profiles`, which RLS
   * exposes to a co-member, so this never widens who can see whose address.
   */
  listOrganizationMembers(
    userId: UserId,
    organizationId: OrganizationId,
  ): Promise<readonly OrganizationMember[]>;
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
  /**
   * Usage records for an organization, newest first.
   *
   * `usage_records` is readable by any member through RLS and writable only by
   * the service role, but no code in this build writes one: there is no adapter
   * that reports a metric and no job that records one, so this read is always
   * empty today. This is a read — it never writes a usage row, and there is no
   * procedure that lets a client assert usage.
   */
  listUsageRecords(userId: UserId, organizationId: OrganizationId): Promise<readonly UsageRecord[]>;
  /**
   * Orchestration jobs for an organization, newest first.
   *
   * These are the platform's own units of work — a deployment, a backup, a
   * policy distribution — and the only honest source of an observability view:
   * their state, attempts and timestamps are written by the worker and the
   * engine, never by a client. `orchestration_jobs` is service-role written and
   * member-readable through RLS, so a member sees this organization's jobs and
   * nothing else. This is a read; no method writes a job.
   */
  listOrchestrationJobs(
    userId: UserId,
    organizationId: OrganizationId,
  ): Promise<readonly OrchestrationJob[]>;
  /** Persist a newly issued key. The secret is never part of this input. */
  createApiKey(input: ApiKeyCreateInput): Promise<ApiKeySummary>;
  /** Revoke a key. Idempotent: revoking a revoked key succeeds. */
  revokeApiKey(userId: UserId, organizationId: OrganizationId, keyId: ApiKeyId): Promise<boolean>;
  /**
   * The repositories linked to a project, newest first.
   *
   * Membership-scoped like every read. The webhook secret ciphertext is never
   * part of this shape, so a list response cannot leak it.
   */
  listGitLinks(userId: UserId, projectId: ProjectId): Promise<readonly ProjectGitLink[]>;
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
  /**
   * Rename a project. Scoped to a member's organization.
   *
   * Only the caller-owned columns (`name`, `slug`) are writable; the engine-owned
   * ones are frozen by the `projects` trigger from `0006`. The where clause
   * carries `organization_id`, so a write can never reach across a tenant.
   */
  updateProject(input: ProjectUpdateInput): Promise<Project | null>;
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

  /** The organization's deny-list rules, newest first. Membership-scoped. */
  listSecurityRules(
    userId: UserId,
    organizationId: OrganizationId,
  ): Promise<readonly SecurityRule[]>;
  /** Add a deny-list rule. The value grammar is enforced by the table and the API. */
  createSecurityRule(input: SecurityRuleCreateInput): Promise<SecurityRule>;
  /**
   * Remove a rule. Idempotent: removing an absent rule reports false rather than
   * throwing, because a retried click must not be an error.
   */
  deleteSecurityRule(
    userId: UserId,
    organizationId: OrganizationId,
    ruleId: string,
  ): Promise<boolean>;

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
  /** A backup by id, scoped by organization only. */
  getDataBackupForService(
    organizationId: OrganizationId,
    backupId: string,
  ): Promise<DataBackup | null>;
  /** Record a restore attempt. The worker performs it; status starts `pending`. */
  createDataRestore(input: DataRestoreCreateInput): Promise<DataRestore>;
  /** Record the outcome of a restore. Written only from the adapter's answer. */
  updateDataRestoreStatus(input: DataRestoreStatusInput): Promise<DataRestore | null>;
  listDataRestores(userId: UserId, resourceId: DataResourceId): Promise<readonly DataRestore[]>;

  /**
   * Link a repository to a project.
   *
   * The webhook secret is already encrypted by the caller; this method never
   * sees a plaintext secret, so a store cannot become the place one leaks.
   */
  createGitLink(input: GitLinkCreateInput): Promise<ProjectGitLink>;
  /**
   * A link by id, scoped by organization only.
   *
   * For the webhook receiver, which has no session: `organization_id` in the
   * where clause is the tenant boundary. On the write interface, so no
   * browser-facing read path can reach it.
   */
  getGitLinkForService(
    organizationId: OrganizationId,
    linkId: string,
  ): Promise<ProjectGitLink | null>;
  /** The secret ciphertext for a link, read only by the receiver. Service-scoped. */
  getGitLinkSecret(organizationId: OrganizationId, linkId: string): Promise<string | null>;
  /** Remove a link. Idempotent: removing an absent link reports false. */
  deleteGitLink(userId: UserId, organizationId: OrganizationId, linkId: string): Promise<boolean>;

  /**
   * A project by id, scoped by organization only.
   *
   * For the webhook receiver, which has no session. `organization_id` in the
   * where clause is the tenant boundary; a project id from another tenant is
   * null, never a project.
   */
  getProjectForService(
    organizationId: OrganizationId,
    projectId: ProjectId,
  ): Promise<Project | null>;

  /**
   * A deployment by idempotency key, scoped by organization only.
   *
   * The webhook receiver has no session, so `organization_id` in the where
   * clause is the tenant boundary. Used to make a redelivered webhook replay the
   * deployment it already created rather than building a second one.
   */
  findDeploymentByIdempotencyKeyForService(
    organizationId: OrganizationId,
    idempotencyKey: string,
  ): Promise<Deployment | null>;

  /**
   * The engine target for a preview key, or null when none exists yet.
   *
   * Service-scoped: a delivery arrives with no session, so `organization_id` in
   * the where clause is the tenant boundary.
   */
  getPreviewTargetForService(
    organizationId: OrganizationId,
    projectId: ProjectId,
    previewKey: string,
  ): Promise<PreviewTarget | null>;
  /** Record a preview target. Service-scoped, alongside the delivery. */
  createPreviewTarget(input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly previewKey: string;
    readonly branch: string | null;
    readonly pullRequest: number | null;
    readonly createdBy: UserId;
  }): Promise<PreviewTarget>;
  /** Record the engine application for a preview target. Service-scoped. */
  setPreviewTargetProvider(input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly previewKey: string;
    readonly provider: string;
    readonly providerResourceId: string;
  }): Promise<PreviewTarget | null>;

  /**
   * Record one usage row, written only by the worker from an engine's own answer.
   *
   * This is the write the billing roll-up has always read from and never had a
   * producer for. `quantity` is what an engine reported — a build's duration, a
   * backup's bytes — never a number a client asserted, and there is no procedure
   * that lets a client reach this method.
   */
  recordUsage(input: UsageRecordInput): Promise<UsageRecord>;

  /**
   * Usage rows for one metric since an instant, service-scoped.
   *
   * The request path sums these to enforce a hard cap before it enqueues work.
   * Service-scoped on purpose: enforcement must not depend on the actor's
   * membership read returning the same set a member-scoped read would, or a
   * caller could see a smaller total than the one that bills them.
   */
  listUsageForService(
    organizationId: OrganizationId,
    metric: string,
    since: string,
  ): Promise<readonly UsageRecord[]>;

  /** An organization's budgets, newest first by metric. Members may read. */
  listBudgets(userId: UserId, organizationId: OrganizationId): Promise<readonly Budget[]>;
  /**
   * A budget by metric, or null.
   *
   * Service-scoped on the request path only through the enforcement read below;
   * no browser-facing procedure calls this directly.
   */
  getBudgetForService(organizationId: OrganizationId, metric: string): Promise<Budget | null>;
  /** Set or replace one metric's cap. Only an admin or owner may. */
  saveBudget(input: BudgetSaveInput): Promise<Budget>;
  /** Remove a metric's cap. Owner-only; idempotent, reports whether a row went. */
  deleteBudget(userId: UserId, organizationId: OrganizationId, metric: string): Promise<boolean>;
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
  /** Defaults to `production` in the column, so an older caller is unchanged. */
  readonly kind?: "production" | "preview";
  readonly gitBranch?: string | null;
  readonly gitCommit?: string | null;
  readonly pullRequest?: number | null;
  readonly previewKey?: string | null;
}

/**
 * A repository linked to a project.
 *
 * The webhook secret is deliberately absent from this shape: the dashboard may
 * read which repository is linked, and the receiver reads the ciphertext
 * through its own service-scoped method. A `ProjectGitLink` is never the value
 * that authenticates a delivery.
 */
export interface ProjectGitLink {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly provider: "github" | "gitlab" | "bitbucket" | "generic";
  readonly repository: string;
  readonly productionBranch: string;
  readonly previewsEnabled: boolean;
  /** A short, non-secret fragment naming the secret in the dashboard. */
  readonly secretPrefix: string;
  /**
   * The member who linked the repository.
   *
   * Also the actor recorded on a deployment a webhook triggers: the provider is
   * not a Cloud Wai member, so the person who connected the repository is the
   * accountable party for what it deploys.
   */
  readonly createdBy: UserId;
  readonly createdAt: string;
}

export interface GitLinkCreateInput {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly provider: ProjectGitLink["provider"];
  readonly repository: string;
  readonly productionBranch: string;
  readonly previewsEnabled: boolean;
  /** AES-256-GCM ciphertext produced by the API. Never a plaintext secret. */
  readonly secretEncrypted: string;
  readonly secretPrefix: string;
  readonly createdBy: UserId;
}

/**
 * A preview target: one engine application behind one preview key.
 *
 * Not a Cloud Wai-created id: a target is derived from its `(project, key)` and
 * the worker resolves the engine application from `provider_resource_id`, so a
 * second push to the same branch redeploys rather than duplicates.
 */
export interface PreviewTarget {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly previewKey: string;
  readonly branch: string | null;
  readonly pullRequest: number | null;
  readonly provider: string | null;
  readonly providerResourceId: string | null;
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
  /**
   * The application handle. Set-or-leave, never clear: the value is engine-owned
   * and nothing in Cloud Wai unsets it, so an omitted value must not erase the
   * application a previous transition recorded.
   */
  readonly providerResourceId?: string | null;
  /**
   * The engine's *deployment* handle for this run, written when the engine
   * issues one. Set-or-leave: a later transition that reports `running` again
   * (a requeue) must not erase the handle, or the build log becomes unaddressable.
   */
  readonly deploymentResourceId?: string | null;
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

/** What a project rename may change. Engine-owned columns are not here. */
export interface ProjectUpdateInput {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly name?: string | undefined;
  readonly slug?: string | undefined;
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
  /**
   * The scoped "under attack" posture. `normal` inspects; `attack` challenges
   * browser traffic while the compiled ladder still allows verified bots and
   * internal requests before the challenge. The customer's own input.
   */
  readonly protectionMode: "normal" | "attack";
  /**
   * When attack mode lapses on its own. `null` means it does not expire. The
   * compiler treats a past timestamp as `normal`, so a forgotten attack mode
   * cannot become a permanent self-inflicted outage.
   */
  readonly protectionExpiresAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Whether the stored protection is currently in effect.
 *
 * A single place for the expiry rule, so the API, the worker and the view-model
 * cannot disagree about whether attack mode is on.
 */
export function protectionIsActive(
  policy: Pick<SecurityPolicy, "protectionMode" | "protectionExpiresAt">,
  now: Date = new Date(),
): boolean {
  if (policy.protectionMode !== "attack") return false;
  if (policy.protectionExpiresAt === null) return true;
  return new Date(policy.protectionExpiresAt).getTime() > now.getTime();
}

export interface SecurityPolicyInput {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly riskLevel: SecurityPolicy["riskLevel"];
  readonly action: SecurityPolicy["action"];
  readonly state: SecurityPolicy["state"];
  readonly protectionMode: SecurityPolicy["protectionMode"];
  readonly protectionExpiresAt: SecurityPolicy["protectionExpiresAt"];
  /** Monotonic per organization; the edge rejects a lower version. */
  readonly version: number;
  readonly createdBy: UserId;
}

/**
 * One entry of an organization's deny list.
 *
 * The value is a customer's own input, validated against a strict grammar at the
 * API boundary and again at compile time, so a value that would be directive
 * syntax never becomes one.
 */
export interface SecurityRule {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly kind: "ip" | "cidr" | "asn" | "user-agent";
  readonly value: string;
  readonly note: string | null;
  readonly createdBy: UserId;
  readonly createdAt: string;
}

export interface SecurityRuleCreateInput {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly kind: SecurityRule["kind"];
  readonly value: string;
  readonly note: string | null;
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

/**
 * A restore attempt.
 *
 * It names both the backup it read and the resource it wrote into, so the two
 * halves of a destructive operation are visible together in the history.
 */
export interface DataRestore {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly backupId: string;
  readonly dataResourceId: DataResourceId;
  readonly provider: string | null;
  readonly providerResourceId: string | null;
  readonly status: EngineStatus;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface DataRestoreCreateInput {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly backupId: string;
  readonly dataResourceId: DataResourceId;
  readonly provider: string | null;
  readonly status: EngineStatus;
}

/** A restore outcome. Only the adapter's answer may set `status`. */
export interface DataRestoreStatusInput {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly status: EngineStatus;
  readonly providerResourceId?: string | null;
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

/**
 * One organization-scoped usage measurement.
 *
 * Written only by the service role: `quantity` is what an engine reported, not
 * something a client asserts. Kept as a raw row so the dashboard can aggregate
 * it without the server pre-deciding a metric vocabulary.
 */
export interface UsageRecord {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly metric: string;
  readonly quantity: number;
  readonly recordedAt: string;
}

/** The input to `recordUsage`: the engine's own number, never a client's. */
export interface UsageRecordInput {
  readonly organizationId: OrganizationId;
  readonly metric: string;
  readonly quantity: number;
  readonly recordedAt?: string;
}

/**
 * The metrics this build's worker actually records.
 *
 * Both are counts of work the platform performed and observed itself: one
 * `deployments` unit per deployment the engine confirmed, one `backups` unit per
 * backup the engine confirmed. A metric an engine cannot report is deliberately
 * absent, so the vocabulary never promises a quantity nothing produces.
 */
export const USAGE_METRICS = ["deployments", "backups"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/**
 * A hard spend cap for one metric.
 *
 * `hard_cap` is the whole point: when true the API refuses to enqueue new work
 * once the period's usage reaches `limitQuantity`, so the cap is a control. When
 * false it is informational — the ratio is shown and nothing is blocked, which
 * is the honest state of a soft budget this build has no channel to alert on.
 */
export interface Budget {
  readonly organizationId: OrganizationId;
  readonly metric: string;
  readonly limitQuantity: number;
  readonly period: "monthly";
  readonly hardCap: boolean;
  readonly updatedBy: UserId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BudgetSaveInput {
  readonly organizationId: OrganizationId;
  readonly metric: string;
  readonly limitQuantity: number;
  readonly hardCap: boolean;
  readonly updatedBy: UserId;
}

/**
 * One unit of Cloud Wai work, as the control plane recorded it.
 *
 * This is the observability read model: the queue's own row, not an aggregate a
 * caller could misread. `attempts` and `lastError` are present so a job that
 * retried — or failed for a reason the engine gave — is visible as such rather
 * than collapsing into a single "failed" count. `maxAttempts` travels with
 * `attempts` so "2 of 3 attempts" can be shown without a second lookup.
 *
 * There is no `status` here derived from a metric: a state is only ever the
 * state the queue wrote.
 */
export interface OrchestrationJob {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly kind: string;
  readonly state: JobState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastError: string | null;
  readonly leaseExpiresAt: string | null;
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
  /**
   * Whether this is a production build or a preview build.
   *
   * This is the request's own attribute, not an engine observation, so it is
   * not frozen by the engine-column guard. It is what lets the dashboard show
   * "Preview" beside a build without inventing a second table.
   */
  readonly kind: "production" | "preview";
  readonly gitBranch: string | null;
  readonly gitCommit: string | null;
  readonly pullRequest: number | null;
  readonly previewKey: string | null;
  /**
   * The engine's own handle for this deployment.
   *
   * For a queued deploy this is the engine's *deployment* uuid, which is what
   * `GET /deployments/{uuid}` addresses — the build/deploy log lives there, not
   * on the application. It is written only from the adapter's answer and is
   * never returned to a browser.
   */
  readonly providerResourceId: string | null;
  /**
   * The engine's deployment uuid for this run, when the engine issued one. This
   * is the handle the build/deploy log is read through; null means only the
   * application's runtime log is available.
   */
  readonly deploymentResourceId: string | null;
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

/**
 * A member of an organization, as the settings page needs to show them.
 *
 * The email and display name live in `profiles`, which RLS exposes to a
 * co-member; both are nullable because a profile row may not have been written
 * yet for an invited user. No token, secret or session field is part of this:
 * membership is a fact about a person, not about their credentials.
 */
export interface OrganizationMember {
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: OrgRole;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly invitedBy: UserId | null;
  readonly createdAt: string;
}

export * from "./postgrest.js";
export * from "./supabase-store.js";
export * from "./sql-queue.js";
