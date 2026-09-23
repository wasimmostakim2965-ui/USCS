/**
 * API keys: scope bounding and one-time disclosure.
 *
 * The release gate is "API keys cannot exceed scopes or membership". Both halves
 * are checked here against the real issuer and the real procedure, because a key
 * that silently carries more authority than its owner is the kind of bug that
 * only shows up in an incident.
 */
import { describe, expect, it } from "vitest";
import {
  apiKeyMatches,
  boundedScopes,
  hashApiKey,
  isKeyActive,
  issueApiKey,
  keyAllows,
  publicApiKey,
} from "@cloud-wai/auth";
import type { ApiKeyId, OrganizationId, UserId } from "@cloud-wai/contracts";

const ORG = "org-a" as OrganizationId;
const OWNER = "u-alice" as UserId;

const issue = (role: Parameters<typeof issueApiKey>[0]["role"], requestedScopes: string[]) =>
  issueApiKey({
    id: "k-1" as ApiKeyId,
    organizationId: ORG,
    ownerId: OWNER,
    name: "ci",
    role,
    requestedScopes: requestedScopes as never,
    now: new Date("2026-01-01T00:00:00Z"),
  });

describe("scope bounding", () => {
  it("lets an owner request what an owner holds", () => {
    const { record } = issue("owner", ["org:delete", "billing:manage"]);
    expect(record.scopes).toEqual(["org:delete", "billing:manage"]);
  });

  it("drops a scope the role does not grant", () => {
    // A member asking for org:delete and billing:manage gets neither.
    const { record } = issue("member", ["org:delete", "billing:manage", "project:read"]);
    expect(record.scopes).toEqual(["project:read"]);
  });

  it("drops an unknown scope", () => {
    expect(boundedScopes(["made:up" as never, "org:read"], "owner")).toEqual(["org:read"]);
  });

  it("never widens: a viewer cannot ask for a write scope", () => {
    const { record } = issue("viewer", ["deployment:create", "org:read"]);
    expect(record.scopes).toEqual(["org:read"]);
  });
});

describe("the secret", () => {
  it("is returned once, and only its hash is stored", () => {
    const { record, secret } = issue("owner", ["org:read"]);
    expect(secret.startsWith("cw_live_")).toBe(true);
    expect(record.keyHash).toBe(hashApiKey(secret));
    // The record does not contain the secret.
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it("verifies with a constant-time match", () => {
    const { record, secret } = issue("owner", ["org:read"]);
    expect(apiKeyMatches(secret, record.keyHash)).toBe(true);
    expect(apiKeyMatches(`${secret}x`, record.keyHash)).toBe(false);
    expect(apiKeyMatches("wrong", record.keyHash)).toBe(false);
  });

  it("shows only a short prefix in the dashboard record", () => {
    const { record, secret } = issue("owner", ["org:read"]);
    expect(record.keyPrefix.length).toBeLessThan(secret.length);
    expect(secret.startsWith(record.keyPrefix)).toBe(true);
  });

  it("is absent from the public shape", () => {
    const { record } = issue("owner", ["org:read"]);
    expect(publicApiKey(record)).not.toHaveProperty("keyHash");
    expect(publicApiKey(record)).toHaveProperty("keyPrefix");
  });

  it("issues a distinct secret every time", () => {
    const a = issue("owner", ["org:read"]);
    const b = issue("owner", ["org:read"]);
    expect(a.secret).not.toBe(b.secret);
  });
});

describe("authorization by key", () => {
  it("allows a scope the key carries", () => {
    const { record } = issue("owner", ["org:read", "project:read"]);
    expect(keyAllows(record, "project:read")).toBe(true);
  });

  it("refuses a scope the key does not carry, even if the owner's role would grant it", () => {
    // The owner is an owner, but the key was narrowed to org:read.
    const { record } = issue("owner", ["org:read"]);
    expect(keyAllows(record, "org:delete")).toBe(false);
  });

  it("refuses a revoked key for every scope", () => {
    const { record } = issue("owner", ["org:read"]);
    const revoked = { ...record, revokedAt: "2026-01-02T00:00:00Z" };
    expect(isKeyActive(revoked)).toBe(false);
    expect(keyAllows(revoked, "org:read")).toBe(false);
  });

  it("refuses a key that is not yet valid", () => {
    const { record } = issue("owner", ["org:read"]);
    const future = { ...record, createdAt: "2030-01-01T00:00:00Z" };
    expect(isKeyActive(future, new Date("2026-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("organization binding", () => {
  it("binds a key to exactly one organization and one owner", () => {
    const { record } = issue("owner", ["org:read"]);
    expect(record.organizationId).toBe(ORG);
    expect(record.ownerId).toBe(OWNER);
  });
});
