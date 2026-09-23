/**
 * @cloud-wai/orchestrator — Durable command execution and reconciliation. Turns an authorized Cloud Wai command into a queued, idempotent job.
 */

export const APP_NAME = "orchestrator" as const;

export interface AppDescriptor {
  readonly name: string;
  readonly role: string;
  /** Boundaries this app enforces; asserted by tests in tests/. */
  readonly boundaries: readonly string[];
}

export function describe(): AppDescriptor {
  return {
    name: APP_NAME,
    role: "Durable command execution and reconciliation. Turns an authorized Cloud Wai command into a queued, idempotent job.",
    boundaries: [
      "Only receives commands the API has already authorized.",
      "Records an idempotency key before dispatch so retries cannot duplicate work.",
      "Writes an audit record for every state transition.",
    ],
  };
}
