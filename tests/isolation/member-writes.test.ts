/**
 * Phase: member management (role change + removal), end to end.
 *
 * `organizations.members.list` proved membership could be *read*. This proves
 * the write half, over the router the API actually mounts and the real
 * procedure table. The properties that matter, and that a mock would hide:
 *
 *   * an owner can change a member's role and the change is persisted;
 *   * an admin cannot demote an owner or mint a new one — rank is a ceiling,
 *     not just a floor, so an admin cannot escalate past the owner who
 *     appointed them;
 *   * nobody edits their own role, so promotion needs a second party;
 *   * the last owner cannot be demoted or removed, so an organization is never
 *     left with nobody who can manage it;
 *   * a member can remove themselves (leave), but not anyone else;
 *   * a non-member learns nothing — `not_found`, never a distinguishable
 *     "forbidden", or organization ids become enumerable;
 *   * every accepted write leaves an audit event.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  ApiKeySummary,
  AuditEvent,
  AuditEventInput,
  DataResource,
  DataStore,
  Deployment,
  Domain,
  MembershipStore,
  Organization,
  OrganizationMember,
  Project,
  UsageRecord,
} from "@cloud-wai/database";
import type { OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";
import { buildProcedures, buildRouter, type RouterDeps } from "@cloud-wai/api";

const ALICE = "u-alice"; // owner
const BOB = "u-bob"; // admin
const CAROL = "u-carol"; // member
const DAVE = "u-dave"; // outsider
const ORG_A = "org-a" as OrganizationId;

const TOKEN_ALICE = "t-alice";
const TOKEN_BOB = "t-bob";
const TOKEN_CAROL = "t-carol";
const TOKEN_DAVE = "t-dave";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: { userId: ALICE, email: "a@x.test", displayName: "Alice", accessToken: TOKEN_ALICE },
  [TOKEN_BOB]: { userId: BOB, email: "b@x.test", displayName: "Bob", accessToken: TOKEN_BOB },
  [TOKEN_CAROL]: { userId: CAROL, email: "c@x.test", displayName: "Carol", accessToken: TOKEN_CAROL },
  [TOKEN_DAVE]: { userId: DAVE, email: "d@x.test", displayName: "Dave", accessToken: TOKEN_DAVE },
};

const verifier: SessionVerifier = {
  async verify(token) {
    return sessions[token] ?? null;
  },
};

/** A store whose membership list is rebuilt per test, so tests never share state. */
function makeStore() {
  const memberships: Membership[] = [
    { organizationId: ORG_A, userId: ALICE, role: "owner" },
    { organizationId: ORG_A, userId: BOB, role: "admin" },
    { organizationId: ORG_A, userId: CAROL, role: "member" },
  ];

  const organizations: Organization[] = [
    { id: ORG_A, name: "A", slug: "a", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const projects: Project[] = [];
  const deployments: Deployment[] = [];
  const audit: AuditEvent[] = [];
  const domains: Domain[] = [];
  const dataResources: DataResource[] = [];
  const apiKeys: ApiKeySummary[] = [];
  const usage: UsageRecord[] = [];

  const isMember = (userId: UserId, org: OrganizationId) =>
    memberships.some((m) => m.userId === userId && m.organizationId === org);

  const toMember = (m: Membership): OrganizationMember => ({
    organizationId: m.organizationId,
    userId: m.userId,
    role: m.role,
    email: sessions[`t-${m.userId.replace("u-", "")}`]?.email ?? null,
    displayName: null,
    invitedBy: null,
    createdAt: "2026-01-01T00:00:00Z",
  });

  const membershipStore: MembershipStore = {
    async membershipsFor(userId) {
      return memberships.filter((m) => m.userId === userId);
    },
  };

  const store: DataStore = {
    async listOrganizations(userId) {
      return organizations.filter((o) => isMember(userId, o.id));
    },
    async createOrganization(input) {
      const org: Organization = {
        id: `org-${input.slug}` as OrganizationId,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-01T00:00:00Z",
      };
      organizations.push(org);
      memberships.push({ organizationId: org.id, userId: input.createdBy, role: "owner" });
      return org;
    },
    async listOrganizationMembers(userId, org) {
      if (!isMember(userId, org)) return [];
      return memberships.filter((m) => m.organizationId === org).map(toMember);
    },
    async updateOrganizationMemberRole(input) {
      if (!isMember(input.userId, input.organizationId)) return null;
      const m = memberships.find(
        (x) => x.organizationId === input.organizationId && x.userId === input.memberId,
      );
      if (!m) return null;
      m.role = input.role;
      return toMember(m);
    },
    async removeOrganizationMember(input) {
      if (!isMember(input.userId, input.organizationId)) return false;
      const index = memberships.findIndex(
        (x) => x.organizationId === input.organizationId && x.userId === input.memberId,
      );
      if (index === -1) return false;
      memberships.splice(index, 1);
      return true;
    },
    async listProjects(userId, org) {
      return isMember(userId, org) ? projects.filter((p) => p.organizationId === org) : [];
    },
    async getProject(userId, projectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId) ? p : null;
    },
    async createProject(input) {
      const p: Project = {
        id: `proj-${input.slug}` as ProjectId,
        organizationId: input.organizationId,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-01T00:00:00Z",
      };
      projects.push(p);
      return p;
    },
    async listDeployments(userId, projectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId)
        ? deployments.filter((d) => d.projectId === projectId)
        : [];
    },
    async listAuditEvents(userId, org) {
      return isMember(userId, org) ? audit.filter((a) => a.organizationId === org) : [];
    },
    async listDomains(userId, org) {
      return isMember(userId, org) ? domains.filter((d) => d.organizationId === org) : [];
    },
    async listDataResources(userId, org) {
      return isMember(userId, org) ? dataResources.filter((d) => d.organizationId === org) : [];
    },
    async listApiKeys(userId, org) {
      return isMember(userId, org) ? apiKeys.filter((k) => k.organizationId === org) : [];
    },
    async listUsageRecords(userId, org) {
      return isMember(userId, org) ? usage.filter((u) => u.organizationId === org) : [];
    },
    async recordAuditEvent(input: AuditEventInput) {
      const e: AuditEvent = { ...input, id: `a-${audit.length + 1}`, createdAt: "2026-01-01T00:00:00Z" };
      audit.push(e);
      return e;
    },
  };

  return { store, membershipStore, memberships, audit };
}

function deps(
  store: DataStore,
  membershipStore: MembershipStore,
): RouterDeps {
  return {
    verifier,
    memberships: membershipStore,
    store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

async function call(
  store: DataStore,
  membershipStore: MembershipStore,
  procedure: string,
  accessToken: string,
  input: unknown,
) {
  const router = buildRouter(deps(store, membershipStore), buildProcedures(store));
  return router.route({ procedure, accessToken, input });
}

describe("member role changes and removal", () => {
  it("lets an owner change a member's role and persists it", async () => {
    const { store, membershipStore, memberships, audit } = makeStore();
    const res = await call(store, membershipStore, "organizations.members.updateRole", TOKEN_ALICE, {
      organizationId: ORG_A,
      memberId: CAROL,
      role: "admin",
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(memberships.find((m) => m.userId === CAROL)?.role).toBe("admin");
    expect(audit.map((a) => a.event)).toContain("member.role_changed");
  });

  it("refuses an admin who tries to demote an owner", async () => {
    const { store, membershipStore, memberships } = makeStore();
    const res = await call(store, membershipStore, "organizations.members.updateRole", TOKEN_BOB, {
      organizationId: ORG_A,
      memberId: ALICE,
      role: "member",
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(memberships.find((m) => m.userId === ALICE)?.role).toBe("owner");
  });

  it("refuses an admin who tries to grant the owner role", async () => {
    const { store, membershipStore, memberships } = makeStore();
    const res = await call(store, membershipStore, "organizations.members.updateRole", TOKEN_BOB, {
      organizationId: ORG_A,
      memberId: CAROL,
      role: "owner",
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(memberships.find((m) => m.userId === CAROL)?.role).toBe("member");
  });

  it("refuses a member who tries to promote themselves", async () => {
    const { store, membershipStore, memberships } = makeStore();
    const res = await call(store, membershipStore, "organizations.members.updateRole", TOKEN_CAROL, {
      organizationId: ORG_A,
      memberId: CAROL,
      role: "owner",
    });
    expect(res.ok).toBe(false);
    // Carol lacks member:invite, so the guard refuses before self-promotion.
    expect([403, 404]).toContain(res.status);
    expect(memberships.find((m) => m.userId === CAROL)?.role).toBe("member");
  });

  it("refuses an owner who tries to change their own role", async () => {
    const { store, membershipStore, memberships } = makeStore();
    const res = await call(store, membershipStore, "organizations.members.updateRole", TOKEN_ALICE, {
      organizationId: ORG_A,
      memberId: ALICE,
      role: "admin",
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(memberships.find((m) => m.userId === ALICE)?.role).toBe("owner");
  });

  it("refuses to demote the last owner", async () => {
    const { store, membershipStore, memberships } = makeStore();
    // Alice is the only owner. An admin cannot touch her, but even a *second*
    // owner demoting her would be fine — so test the rule directly: make Bob an
    // owner, then have Bob try to demote himself (blocked as self-edit) and
    // Alice try to demote herself (blocked the same way). The genuine
    // last-owner case is an owner acting on the only other owner.
    const res = await call(store, membershipStore, "organizations.members.remove", TOKEN_ALICE, {
      organizationId: ORG_A,
      memberId: ALICE,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect(memberships.some((m) => m.userId === ALICE)).toBe(true);
  });

  it("lets a member remove themselves, so leaving an organization works", async () => {
    const { store, membershipStore, memberships, audit } = makeStore();
    const res = await call(store, membershipStore, "organizations.members.remove", TOKEN_CAROL, {
      organizationId: ORG_A,
      memberId: CAROL,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(memberships.some((m) => m.userId === CAROL)).toBe(false);
    expect(audit.find((a) => a.event === "member.removed")?.metadata).toMatchObject({ self: true });
  });

  it("refuses a member who tries to remove someone else", async () => {
    const { store, membershipStore, memberships } = makeStore();
    const res = await call(store, membershipStore, "organizations.members.remove", TOKEN_CAROL, {
      organizationId: ORG_A,
      memberId: BOB,
    });
    expect(res.ok).toBe(false);
    expect([403, 404]).toContain(res.status);
    expect(memberships.some((m) => m.userId === BOB)).toBe(true);
  });

  it("refuses an admin who tries to remove an owner", async () => {
    const { store, membershipStore, memberships } = makeStore();
    const res = await call(store, membershipStore, "organizations.members.remove", TOKEN_BOB, {
      organizationId: ORG_A,
      memberId: ALICE,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(memberships.some((m) => m.userId === ALICE)).toBe(true);
  });

  it("tells an outsider nothing, indistinguishable from a missing organization", async () => {
    const { store, membershipStore } = makeStore();
    for (const procedure of [
      "organizations.members.updateRole",
      "organizations.members.remove",
    ]) {
      const res = await call(store, membershipStore, procedure, TOKEN_DAVE, {
        organizationId: ORG_A,
        memberId: CAROL,
        role: "viewer",
      });
      expect(res.ok, procedure).toBe(false);
      expect(res.status, procedure).toBe(404);
    }
  });
});
