/**
 * @cloud-wai/security-control — Policy compiler, rule distribution and incident tracking for the security edge.
 */

export const APP_NAME = "security-control" as const;

export interface AppDescriptor {
  readonly name: string;
  readonly role: string;
  /** Boundaries this app enforces; asserted by tests in tests/. */
  readonly boundaries: readonly string[];
}

export function describe(): AppDescriptor {
  return {
    name: APP_NAME,
    role: "Policy compiler, rule distribution and incident tracking for the security edge.",
    boundaries: [
      "Compiles Cloud Wai policy into engine configuration; callers never write engine syntax.",
      "Distributes policy with a monotonic version so the edge cannot roll back.",
    ],
  };
}
