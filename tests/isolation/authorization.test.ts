import { describe, expect, it } from "vitest";
import type { Principal } from "@cloud-wai/contracts";
import {
  ROLE_CAPABILITIES,
  can,
  hasCapability,
  roleIn,
  type Membership,
  type OrgRole,
} from "@cloud-wai/authorization";

const alice: Principal = { userId: "u-alice", email: "alice@example.com", displayName: "Alice" };
const bob: Principal = { userId: "u-bob", email: "bob@example.com", displayName: "Bob" };

const ORG_A = "org-a";
const ORG_B = "org-b";

const memberships: Membership[] = [
  { organizationId: ORG_A, userId: alice.userId, role: "owner" },
  { organizationId: ORG_B, userId: alice.userId, role: "viewer" },
  { organizationId: ORG_B, userId: bob.userId, role: "owner" },
];

describe("organization role resolution", () => {
  it("resolves a role only from server-side memberships", () => {
    expect(roleIn(memberships, ORG_A, alice)).toBe("owner");
    expect(roleIn(memberships, ORG_B, alice)).toBe("viewer");
  });

  it("returns null for a non-member instead of inventing a role", () => {
    // Critical isolation property: a user with no membership in org A must not
    // resolve to any role, even if they hold a role in another organization.
    expect(roleIn(memberships, ORG_A, bob)).toBeNull();
    expect(roleIn(memberships, "org-does-not-exist", alice)).toBeNull();
  });

  it("does not leak a role across organizations", () => {
    // Alice is owner of A but only viewer of B: the owner grant must not apply.
    expect(can(memberships, ORG_A, alice, "project:delete")).toBe(true);
    expect(can(memberships, ORG_B, alice, "project:delete")).toBe(false);
  });
});

describe("capability matrix", () => {
  it("denies every capability to a non-member", () => {
    for (const role of Object.keys(ROLE_CAPABILITIES) as OrgRole[]) {
      expect(hasCapability(role, "org:read")).toBe(true);
    }
    // Bob is a member of B only.
    expect(can(memberships, ORG_A, bob, "org:read")).toBe(false);
  });

  it("keeps destructive and billing capabilities away from admins", () => {
    expect(hasCapability("admin", "org:delete")).toBe(false);
    expect(hasCapability("admin", "billing:manage")).toBe(false);
    expect(hasCapability("owner", "org:delete")).toBe(true);
    expect(hasCapability("owner", "billing:manage")).toBe(true);
  });

  it("makes viewers strictly read-only", () => {
    const mutating = [
      "org:update",
      "project:create",
      "deployment:create",
      "data:backup",
      "security:update",
      "apikey:create",
      "member:invite",
    ] as const;
    for (const capability of mutating) {
      expect(hasCapability("viewer", capability)).toBe(false);
    }
    expect(hasCapability("viewer", "project:read")).toBe(true);
  });
});
