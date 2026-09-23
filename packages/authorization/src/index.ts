/**
 * @cloud-wai/authorization — organization/project/resource permission matrix.
 *
 * The single rule this package enforces: organization scope is resolved from
 * the authenticated principal's membership, never from client input.
 */
import type { OrganizationId, Principal, UserId } from "@cloud-wai/contracts";

export const ORG_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Resource-scoped capabilities, named `resource:action`. */
export const CAPABILITIES = [
  "org:read",
  "org:update",
  "org:delete",
  "member:read",
  "member:invite",
  "member:remove",
  "project:read",
  "project:create",
  "project:update",
  "project:delete",
  "deployment:read",
  "deployment:create",
  "deployment:cancel",
  "deployment:rollback",
  "data:read",
  "data:create",
  "data:backup",
  "data:restore",
  "data:destroy",
  "domain:read",
  "domain:create",
  "domain:delete",
  "security:read",
  "security:update",
  "security:quarantine",
  "apikey:read",
  "apikey:create",
  "apikey:revoke",
  "billing:read",
  "billing:manage",
  "audit:read",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Capability grants per role. Members and viewers are deliberately narrow. */
export const ROLE_CAPABILITIES: Readonly<Record<OrgRole, readonly Capability[]>> = {
  owner: CAPABILITIES,
  admin: CAPABILITIES.filter((c) => c !== "org:delete" && c !== "billing:manage"),
  member: [
    "org:read",
    "member:read",
    "project:read",
    "project:create",
    "project:update",
    "deployment:read",
    "deployment:create",
    "deployment:cancel",
    "data:read",
    "domain:read",
    "security:read",
    "apikey:read",
    "billing:read",
    "audit:read",
  ],
  viewer: [
    "org:read",
    "member:read",
    "project:read",
    "deployment:read",
    "data:read",
    "domain:read",
    "security:read",
    "billing:read",
    "audit:read",
  ],
};

export interface Membership {
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: OrgRole;
}

export function hasCapability(role: OrgRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Resolve a principal's role in an organization from server-side memberships.
 *
 * Returns `null` when there is no membership, so a caller cannot distinguish a
 * non-member from a missing organization — both must look like "not found".
 */
export function roleIn(
  memberships: readonly Membership[],
  organizationId: OrganizationId,
  principal: Principal,
): OrgRole | null {
  const match = memberships.find(
    (m) => m.organizationId === organizationId && m.userId === principal.userId,
  );
  return match ? match.role : null;
}

export function can(
  memberships: readonly Membership[],
  organizationId: OrganizationId,
  principal: Principal,
  capability: Capability,
): boolean {
  const role = roleIn(memberships, organizationId, principal);
  return role !== null && hasCapability(role, capability);
}
