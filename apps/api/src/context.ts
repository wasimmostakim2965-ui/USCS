/**
 * Request context assembly.
 *
 * The one rule that makes multi-tenancy safe: the principal comes from a
 * verified Supabase session, and the organization scope comes from a
 * server-side membership lookup. Nothing about scope is read from the request.
 */
import type { Principal } from "@cloud-wai/contracts";
import type { Membership } from "@cloud-wai/authorization";
import type { MembershipStore } from "@cloud-wai/database";
import { UnauthenticatedError, type SessionVerifier, resolvePrincipal } from "@cloud-wai/auth";
import { ApiError } from "./errors.js";

export interface RequestContext {
  readonly principal: Principal;
  /** Memberships loaded server-side for this request. */
  readonly memberships: readonly Membership[];
}

export interface AuthenticatedRequest {
  /** Bearer token from the Supabase session. */
  readonly accessToken: string | null | undefined;
  /**
   * The body as received. Procedures may read inputs from it, but scope is
   * never derived from it — `organizationId` in a body is only used to look up a
   * membership the server already holds.
   */
  readonly body?: unknown;
}

export interface ContextDeps {
  readonly verifier: SessionVerifier;
  readonly memberships: MembershipStore;
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
  let principal: Principal;
  try {
    principal = await resolvePrincipal(deps.verifier, request.accessToken);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      throw new ApiError("unauthenticated", "Authentication required.");
    }
    throw error;
  }

  const memberships = await deps.memberships.membershipsFor(principal.userId);
  return { principal, memberships };
}
