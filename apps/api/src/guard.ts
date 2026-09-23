/**
 * The scope guard.
 *
 * `requireCapability` is the only sanctioned way for a procedure to decide
 * whether a caller may act in an organization. It reads the membership list the
 * server built for this request and never consults the request body.
 */
import { can, roleIn, type Capability, type OrgRole } from "@cloud-wai/authorization";
import type { OrganizationId } from "@cloud-wai/contracts";
import { ApiError } from "./errors.js";
import type { RequestContext } from "./context.js";

export type MemberContext = RequestContext;

/** Non-throwing check. */
export function allowed(
  ctx: MemberContext,
  organizationId: OrganizationId,
  capability: Capability,
): boolean {
  return can(ctx.memberships, organizationId, ctx.principal, capability);
}

/** The caller's role, or null when they are not a member. */
export function roleFor(ctx: MemberContext, organizationId: OrganizationId): OrgRole | null {
  return roleIn(ctx.memberships, organizationId, ctx.principal);
}

/**
 * Throw unless the caller holds `capability` in `organizationId`.
 *
 * A non-member gets `not_found`, not `forbidden`: telling an authenticated
 * stranger that an organization exists is itself a disclosure.
 */
export function requireCapability(
  ctx: MemberContext,
  organizationId: OrganizationId,
  capability: Capability,
): void {
  if (roleFor(ctx, organizationId) === null) {
    throw new ApiError("not_found", "Organization not found.");
  }
  if (!allowed(ctx, organizationId, capability)) {
    throw new ApiError("forbidden", `Requires capability: ${capability}.`);
  }
}
