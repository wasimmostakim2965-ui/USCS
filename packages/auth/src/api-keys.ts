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
import {
  CAPABILITIES,
  hasCapability,
  type Capability,
  type Membership,
  type OrgRole,
} from "@cloud-wai/authorization";
import type { ApiKeyId, OrganizationId, UserId } from "@cloud-wai/contracts";

/** A key's scopes are organization capabilities — never a new axis of authority. */
export type ApiKeyScope = Capability;

export interface ApiKeyRecord extends ApiKeyAuthority {
  readonly name: string;
  /** SHA-256 of the secret. The secret itself is never stored. */
  readonly keyHash: string;
  /** A short, non-secret prefix shown in the dashboard, e.g. `cw_live_ab12`. */
  readonly keyPrefix: string;
  readonly lastUsedAt: string | null;
}

/**
 * The fields an *authority decision* needs, without the secret material.
 *
 * Split out because the store that resolves a key lives in a package that must
 * not depend on this one (`@cloud-wai/database` ← `@cloud-wai/auth`), while the
 * decision functions live here. A structural interface lets the store hand back
 * exactly these fields — `scopes` as plain strings — and this package still do
 * the authority check, with no cast and no duplicated logic.
 */
export interface ApiKeyAuthority {
  readonly id: ApiKeyId;
  readonly organizationId: OrganizationId;
  readonly ownerId: UserId;
  /** The scopes the key was issued with, as the store returned them. */
  readonly scopes: readonly string[];
  readonly createdAt: string;
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

export function isKeyActive(record: ApiKeyAuthority, now: Date = new Date()): boolean {
  return record.revokedAt === null && new Date(record.createdAt).getTime() <= now.getTime();
}

/**
 * Whether a presented string is shaped like a Cloud Wai key.
 *
 * Checked before any lookup so an ordinary Supabase bearer token — which is a
 * JWT, not a key — is not mistaken for one, and a lookup is not spent on a
 * string that could never be a key. The prefix is the whole test: it is a public
 * constant, so it leaks nothing an attacker does not already know.
 */
export function looksLikeApiKey(presented: string): boolean {
  return presented.startsWith(SECRET_PREFIX) && presented.length > SECRET_PREFIX.length + 20;
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
  record: ApiKeyAuthority,
  scope: ApiKeyScope,
  now: Date = new Date(),
): boolean {
  if (!isKeyActive(record, now)) return false;
  return record.scopes.includes(scope);
}

/**
 * Narrow a key's stored scopes by its owner's *current* membership.
 *
 * A key's authority is the intersection of what it was issued with and what its
 * owner may still do. `keyAllows` alone would not notice an owner demoted after
 * issuance: the key's stored scopes are a snapshot, and a snapshot can claim
 * more than the person holds today. The member list is loaded server-side like
 * every other scope decision, so this is the same boundary the session path
 * uses, applied one level down.
 *
 * An empty intersection means the key can do nothing, which is the honest answer
 * for a key whose owner lost the organization.
 */
export function effectiveScopes(
  record: ApiKeyAuthority,
  memberships: readonly Membership[],
  now: Date = new Date(),
): readonly ApiKeyScope[] {
  if (!isKeyActive(record, now)) return [];
  const membership = memberships.find(
    (m) => m.organizationId === record.organizationId && m.userId === record.ownerId,
  );
  if (!membership) return [];
  // A stored scope is a string from the database, so it is validated against the
  // known capability set before it is trusted as one: a scope the vocabulary no
  // longer contains is dropped, never coerced into a capability.
  return record.scopes.filter(
    (scope): scope is ApiKeyScope =>
      (CAPABILITIES as readonly string[]).includes(scope) &&
      hasCapability(membership.role, scope as ApiKeyScope),
  );
}

/** The record as it may leave the API: never the hash, never the secret. */
export function publicApiKey(record: ApiKeyRecord): Omit<ApiKeyRecord, "keyHash"> {
  const { keyHash: _keyHash, ...rest } = record;
  return rest;
}
