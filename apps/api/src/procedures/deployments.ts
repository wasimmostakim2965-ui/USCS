/**
 * Deployment and audit procedures.
 *
 * A client can request a deployment and read its state; it can never set the
 * state. The status column is the worker's to write, through a service-role
 * connection the browser does not have. That is what stops a client from
 * marking its own deployment `succeeded`.
 */
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import type { AuditEvent, DataStore, Deployment } from "@cloud-wai/database";
import type { OrganizationId, ProjectId } from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";

export interface DeploymentDeps {
  readonly store: DataStore;
}

export async function listDeployments(
  ctx: RequestContext,
  deps: DeploymentDeps,
  projectId: ProjectId,
): Promise<readonly Deployment[]> {
  const project = await deps.store.getProject(ctx.principal.userId, projectId);
  if (!project) {
    throw new ApiError("not_found", "Project not found.");
  }
  requireCapability(ctx, project.organizationId, "deployment:read");
  return deps.store.listDeployments(ctx.principal.userId, projectId);
}

export async function listAuditEvents(
  ctx: RequestContext,
  deps: DeploymentDeps,
  organizationId: OrganizationId,
): Promise<readonly AuditEvent[]> {
  requireCapability(ctx, organizationId, "audit:read");
  return deps.store.listAuditEvents(ctx.principal.userId, organizationId);
}
