/**
 * Deployment protection through the real router.
 *
 * Deployment protection is what keeps a preview URL from being a public URL, so
 * the facts worth proving are the ones that decide whether a URL is reachable:
 * only an admin may change the posture, the password is hashed and never read
 * back, the posture that is stored is one the compiler will emit, and a save
 * that no edge enforces says so rather than reporting success.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  AuditEvent,
  AuditEventInput,
  DataStore,
  DeploymentProtection,
  DeploymentProtectionSaveInput,
  Organization,
  Project,
} from "@cloud-wai/database";
import type { OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";
import { buildProcedures, buildRouter, type RouterDeps } from "@cloud-wai/api";

const ALICE = "u-alice"; // owner of A
const CAROL = "u-carol"; // member (not admin) of A
const ORG_A = "org-a" as OrganizationId;
const TOKEN_ALICE = "t-alice";
const TOKEN_CAROL = "t-carol";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: {
    userId: ALICE,
    email: "a@x.test",
    displayName: "Alice",
    accessToken: TOKEN_ALICE,
  },
  [TOKEN_CAROL]: {
    userId: CAROL,
    email: "c@x.test",
    displayName: "Carol",
    accessToken: TOKEN_CAROL,
  },
};

const verifier: SessionVerifier = {
  async verify(token) {
    return sessions[token] ?? null;
  },
};

const memberships: Membership[] = [
  { organizationId: ORG_A, userId: ALICE, role: "owner" },
  { organizationId: ORG_A, userId: CAROL, role: "member" },
];
const membershipStore = {
  async membershipsFor(userId: string) {
    return memberships.filter((m) => m.userId === userId);
  },
};

function makeStore() {
  const organizations: Organization[] = [
    { id: ORG_A, name: "A", slug: "a", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const projects: Project[] = [
    {
      id: "pr-1" as ProjectId,
      organizationId: ORG_A,
      name: "P",
      slug: "p",
      providerResourceId: null,
      rootDirectory: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const rows = new Map<string, DeploymentProtection>();
  const audit: AuditEvent[] = [];
  // The digest is not on the client-facing row (mirroring the column grant), so
  // the fake keeps it beside the row exactly as the real store reads it service-side.
  const passwordHashes = new Map<string, string>();

  const store = {
    async listOrganizations() {
      return organizations;
    },
    async getDeploymentProtection(userId: UserId, projectId: ProjectId) {
      // The client path is membership-scoped: a caller who is not a member of
      // the row's organization sees nothing, which this fake mirrors by only
      // answering for a member.
      if (!memberships.some((m) => m.userId === userId)) return null;
      return rows.get(projectId) ?? null;
    },
    async saveDeploymentProtection(input: DeploymentProtectionSaveInput) {
      // The digest lives beside the row, never on it — mirroring the real store,
      // whose client-facing shape has no hash column.
      if (input.basicPasswordHash) passwordHashes.set(input.projectId, input.basicPasswordHash);
      if (input.mode !== "password") passwordHashes.delete(input.projectId);
      const row: DeploymentProtection = {
        id: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        mode: input.mode,
        basicUser: input.basicUser,
        allowedCidrs: input.allowedCidrs ?? [],
        protectionExpiresAt: input.protectionExpiresAt,
        version: (rows.get(input.projectId)?.version ?? 0) + 1,
        updatedBy: input.updatedBy,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      rows.set(input.projectId, row);
      return row;
    },
    async getDeploymentProtectionPasswordHash(
      _organizationId: OrganizationId,
      projectId: ProjectId,
    ) {
      return passwordHashes.get(projectId) ?? null;
    },
    async recordAuditEvent(input: AuditEventInput) {
      const event: AuditEvent = {
        id: `audit-${audit.length}`,
        organizationId: input.organizationId,
        actorId: input.actorId,
        actorEmail: input.actorEmail ?? null,
        event: input.event,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? {},
        createdAt: "2026-01-01T00:00:00Z",
      };
      audit.push(event);
      return event;
    },
  };

  return { store, rows, audit, passwordHashes, projects };
}

function deps(store: unknown): RouterDeps {
  let n = 0;
  return {
    verifier,
    memberships: membershipStore as never,
    store: store as DataStore,
    newId: () => `id-${++n}`,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

describe("deployment protection procedures", () => {
  it("refuses a member (non-admin) and allows the owner", async () => {
    const { store } = makeStore();
    const router = buildRouter(
      deps(store),
      buildProcedures(store as never, { newId: () => `id-${Math.random().toString(36).slice(2)}` }),
    );

    const refused = await router.route({
      procedure: "security.protection.save",
      accessToken: TOKEN_CAROL,
      input: {
        organizationId: ORG_A,
        projectId: "pr-1",
        mode: "password",
        basicPassword: "longenough",
      },
    });
    expect(refused.ok).toBe(false);
    expect([403, 404]).toContain(refused.status);

    const allowed = await router.route({
      procedure: "security.protection.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        projectId: "pr-1",
        mode: "password",
        basicPassword: "longenough",
      },
    });
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
  });

  it("hashes the password and never returns a digest to the client", async () => {
    const { store, rows, passwordHashes } = makeStore();
    const router = buildRouter(
      deps(store),
      buildProcedures(store as never, { newId: () => `id-${Math.random().toString(36).slice(2)}` }),
    );

    const saved = await router.route({
      procedure: "security.protection.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        projectId: "pr-1",
        mode: "password",
        basicUser: "preview",
        basicPassword: "correct horse battery",
      },
    });
    expect(saved.ok).toBe(true);
    const data = saved.data as { protection: DeploymentProtection };
    // The digest is stored (service-side) and absent from the answer.
    expect(passwordHashes.get("pr-1")).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data)).not.toContain("hash");
    expect(rows.get("pr-1")!.mode).toBe("password");
    // A user was defaulted, because basic auth always carries one.
    expect(rows.get("pr-1")!.basicUser).toBe("preview");
  });

  it("keeps an existing password when a save omits it", async () => {
    const { store, passwordHashes } = makeStore();
    const router = buildRouter(
      deps(store),
      buildProcedures(store as never, { newId: () => `id-${Math.random().toString(36).slice(2)}` }),
    );

    await router.route({
      procedure: "security.protection.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        projectId: "pr-1",
        mode: "password",
        basicPassword: "first-password",
      },
    });
    const first = passwordHashes.get("pr-1");

    // A later save that changes only the expiry must not drop the password.
    const second = await router.route({
      procedure: "security.protection.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        projectId: "pr-1",
        mode: "password",
        protectionExpiresAt: "2030-01-01T00:00:00Z",
      },
    });
    expect(second.ok).toBe(true);
    expect(passwordHashes.get("pr-1")).toBe(first);
  });

  it("refuses a password shorter than eight characters", async () => {
    const { store } = makeStore();
    const router = buildRouter(
      deps(store),
      buildProcedures(store as never, { newId: () => `id-${Math.random().toString(36).slice(2)}` }),
    );
    const res = await router.route({
      procedure: "security.protection.save",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, projectId: "pr-1", mode: "password", basicPassword: "short" },
    });
    expect(res.ok).toBe(false);
  });

  it("refuses an allow-list address the compiler would not emit", async () => {
    const { store } = makeStore();
    const router = buildRouter(
      deps(store),
      buildProcedures(store as never, { newId: () => `id-${Math.random().toString(36).slice(2)}` }),
    );
    const res = await router.route({
      procedure: "security.protection.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        projectId: "pr-1",
        mode: "ip",
        allowedCidrs: ["not-an-address"],
      },
    });
    expect(res.ok).toBe(false);
  });

  it("records the posture and reports it as not applied when no edge is configured", async () => {
    const { store, audit } = makeStore();
    const router = buildRouter(
      deps(store),
      buildProcedures(store as never, { newId: () => `id-${Math.random().toString(36).slice(2)}` }),
    );
    const res = await router.route({
      procedure: "security.protection.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        projectId: "pr-1",
        mode: "ip",
        allowedCidrs: ["203.0.113.0/24"],
      },
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const data = res.data as { applied: boolean; engineReason: string | null };
    // The engines are missing in this harness, so the honest answer is "stored,
    // not applied" — never a fake success.
    expect(data.applied).toBe(false);
    // And the change is attributed.
    expect(audit.some((e) => e.event === "deployment_protection.saved")).toBe(true);
  });

  it("reads back the saved posture, and never a digest", async () => {
    const { store } = makeStore();
    const router = buildRouter(
      deps(store),
      buildProcedures(store as never, { newId: () => `id-${Math.random().toString(36).slice(2)}` }),
    );
    await router.route({
      procedure: "security.protection.save",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        projectId: "pr-1",
        mode: "ip",
        allowedCidrs: ["203.0.113.0/24"],
      },
    });
    const res = await router.route({
      procedure: "security.protection.get",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, projectId: "pr-1" },
    });
    expect(res.ok).toBe(true);
    const data = res.data as { protection: DeploymentProtection | null };
    expect(data.protection?.mode).toBe("ip");
    expect(JSON.stringify(data)).not.toContain("hash");
  });
});
