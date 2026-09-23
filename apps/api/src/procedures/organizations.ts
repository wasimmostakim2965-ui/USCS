/**
 * Organization and project procedures.
 *
 * Every function follows the same order:
 *   1. the context already carries a verified principal;
 *   2. scope is resolved from server-side memberships via `@cloud-wai/authorization`;
 *   3. the store call passes the principal id, which is also what the database
 *      policy checks — the guard is not the only line of defence.
 *
 * A missing membership and a missing row both surface as `not_found`.
 */
import { allowed, requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import type { DataStore, Organization, Project } from "@cloud-wai/database";
import type { OrganizationId, ProjectId } from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";

export interface OrgDeps {
  readonly store: DataStore;
}

export async function listOrganizations(
  ctx: RequestContext,
  deps: OrgDeps,
): Promise<readonly Organization[]> {
  // Memberships are already scoped server-side; the store re-filters by user.
  return deps.store.listOrganizations(ctx.principal.userId);
}

export async function createOrganization(
  ctx: RequestContext,
  deps: OrgDeps,
  input: { name: string; slug: string },
): Promise<Organization> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    throw new ApiError("invalid_input", "Organization name must be 1-120 characters.");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug)) {
    throw new ApiError(
      "invalid_input",
      "Organization slug must be lowercase alphanumeric with hyphens.",
    );
  }

  const org = await deps.store.createOrganization({
    name,
    slug: input.slug,
    createdBy: ctx.principal.userId,
  });

  await deps.store.recordAuditEvent({
    organizationId: org.id,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "organization.created",
    targetType: "organization",
    targetId: org.id,
    metadata: { slug: org.slug },
  });

  return org;
}

export async function getOrganization(
  ctx: RequestContext,
  deps: OrgDeps,
  organizationId: OrganizationId,
): Promise<Organization> {
  requireCapability(ctx, organizationId, "org:read");
  const orgs = await deps.store.listOrganizations(ctx.principal.userId);
  const found = orgs.find((o) => o.id === organizationId);
  if (!found) {
    throw new ApiError("not_found", "Organization not found.");
  }
  return found;
}

export async function listProjects(
  ctx: RequestContext,
  deps: OrgDeps,
  organizationId: OrganizationId,
): Promise<readonly Project[]> {
  requireCapability(ctx, organizationId, "project:read");
  return deps.store.listProjects(ctx.principal.userId, organizationId);
}

export async function getProject(
  ctx: RequestContext,
  deps: OrgDeps,
  projectId: ProjectId,
): Promise<Project> {
  // A project id alone is not a scope we trust; the store joins through
  // membership and returns null for both "absent" and "other tenant".
  const project = await deps.store.getProject(ctx.principal.userId, projectId);
  if (!project) {
    throw new ApiError("not_found", "Project not found.");
  }
  requireCapability(ctx, project.organizationId, "project:read");
  return project;
}

export async function createProject(
  ctx: RequestContext,
  deps: OrgDeps,
  input: { organizationId: OrganizationId; name: string; slug: string },
): Promise<Project> {
  requireCapability(ctx, input.organizationId, "project:create");

  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    throw new ApiError("invalid_input", "Project name must be 1-120 characters.");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug)) {
    throw new ApiError(
      "invalid_input",
      "Project slug must be lowercase alphanumeric with hyphens.",
    );
  }

  const project = await deps.store.createProject({
    organizationId: input.organizationId,
    name,
    slug: input.slug,
    createdBy: ctx.principal.userId,
  });

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "project.created",
    targetType: "project",
    targetId: project.id,
    metadata: { slug: project.slug },
  });

  return project;
}

/** Non-throwing variant, for callers that want a boolean and no error. */
export function mayReadProject(ctx: RequestContext, organizationId: OrganizationId): boolean {
  return allowed(ctx, organizationId, "project:read");
}
