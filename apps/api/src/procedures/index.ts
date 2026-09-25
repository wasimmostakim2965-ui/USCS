/**
 * The procedure table.
 *
 * This is the complete set of operations the API exposes, and the reference
 * implementation the HTTP adapter mounts. Each entry declares its own scope
 * requirement through the guard, so adding a procedure cannot accidentally skip
 * an authorization check: there is no way to register one without a handler,
 * and every handler calls `requireCapability` or reads only the caller's own
 * memberships.
 */
import type { DataStore, Organization, Project } from "@cloud-wai/database";
import type { ApiKeyId, OrganizationId, ProjectId } from "@cloud-wai/contracts";
import {
  databaseNotConfigured,
  domainVerifierNotConfigured,
  hostingNotConfigured,
  securityNotConfigured,
  storageNotConfigured,
  type Engines,
  type JobQueue,
} from "@cloud-wai/adapters";
import { ApiError } from "../errors.js";
import type { Procedure } from "../router.js";
import {
  createOrganization,
  createProject,
  getOrganization,
  getProject,
  listOrganizationMembers,
  listOrganizations,
  listProjects,
  updateProject,
  type OrgDeps,
} from "./organizations.js";
import {
  cancelDeployment,
  deploymentsLogs,
  promoteDeployment,
  requestDeployment,
  listAuditEvents,
  listDeployments,
  rollbackDeployment,
  type CancelDeploymentInput,
  type CreateDeploymentInput,
  type DeploymentDeps,
  type DeploymentLogsInput,
  type PromoteDeploymentRequest,
  type RollbackDeploymentInput,
} from "./deployments.js";
import {
  createApiKey,
  listApiKeys,
  listDataResources,
  listDomains,
  revokeApiKey,
  type SettingsDeps,
} from "./settings.js";
import {
  addDomain,
  removeDomain,
  verifyDomain,
  type AddDomainInput,
  type DomainDeps,
  type RemoveDomainInput,
  type VerifyDomainInput,
} from "./domains.js";
import {
  backupDataResource,
  listDataBackups,
  listDataRestores,
  provisionDataResource,
  restoreDataResource,
  rotateDataCredentials,
  type BackupDataInput,
  type DataDeps,
  type ListBackupsInput,
  type ListRestoresInput,
  type ProvisionDataInput,
  type RestoreDataInput,
  type RotateCredentialsInput,
} from "./data.js";
import {
  addSecurityRule,
  distributeSecurityPolicy,
  listSecurityRules,
  readSecurityPolicy,
  readVerifiedBots,
  removeSecurityRule,
  saveSecurityPolicy,
  type AddSecurityRuleInput,
  type DistributePolicyInput,
  type RemoveSecurityRuleInput,
  type SavePolicyInput,
  type SecurityDeps,
} from "./security.js";
import { providerHealth, type HealthDeps } from "./health.js";
import {
  connectGitLink,
  disconnectGitLink,
  listGitLinks,
  type ConnectGitLinkInput,
  type DisconnectGitLinkInput,
  type GitLinkDeps,
} from "./git-links.js";
import type { SecretCipher } from "@cloud-wai/auth";
import { readUsage, readBudgets, saveBudget, removeBudget, type BillingDeps } from "./billing.js";
import { readObservability, type ObservabilityDeps } from "./observability.js";
import type { RequestContext } from "../context.js";

type WithInput<T> = (input: unknown) => T;

function inputOf<T>(input: unknown): T {
  return input as T;
}

/**
 * Engines for a deployment with none wired.
 *
 * These are the real not-configured adapters, not empty objects: an empty engine
 * set would be reported as *configured* by a  brand check and the
 * dashboard would show four healthy providers that cannot do anything.
 */
const missingEngines: Engines = {
  hosting: hostingNotConfigured("coolify"),
  database: databaseNotConfigured("postgres"),
  storage: storageNotConfigured("minio"),
  securityEdge: securityNotConfigured("envoy"),
  domainVerifier: domainVerifierNotConfigured("dns"),
};

export interface ProcedureExtras {
  /** Live engines, for the provider-health procedure. */
  readonly engines?: HealthDeps["engines"];
  /** Injected id source, so a new key gets a Cloud Wai UUID. */
  readonly newId?: () => string;
  /** Injected challenge source, so a domain token is deterministic in tests. */
  readonly newToken?: (() => string) | undefined;
  readonly now?: () => Date;
  /**
   * When wired, deploy and rollback commands become durable jobs executed by the
   * worker instead of running on the request path. Omitted in tests that pin the
   * synchronous behaviour.
   */
  readonly queue?: JobQueue;
  /**
   * The cipher for webhook secrets. Null (the default) means git links cannot be
   * stored: `git.connect` answers `engine_unavailable` rather than writing a
   * plaintext secret. Wired from `CLOUD_WAI_SECRET_ENCRYPTION_KEY` at bootstrap.
   */
  readonly secretCipher?: SecretCipher | null;
  /** Injected so a webhook secret is deterministic in tests. */
  readonly newSecret?: (() => string) | undefined;
}

export function buildProcedures(
  store: DataStore,
  extras: ProcedureExtras = {},
): readonly Procedure[] {
  const orgDeps: OrgDeps = { store };
  const newId =
    extras.newId ??
    (() => {
      throw new ApiError("engine_unavailable", "This deployment cannot issue Cloud Wai ids yet.");
    });
  const depDeps: DeploymentDeps = {
    store,
    engines: extras.engines ?? missingEngines,
    newId,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.queue ? { queue: extras.queue } : {}),
  };
  const settingsDeps: SettingsDeps = {
    store,
    newId,
    ...(extras.now ? { now: extras.now } : {}),
  };
  const domainDeps: DomainDeps = {
    store,
    newId,
    engines: extras.engines ?? missingEngines,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.newToken ? { newToken: extras.newToken } : {}),
  };
  const healthDeps: HealthDeps = {
    engines: extras.engines ?? missingEngines,
  };
  const dataDeps: DataDeps = {
    store,
    newId,
    engines: extras.engines ?? missingEngines,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.queue ? { queue: extras.queue } : {}),
  };
  const securityDeps: SecurityDeps = {
    store,
    newId,
    engines: extras.engines ?? missingEngines,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.queue ? { queue: extras.queue } : {}),
  };
  const billingDeps: BillingDeps = { store };
  const observabilityDeps: ObservabilityDeps = { store };
  const gitLinkDeps: GitLinkDeps = {
    store,
    newId,
    cipher: extras.secretCipher ?? null,
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.newSecret ? { newSecret: extras.newSecret } : {}),
  };

  return [
    {
      name: "organizations.list",
      handler: (ctx: RequestContext) => listOrganizations(ctx, orgDeps),
    },
    {
      name: "organizations.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        createOrganization(ctx, orgDeps, inputOf<{ name: string; slug: string }>(input)),
    },
    {
      name: "organizations.get",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        getOrganization(
          ctx,
          orgDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "organizations.members.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listOrganizationMembers(
          ctx,
          orgDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "projects.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listProjects(
          ctx,
          orgDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "projects.get",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        getProject(ctx, orgDeps, inputOf<{ projectId: ProjectId }>(input).projectId),
    },
    {
      name: "projects.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        createProject(
          ctx,
          orgDeps,
          inputOf<{ organizationId: OrganizationId; name: string; slug: string }>(input),
        ),
    },
    {
      name: "projects.update",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        updateProject(
          ctx,
          orgDeps,
          inputOf<{ projectId: ProjectId; name?: string; slug?: string }>(input),
        ),
    },
    {
      name: "deployments.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listDeployments(ctx, depDeps, inputOf<{ projectId: ProjectId }>(input).projectId),
    },
    {
      name: "deployments.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        requestDeployment(ctx, depDeps, inputOf<CreateDeploymentInput>(input)),
    },
    {
      name: "deployments.rollback",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        rollbackDeployment(ctx, depDeps, inputOf<RollbackDeploymentInput>(input)),
    },
    {
      name: "deployments.promote",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        promoteDeployment(ctx, depDeps, inputOf<PromoteDeploymentRequest>(input)),
    },
    {
      name: "deployments.logs",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        deploymentsLogs(ctx, depDeps, inputOf<DeploymentLogsInput>(input)),
    },
    {
      name: "deployments.cancel",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        cancelDeployment(ctx, depDeps, inputOf<CancelDeploymentInput>(input)),
    },
    {
      name: "audit.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listAuditEvents(
          ctx,
          depDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "git.links.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listGitLinks(ctx, gitLinkDeps, inputOf<{ projectId: ProjectId }>(input)),
    },
    {
      name: "git.connect",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        connectGitLink(ctx, gitLinkDeps, inputOf<ConnectGitLinkInput>(input)),
    },
    {
      name: "git.disconnect",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        disconnectGitLink(ctx, gitLinkDeps, inputOf<DisconnectGitLinkInput>(input)),
    },
    {
      name: "domains.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) => {
        const parsed = inputOf<{ organizationId: OrganizationId; projectId?: ProjectId }>(input);
        return listDomains(ctx, settingsDeps, parsed.organizationId, parsed.projectId);
      },
    },
    {
      name: "domains.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        addDomain(ctx, domainDeps, inputOf<AddDomainInput>(input)),
    },
    {
      name: "domains.verify",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        verifyDomain(ctx, domainDeps, inputOf<VerifyDomainInput>(input)),
    },
    {
      name: "domains.remove",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeDomain(ctx, domainDeps, inputOf<RemoveDomainInput>(input)),
    },
    {
      name: "data.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listDataResources(
          ctx,
          settingsDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "data.provision",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        provisionDataResource(ctx, dataDeps, inputOf<ProvisionDataInput>(input)),
    },
    {
      name: "data.backup",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        backupDataResource(ctx, dataDeps, inputOf<BackupDataInput>(input)),
    },
    {
      name: "data.backups.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listDataBackups(ctx, dataDeps, inputOf<ListBackupsInput>(input)),
    },
    {
      name: "data.restore",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        restoreDataResource(ctx, dataDeps, inputOf<RestoreDataInput>(input)),
    },
    {
      name: "data.restores.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listDataRestores(ctx, dataDeps, inputOf<ListRestoresInput>(input)),
    },
    {
      name: "data.rotateCredentials",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        rotateDataCredentials(ctx, dataDeps, inputOf<RotateCredentialsInput>(input)),
    },
    {
      name: "security.policy.get",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readSecurityPolicy(
          ctx,
          securityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "security.policy.save",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        saveSecurityPolicy(ctx, securityDeps, inputOf<SavePolicyInput>(input)),
    },
    {
      name: "security.policy.distribute",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        distributeSecurityPolicy(ctx, securityDeps, inputOf<DistributePolicyInput>(input)),
    },
    {
      name: "security.rules.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listSecurityRules(
          ctx,
          securityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "security.rules.add",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        addSecurityRule(ctx, securityDeps, inputOf<AddSecurityRuleInput>(input)),
    },
    {
      name: "security.rules.remove",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeSecurityRule(ctx, securityDeps, inputOf<RemoveSecurityRuleInput>(input)),
    },
    {
      name: "security.bots.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readVerifiedBots(
          ctx,
          securityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "apiKeys.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listApiKeys(
          ctx,
          settingsDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "apiKeys.create",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        createApiKey(
          ctx,
          settingsDeps,
          inputOf<{ organizationId: OrganizationId; name: string; scopes: readonly string[] }>(
            input,
          ),
        ),
    },
    {
      name: "apiKeys.revoke",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        revokeApiKey(
          ctx,
          settingsDeps,
          inputOf<{ organizationId: OrganizationId; keyId: ApiKeyId }>(input),
        ),
    },
    {
      name: "providers.health",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        providerHealth(
          ctx,
          healthDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "billing.usage",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readUsage(
          ctx,
          billingDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "billing.budgets.list",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readBudgets(
          ctx,
          billingDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "billing.budgets.save",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        saveBudget(
          ctx,
          billingDeps,
          inputOf<{
            organizationId: OrganizationId;
            metric: string;
            limitQuantity: number;
            hardCap: boolean;
          }>(input),
        ),
    },
    {
      name: "billing.budgets.remove",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        removeBudget(
          ctx,
          billingDeps,
          inputOf<{ organizationId: OrganizationId; metric: string }>(input),
        ),
    },
    {
      name: "observability.jobs",
      handler: async (ctx: RequestContext, _deps: unknown, input: unknown) =>
        readObservability(
          ctx,
          observabilityDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
  ];
}

/** Names of every exposed procedure, sorted. Used by the boundary test. */
export function procedureNames(store: DataStore): readonly string[] {
  return buildProcedures(store)
    .map((p) => p.name)
    .sort();
}

/** Re-exported for callers building a router by hand. */
export const ROUTE_SHAPES = {
  "organizations.list": {},
  "organizations.create": { name: "string", slug: "string" },
  "organizations.get": { organizationId: "OrganizationId" },
  "organizations.members.list": { organizationId: "OrganizationId" },
  "projects.list": { organizationId: "OrganizationId" },
  "projects.get": { projectId: "ProjectId" },
  "projects.create": { organizationId: "OrganizationId", name: "string", slug: "string" },
  "projects.update": { projectId: "ProjectId", name: "string?", slug: "string?" },
  "deployments.list": { projectId: "ProjectId" },
  "deployments.create": {
    projectId: "ProjectId",
    idempotencyKey: "string?",
    gitRepository: "string?",
    gitBranch: "string?",
    commit: "string?",
    buildPack: "BuildPack?",
    kind: "string?",
    pullRequest: "number?",
  },
  "deployments.rollback": {
    projectId: "ProjectId",
    commit: "string",
    idempotencyKey: "string?",
  },
  "deployments.logs": { projectId: "ProjectId", deploymentId: "string" },
  "deployments.promote": { projectId: "ProjectId", deploymentId: "string" },
  "deployments.cancel": { projectId: "ProjectId", deploymentId: "string" },
  "git.links.list": { projectId: "ProjectId" },
  "git.connect": {
    projectId: "ProjectId",
    provider: "string",
    repository: "string",
    productionBranch: "string?",
    previewsEnabled: "boolean?",
  },
  "git.disconnect": { projectId: "ProjectId", linkId: "string" },
  "audit.list": { organizationId: "OrganizationId" },
  "domains.list": { organizationId: "OrganizationId", projectId: "ProjectId?" },
  "domains.create": {
    organizationId: "OrganizationId",
    projectId: "ProjectId?",
    hostname: "string",
  },
  "domains.verify": { organizationId: "OrganizationId", domainId: "DomainId" },
  "domains.remove": { organizationId: "OrganizationId", domainId: "DomainId" },
  "data.list": { organizationId: "OrganizationId" },
  "data.provision": {
    organizationId: "OrganizationId",
    name: "string",
    kind: "postgres|object_storage",
    projectId: "ProjectId?",
  },
  "data.backup": { organizationId: "OrganizationId", resourceId: "DataResourceId" },
  "data.backups.list": { organizationId: "OrganizationId", resourceId: "DataResourceId" },
  "data.restore": {
    organizationId: "OrganizationId",
    resourceId: "DataResourceId",
    backupId: "string",
    confirmName: "string",
  },
  "data.restores.list": { organizationId: "OrganizationId", resourceId: "DataResourceId" },
  "data.rotateCredentials": {
    organizationId: "OrganizationId",
    resourceId: "DataResourceId",
    confirmName: "string",
  },
  "security.policy.get": { organizationId: "OrganizationId" },
  "security.policy.save": {
    organizationId: "OrganizationId",
    name: "string",
    riskLevel: "RiskLevel",
    action: "EnforcementAction",
    protectionMode: "normal|attack?",
    protectionExpiresAt: "string?",
  },
  "security.policy.distribute": { organizationId: "OrganizationId" },
  "security.rules.list": { organizationId: "OrganizationId" },
  "security.rules.add": {
    organizationId: "OrganizationId",
    kind: "ip|cidr|asn|user-agent",
    value: "string",
    note: "string?",
  },
  "security.rules.remove": { organizationId: "OrganizationId", ruleId: "string" },
  "security.bots.list": { organizationId: "OrganizationId" },
  "apiKeys.list": { organizationId: "OrganizationId" },
  "apiKeys.create": { organizationId: "OrganizationId", name: "string", scopes: "string[]" },
  "apiKeys.revoke": { organizationId: "OrganizationId", keyId: "ApiKeyId" },
  "providers.health": { organizationId: "OrganizationId" },
  "billing.usage": { organizationId: "OrganizationId" },
  "billing.budgets.list": { organizationId: "OrganizationId" },
  "billing.budgets.save": {
    organizationId: "OrganizationId",
    metric: "deployments|backups",
    limitQuantity: "number",
    hardCap: "boolean",
  },
  "billing.budgets.remove": { organizationId: "OrganizationId", metric: "string" },
  "observability.jobs": { organizationId: "OrganizationId" },
} as const;

export type { Organization, Project };
