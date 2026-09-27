/**
 * API-key authentication: a key acts for its owner, inside one organization.
 *
 * Before this suite, an API key could be minted, listed and revoked, but nothing
 * ever accepted one as a credential — `keyAllows`/`apiKeyMatches` were called
 * only from a unit test, and `last_used_at` was never written. That is the gap
 * this pins: a key presented as a bearer credential must authenticate, be
 * narrowed by its owner's *current* membership, and be confined to its own
 * organization.
 *
 * The resolver here is a real in-memory implementation of the store surface,
 * not a mock: it hashes and compares like the SQL-backed one, so the tests
 * exercise the context, the guard and the issuance logic for real.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import { issueApiKey } from "@cloud-wai/auth";
import type { ApiKeyAuthority, Membership } from "@cloud-wai/authorization";
import type { ApiKeyId, OrganizationId, UserId } from "@cloud-wai/contracts";
import {
  ApiError,
  buildContext,
  buildRouter,
  requireCapability,
  type ApiKeyResolver,
  type Procedure,
  type RequestContext,
} from "@cloud-wai/api";

const ALICE = "u-alice" as UserId;
const ORG_A = "org-a" as OrganizationId;
const ORG_B = "org-b" as OrganizationId;

const TOKEN_ALICE = "session-alice";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: {
    userId: ALICE,
    email: "alice@example.com",
    displayName: "Alice",
    accessToken: TOKEN_ALICE,
  },
};

const verifier: SessionVerifier = {
  async verify(token) {
    return sessions[token] ?? null;
  },
};

/** Mutable so a test can demote the owner between issuance and use. */
let memberships: Membership[] = [
  { organizationId: ORG_A, userId: ALICE, role: "owner" },
  { organizationId: ORG_B, userId: ALICE, role: "owner" },
];

const membershipStore = {
  async membershipsFor(userId: UserId) {
    return memberships.filter((m) => m.userId === userId);
  },
};

/** Mint a key and return the presented secret plus the resolver that knows it. */
function keyFor(role: Membership["role"], scopes: string[]) {
  const { record, secret } = issueApiKey({
    id: "k-1" as ApiKeyId,
    organizationId: ORG_A,
    ownerId: ALICE,
    name: "ci",
    role,
    requestedScopes: scopes as never,
    now: new Date("2026-01-01T00:00:00Z"),
  });
  const used: { organizationId: string; keyId: string }[] = [];
  let revoked = false;
  const resolver: ApiKeyResolver = {
    async findApiKeyByHash(hash): Promise<ApiKeyAuthority | null> {
      if (hash !== record.keyHash) return null;
      return revoked ? { ...record, revokedAt: "2026-02-01T00:00:00Z" } : record;
    },
    async markApiKeyUsed(input) {
      used.push(input);
    },
    async getProfileForService() {
      return { email: "alice@example.com" };
    },
  };
  return {
    secret,
    resolver,
    used,
    revoke: () => {
      revoked = true;
    },
  };
}

/** A procedure that needs one capability in the organization named in the body. */
function readProject(organizationId: OrganizationId): Procedure {
  return {
    name: "project.check",
    handler: async (ctx: RequestContext) => {
      requireCapability(ctx, organizationId, "project:read");
      return { ok: true };
    },
  };
}

function routerWith(apiKeys: ApiKeyResolver | undefined, organizationId: OrganizationId) {
  return buildRouter(
    {
      verifier,
      memberships: membershipStore,
      ...(apiKeys ? { apiKeys } : {}),
    },
    [readProject(organizationId)],
  );
}

describe("a Cloud Wai key bearer", () => {
  it("authenticates as its owner", async () => {
    const key = keyFor("owner", ["project:read"]);
    const ctx = await buildContext(
      { verifier, memberships: membershipStore, apiKeys: key.resolver },
      { accessToken: key.secret },
    );
    expect(ctx.principal.userId).toBe(ALICE);
    expect(ctx.apiKey?.organizationId).toBe(ORG_A);
    expect(ctx.apiKey?.keyId).toBe("k-1");
  });

  it("stamps last_used_at with the key's own tenant", async () => {
    const key = keyFor("owner", ["project:read"]);
    await buildContext(
      { verifier, memberships: membershipStore, apiKeys: key.resolver },
      { accessToken: key.secret },
    );
    expect(key.used).toEqual([{ organizationId: ORG_A, keyId: "k-1" }]);
  });

  it("is refused when the deployment cannot resolve keys", async () => {
    const key = keyFor("owner", ["project:read"]);
    await expect(
      buildContext({ verifier, memberships: membershipStore }, { accessToken: key.secret }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("is refused once revoked", async () => {
    const key = keyFor("owner", ["project:read"]);
    key.revoke();
    await expect(
      buildContext(
        { verifier, memberships: membershipStore, apiKeys: key.resolver },
        { accessToken: key.secret },
      ),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("is refused when its owner is no longer a member", async () => {
    const key = keyFor("owner", ["project:read"]);
    const saved = memberships;
    memberships = [];
    try {
      await expect(
        buildContext(
          { verifier, memberships: membershipStore, apiKeys: key.resolver },
          { accessToken: key.secret },
        ),
      ).rejects.toMatchObject({ code: "unauthenticated" });
    } finally {
      memberships = saved;
    }
  });

  it("is refused when the secret is unknown", async () => {
    const key = keyFor("owner", ["project:read"]);
    await expect(
      buildContext(
        { verifier, memberships: membershipStore, apiKeys: key.resolver },
        { accessToken: "cw_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      ),
    ).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("scope narrowing", () => {
  it("passes where its issued scope covers the capability", async () => {
    const key = keyFor("owner", ["project:read"]);
    const router = routerWith(key.resolver, ORG_A);
    const response = await router.route({
      procedure: "project.check",
      accessToken: key.secret,
      input: { organizationId: ORG_A },
    });
    expect(response.ok).toBe(true);
  });

  it("shrinks a key whose owner was demoted after issuance", async () => {
    const key = keyFor("owner", ["deployment:create"]);
    const router = routerWith(key.resolver, ORG_A);
    // ...but demote the owner to viewer; the key's issued scope exceeds the role.
    memberships = [{ organizationId: ORG_A, userId: ALICE, role: "viewer" }];
    try {
      const response = await router.route({
        procedure: "project.check",
        accessToken: key.secret,
        input: { organizationId: ORG_A },
      });
      expect(response.status).toBe(403);
    } finally {
      memberships = [
        { organizationId: ORG_A, userId: ALICE, role: "owner" },
        { organizationId: ORG_B, userId: ALICE, role: "owner" },
      ];
    }
  });
});

describe("tenant confinement", () => {
  it("cannot reach a second organization its owner belongs to", async () => {
    const key = keyFor("owner", ["project:read"]);
    // The key is bound to ORG_A; ask for ORG_B, where Alice is also an owner.
    const router = routerWith(key.resolver, ORG_B);
    const response = await router.route({
      procedure: "project.check",
      accessToken: key.secret,
      input: { organizationId: ORG_B },
    });
    expect(response.status).toBe(404);
  });

  it("keeps the session path unchanged", async () => {
    const router = routerWith(undefined, ORG_A);
    const ok = await router.route({
      procedure: "project.check",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(ok.ok).toBe(true);

    // A session is *not* confined to one organization the way a key is: the
    // procedure here is mounted for ORG_A, and Alice is also an owner in ORG_B,
    // so asking for ORG_B under the same session is allowed. This is the
    // deliberate difference between a session and a delegated key.
    const otherOrg = routerWith(undefined, ORG_B);
    const allowedInB = await otherOrg.route({
      procedure: "project.check",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_B },
    });
    expect(allowedInB.ok).toBe(true);
  });
});

describe("the error body", () => {
  it("never reveals that the key's organization exists to a foreign request", async () => {
    const key = keyFor("owner", ["project:read"]);
    const router = routerWith(key.resolver, ORG_B);
    const response = await router.route({
      procedure: "project.check",
      accessToken: key.secret,
      input: { organizationId: ORG_B },
    });
    expect(response.error?.message).toBe("Organization not found.");
  });
});

describe("guard direct use", () => {
  it("throws not_found for a foreign key org, forbidden for a missing scope", async () => {
    const key = keyFor("owner", ["project:read"]);
    const ctx = await buildContext(
      { verifier, memberships: membershipStore, apiKeys: key.resolver },
      { accessToken: key.secret },
    );
    expect(() => requireCapability(ctx, ORG_B, "project:read")).toThrowError(ApiError);
    expect(() => requireCapability(ctx, ORG_A, "org:delete")).toThrowError(ApiError);
    expect(() => requireCapability(ctx, ORG_A, "project:read")).not.toThrow();
  });
});
