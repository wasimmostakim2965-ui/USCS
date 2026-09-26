/**
 * Project environments (matrix P14 / audit C3).
 *
 * A project's environments are the vocabulary a deployment and an environment
 * variable are both expressed in: Vercel's own dashboard is organised around
 * Production and Preview, and the platform mirrors that rather than inventing a
 * parallel one. The rows are created with the project by a trigger (`0024`), so
 * this module reads them and never has to create them.
 *
 *   * **Reads are membership-scoped**, like every other project read: the store
 *     filters by `organization_members.user_id`, so a project the caller cannot
 *     see returns no environments rather than another tenant's.
 *   * **The two platform environments are not editable.** Production and Preview
 *     are the platform's model, not a customer's list; renaming or deleting one
 *     would break the deploy path that resolves an environment by kind. A
 *     customer's own environments are the `custom` kind, which this module does
 *     not create yet — so there is no write here at all. That is deliberate: a
 *     write with no caller would be dead code.
 */
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import type { DataStore, ProjectEnvironment } from "@cloud-wai/database";
import type { ProjectId } from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";

export interface EnvironmentDeps {
  readonly store: DataStore;
}

export interface ListEnvironmentsInput {
  readonly projectId: ProjectId;
}

/**
 * A project's environments, production first.
 *
 * A project the caller cannot see is `not_found`, not an empty list: the two
 * are different answers, and a page that showed "no environments" for a project
 * that exists elsewhere would be a lie.
 */
export async function listEnvironments(
  ctx: RequestContext,
  deps: EnvironmentDeps,
  input: ListEnvironmentsInput,
): Promise<readonly ProjectEnvironment[]> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "project:read");
  return deps.store.listEnvironments(ctx.principal.userId, project.id);
}
