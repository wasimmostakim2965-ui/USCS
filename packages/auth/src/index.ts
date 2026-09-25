/**
 * @cloud-wai/auth — Supabase session to Cloud Wai principal mapping.
 *
 * Supabase Auth is the ONLY browser identity source. A hosting engine's user is
 * never a customer identity. This package converts a verified Supabase session
 * into a `Principal` that the rest of the control plane can authorize against.
 */
import type { Principal } from "@cloud-wai/contracts";

export interface SupabaseSession {
  readonly userId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  /** Raw JWT, used only to verify the session with Supabase. */
  readonly accessToken: string;
}

export interface SessionVerifier {
  verify(accessToken: string): Promise<SupabaseSession | null>;
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("No authenticated Supabase session.");
    this.name = "UnauthenticatedError";
  }
}

/**
 * Map a verified session to a principal.
 *
 * A session without an email cannot be a Cloud Wai principal: email is the
 * human-identifying attribute used throughout audit records.
 */
export function toPrincipal(session: SupabaseSession): Principal {
  if (!session.email) {
    throw new UnauthenticatedError();
  }
  return {
    userId: session.userId,
    email: session.email,
    displayName: session.displayName,
  };
}

/** Resolve a principal from a bearer token, or throw `UnauthenticatedError`. */
export async function resolvePrincipal(
  verifier: SessionVerifier,
  accessToken: string | null | undefined,
): Promise<Principal> {
  if (!accessToken) throw new UnauthenticatedError();
  const session = await verifier.verify(accessToken);
  if (!session) throw new UnauthenticatedError();
  return toPrincipal(session);
}

export * from "./api-keys.js";
export * from "./supabase-verifier.js";
export * from "./secrets.js";
