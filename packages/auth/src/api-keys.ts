/**
 * API keys.
 *
 * A Cloud Wai API key is a credential that acts for a *person* inside one
 * organization. Two rules follow from that and are enforced here rather than
 * trusted to callers:
 *
 *   1. A key's scopes are a subset of what its owner's role grants, and are
 *      fixed to the organization the key was created in. A key can never exceed
 *      its owner's membership, and it cannot be widened after the fact.
 *   2. The secret is returned exactly once, at creation. Only a hash and a short
 *      display prefix are stored, so a leaked database row cannot be replayed as
 *      a key and a list response cannot leak one.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hasCapability, type Capability, type OrgRole } from "@cloud-wai/authorization";
import type { ApiKeyId, OrganizationId, UserId } from "@cloud-wai/contracts";

/** A key's scopes are organization capabilities — never a new axis of authority. */
export type ApiKeyScope = Capability;

export interface ApiKeyRecord {
  readonly id: ApiKeyId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  /** SHA-256 of the secret. The secret itself is never stored. */
  readonly keyHash: string;
  /** A short, non-secret prefix shown in the dashboard, e.g. `cw_live_ab12`. */
  readonly keyPrefix: string;
  readonly ownerId: UserId;
  readonly scopes: readonly ApiKeyScope[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

/** Shown to the user once, at creation, and never again. */
export interface IssuedApiKey {
  readonly record: ApiKeyRecord;
  readonly secret: string;
}

const SECRET_PREFIX = "cw_live_";

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time comparison, so a wrong key cannot be found one byte at a time. */
export function apiKeyMatches(secret: string, keyHash: string): boolean {
  const candidate = Buffer.from(hashApiKey(secret), "hex");
  const stored = Buffer.from(keyHash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/**
 * Narrow the requested scopes to what the owner's role actually grants.
 *
 * Returns the reduced set rather than throwing, because the caller (the API)
 * decides how to report it. An unknown scope is dropped, never added.
 */
export function boundedScopes(
  requested: readonly ApiKeyScope[],
  role: OrgRole,
): readonly ApiKeyScope[] {
  const unique = [...new Set(requested)];
  return unique.filter((scope) => hasCapability(role, scope));
}

/**
 * Issue a new key.
 *
 * `requestedScopes` are intersected with the owner's role: a member can create a
 * read-only key or nothing at all, but never an administrative one.
 */
export function issueApiKey(input: {
  id: ApiKeyId;
  organizationId: OrganizationId;
  ownerId: UserId;
  name: string;
  role: OrgRole;
  requestedScopes: readonly ApiKeyScope[];
  now?: Date;
}): IssuedApiKey {
  const secret = `${SECRET_PREFIX}${randomBytes(24).toString("base64url")}`;
  const scopes = boundedScopes(input.requestedScopes, input.role);

  const record: ApiKeyRecord = {
    id: input.id,
    organizationId: input.organizationId,
    name: input.name,
    keyHash: hashApiKey(secret),
    keyPrefix: secret.slice(0, SECRET_PREFIX.length + 4),
    ownerId: input.ownerId,
    scopes,
    createdAt: (input.now ?? new Date()).toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };

  return { record, secret };
}

export function isKeyActive(record: ApiKeyRecord, now: Date = new Date()): boolean {
  return record.revokedAt === null && new Date(record.createdAt).getTime() <= now.getTime();
}

/**
 * Authorize a request made with a key.
 *
 * A revoked or inactive key is refused, and a scope the key does not carry is
 * refused, even if the owner's current role would grant it. The key's scopes are
 * the authority, not the owner's live role — otherwise revoking a scope on a key
 * would silently not revoke it.
 */
export function keyAllows(
  record: ApiKeyRecord,
  scope: ApiKeyScope,
  now: Date = new Date(),
): boolean {
  if (!isKeyActive(record, now)) return false;
  return record.scopes.includes(scope);
}

/** The record as it may leave the API: never the hash, never the secret. */
export function publicApiKey(record: ApiKeyRecord): Omit<ApiKeyRecord, "keyHash"> {
  const { keyHash: _keyHash, ...rest } = record;
  return rest;
}
