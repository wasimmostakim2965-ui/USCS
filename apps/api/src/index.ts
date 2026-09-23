/**
 * @cloud-wai/api — Cloud Wai API/BFF. Every procedure resolves a principal, enforces organization scope server-side, and never trusts a client-supplied organization id.
 */

export const APP_NAME = "api" as const;

export interface AppDescriptor {
  readonly name: string;
  readonly role: string;
  /** Boundaries this app enforces; asserted by tests in tests/. */
  readonly boundaries: readonly string[];
}

export function describe(): AppDescriptor {
  return {
    name: APP_NAME,
    role: "Cloud Wai API/BFF. Every procedure resolves a principal, enforces organization scope server-side, and never trusts a client-supplied organization id.",
    boundaries: [
      "Resolves the principal from the Supabase session on every request.",
      "Resolves organization membership server-side; never trusts client org ids.",
      "Enqueues commands instead of calling engines directly.",
      "Returns honest not_configured/degraded states instead of faking success.",
    ],
  };
}
