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
import type { OrganizationId, ProjectId } from "@cloud-wai/contracts";
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
import { listAuditEvents, listDeployments, type DeploymentDeps } from "./deployments.js";
import type { RequestContext } from "../context.js";

type WithInput<T> = (input: unknown) => T;

function inputOf<T>(input: unknown): T {
  return input as T;
}

export function buildProcedures(store: DataStore): readonly Procedure[] {
  const orgDeps: OrgDeps = { store };
  const depDeps: DeploymentDeps = { store };

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
      name: "audit.list",
      handler: (ctx: RequestContext, _deps: unknown, input: unknown) =>
        listAuditEvents(
          ctx,
          depDeps,
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
  "audit.list": { organizationId: "OrganizationId" },
} as const;

export type { Organization, Project };
