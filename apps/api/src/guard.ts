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

/**
 * Whether this request may act in `organizationId` with `capability`.
 *
 * Two independent gates, both server-side:
 *
 *   * the caller's membership must grant the capability, resolved from the
 *     membership list the server built (never from the body); and
 *   * when the request authenticated with an API key, the key is bound to
 *     exactly one organization and to the capabilities it was issued with. A
 *     key cannot reach a second organization its owner happens to belong to, and
 *     it cannot exceed its own scopes even where the owner's live role would.
 *
 * An API-key request is therefore the *narrower* of the two authorities, which
 * is the only safe direction: a key is a delegated credential, never a way to
 * widen what its owner could do.
 */
export function allowed(
  ctx: MemberContext,
  organizationId: OrganizationId,
  capability: Capability,
): boolean {
  if (!can(ctx.memberships, organizationId, ctx.principal, capability)) return false;
  const key = ctx.apiKey;
  if (key) {
    if (key.organizationId !== organizationId) return false;
    if (!key.scopes.includes(capability)) return false;
  }
  return true;
}

/** The caller's role, or null when they are not a member. */
export function roleFor(ctx: MemberContext, organizationId: OrganizationId): OrgRole | null {
  return roleIn(ctx.memberships, organizationId, ctx.principal);
}

/**
 * Throw unless the caller holds `capability` in `organizationId`.
 *
 * A non-member gets `not_found`, not `forbidden`: telling an authenticated
 * stranger that an organization exists is itself a disclosure. An API key
 * aimed at an organization other than its own is treated the same way, for the
 * same reason — the key may not learn that the other tenant exists.
 */
export function requireCapability(
  ctx: MemberContext,
  organizationId: OrganizationId,
  capability: Capability,
): void {
  const key = ctx.apiKey;
  if (key && key.organizationId !== organizationId) {
    throw new ApiError("not_found", "Organization not found.");
  }
  if (roleFor(ctx, organizationId) === null) {
    throw new ApiError("not_found", "Organization not found.");
  }
  if (!allowed(ctx, organizationId, capability)) {
    throw new ApiError("forbidden", `Requires capability: ${capability}.`);
  }
}
