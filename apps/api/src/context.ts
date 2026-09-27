/**
 * Request context assembly.
 *
 * The one rule that makes multi-tenancy safe: the principal comes from a
 * verified Supabase session, and the organization scope comes from a
 * server-side membership lookup. Nothing about scope is read from the request.
 *
 * A request may authenticate in one of two ways, and neither trusts the body:
 *
 *   * a Supabase session bearer token, verified by the identity provider; or
 *   * a Cloud Wai API key, resolved by the SHA-256 of the presented secret.
 *
 * An API key acts *for its owner*: the principal is the key's owner, the tenant
 * is the key's organization, and the effective scopes are the key's issued
 * scopes intersected with the owner's *current* membership. That last step is
 * what stops a key minted by an owner who was later demoted from keeping the
 * authority it was issued with.
 */
import type { Capability, Membership, OrgRole } from "@cloud-wai/authorization";
import type { Principal } from "@cloud-wai/contracts";
import type { MembershipStore } from "@cloud-wai/database";
import {
  UnauthenticatedError,
  effectiveScopes,
  hashApiKey,
  looksLikeApiKey,
  type ApiKeyAuthority,
  type SessionVerifier,
  resolvePrincipal,
} from "@cloud-wai/auth";
import { ApiError } from "./errors.js";

export interface RequestContext {
  readonly principal: Principal;
  /** Memberships loaded server-side for this request. */
  readonly memberships: readonly Membership[];
  /**
   * When the request was made with an API key, that key's organization and the
   * scopes that remain valid for it. Absent for a session request.
   */
  readonly apiKey?: ApiKeyAuth | undefined;
}

/** The authority a request carries because it presented a valid API key. */
export interface ApiKeyAuth {
  readonly keyId: string;
  readonly organizationId: string;
  /** Issued scopes ∩ the owner's live capabilities. */
  readonly scopes: readonly Capability[];
}

export interface AuthenticatedRequest {
  /** Bearer token from the Supabase session, or a Cloud Wai API key. */
  readonly accessToken: string | null | undefined;
  /**
   * The body as received. Procedures may read inputs from it, but scope is
   * never derived from it — `organizationId` in a body is only used to look up a
   * membership the server already holds.
   */
  readonly body?: unknown;
}

/**
 * The store surface key authentication needs.
 *
 * Kept minimal and explicit: a key is resolved by hash, its presence is stamped,
 * and its owner's profile supplies the audit email. Nothing else from the store
 * is reachable from the authentication path.
 */
export interface ApiKeyResolver {
  findApiKeyByHash(hash: string): Promise<ApiKeyAuthority | null>;
  markApiKeyUsed(input: {
    readonly organizationId: string;
    readonly keyId: string;
  }): Promise<void>;
  getProfileForService(userId: string): Promise<{ readonly email: string } | null>;
}

export interface ContextDeps {
  readonly verifier: SessionVerifier;
  readonly memberships: MembershipStore;
  /**
   * When wired, a bearer token shaped like a Cloud Wai key is resolved through
   * this instead of the identity provider. Absent means keys are not accepted,
   * which is the honest state of a deployment whose store cannot resolve one.
   */
  readonly apiKeys?: ApiKeyResolver | undefined;
  readonly now?: (() => Date) | undefined;
}

/** The role the key's owner holds in the key's organization, from live membership. */
function roleForKey(
  apiKey: ApiKeyAuthority,
  memberships: readonly Membership[],
): OrgRole | null {
  const membership = memberships.find(
    (m) => m.organizationId === apiKey.organizationId && m.userId === apiKey.ownerId,
  );
  return membership ? membership.role : null;
}

/**
 * Authenticate a request with an API key, or throw.
 *
 * Every failure is the same `unauthenticated`: an unknown key, a revoked key and
 * a key whose owner left the organization are indistinguishable to the caller.
 * A revoked key is refused rather than honoured, and — because revocation is a
 * fact worth knowing — the caller may still log the id; that is the caller's
 * choice, not something the response reveals.
 */
async function authenticateApiKey(
  deps: ContextDeps,
  presented: string,
): Promise<{ principal: Principal; memberships: readonly Membership[]; apiKey: ApiKeyAuth }> {
  const resolver = deps.apiKeys;
  if (!resolver) throw new ApiError("unauthenticated", "Authentication required.");

  const record = await resolver.findApiKeyByHash(hashApiKey(presented));
  if (!record || record.revokedAt !== null) {
    throw new ApiError("unauthenticated", "Authentication required.");
  }

  const memberships = await deps.memberships.membershipsFor(record.ownerId);
  const now = deps.now ? deps.now() : new Date();
  const scopes = effectiveScopes(record, memberships, now);
  // A key whose owner is no longer a member resolves to zero scopes; refusing
  // here keeps a non-member from reaching any procedure at all.
  if (roleForKey(record, memberships) === null) {
    throw new ApiError("unauthenticated", "Authentication required.");
  }

  // The owner's profile supplies the human behind the key, for the audit trail.
  // A missing profile is unusual but not a reason to reject: the key is valid
  // and the organization is known, so the email is the honest null.
  const profile = await resolver.getProfileForService(record.ownerId);
  const principal: Principal = {
    userId: record.ownerId,
    email: profile?.email ?? "",
    displayName: null,
  };

  return {
    principal,
    memberships,
    apiKey: { keyId: record.id, organizationId: record.organizationId, scopes },
  };
}

/**
 * Build the request context, or throw `ApiError('unauthenticated')`.
 *
 * A missing session, an email-less session and a session the verifier rejects
 * all produce the same error, so an attacker learns nothing from the difference.
 */
export async function buildContext(
  deps: ContextDeps,
  request: AuthenticatedRequest,
): Promise<RequestContext> {
  const presented = request.accessToken;

  // A Cloud Wai key has a fixed public prefix; a Supabase token is a JWT. The
  // shape decides which verifier runs, so a token is never sent to a lookup it
  // could not match and a key is never sent to the identity provider.
  if (presented && looksLikeApiKey(presented)) {
    const { principal, memberships, apiKey } = await authenticateApiKey(deps, presented);
    // A stamp is a courtesy for the dashboard, never a gate: a lost write must
    // not fail an otherwise valid request.
    try {
      await deps.apiKeys?.markApiKeyUsed({
        organizationId: apiKey.organizationId,
        keyId: apiKey.keyId,
      });
    } catch {
      // Best-effort; the request is already authenticated.
    }
    return { principal, memberships, apiKey };
  }

  let principal: Principal;
  try {
    principal = await resolvePrincipal(deps.verifier, presented);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      throw new ApiError("unauthenticated", "Authentication required.");
    }
    throw error;
  }

  const memberships = await deps.memberships.membershipsFor(principal.userId);
  return { principal, memberships };
}
