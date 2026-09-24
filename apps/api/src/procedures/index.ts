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
} from "@cloud-wai/adapters";
import { ApiError } from "../errors.js";
import type { Procedure } from "../router.js";
import {
  createOrganization,
  createProject,
  getOrganization,
  getProject,
  listOrganizations,
  listProjects,
  type OrgDeps,
} from "./organizations.js";
import {
  requestDeployment,
  listAuditEvents,
  listDeployments,
  rollbackDeployment,
  type CreateDeploymentInput,
  type DeploymentDeps,
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
import { providerHealth, type HealthDeps } from "./health.js";
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
      name: "audit.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listAuditEvents(
          ctx,
          depDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
    },
    {
      name: "domains.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listDomains(
          ctx,
          settingsDeps,
          inputOf<{ organizationId: OrganizationId }>(input).organizationId,
        ),
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
  "projects.list": { organizationId: "OrganizationId" },
  "projects.get": { projectId: "ProjectId" },
  "projects.create": { organizationId: "OrganizationId", name: "string", slug: "string" },
  "deployments.list": { projectId: "ProjectId" },
  "deployments.create": {
    projectId: "ProjectId",
    idempotencyKey: "string?",
    gitRepository: "string?",
    gitBranch: "string?",
    commit: "string?",
    buildPack: "BuildPack?",
  },
  "deployments.rollback": {
    projectId: "ProjectId",
    commit: "string",
    idempotencyKey: "string?",
  },
  "audit.list": { organizationId: "OrganizationId" },
  "domains.list": { organizationId: "OrganizationId" },
  "domains.create": {
    organizationId: "OrganizationId",
    projectId: "ProjectId?",
    hostname: "string",
  },
  "domains.verify": { organizationId: "OrganizationId", domainId: "DomainId" },
  "domains.remove": { organizationId: "OrganizationId", domainId: "DomainId" },
  "data.list": { organizationId: "OrganizationId" },
  "apiKeys.list": { organizationId: "OrganizationId" },
  "apiKeys.create": { organizationId: "OrganizationId", name: "string", scopes: "string[]" },
  "apiKeys.revoke": { organizationId: "OrganizationId", keyId: "ApiKeyId" },
  "providers.health": { organizationId: "OrganizationId" },
} as const;

export type { Organization, Project };
