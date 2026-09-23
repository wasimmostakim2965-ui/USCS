/**
 * Engine lifecycle status.
 *
 * A Cloud Wai adapter must never report `succeeded` for work it did not
 * actually perform. When an engine is unreachable, unlicensed or simply not
 * configured in this deployment, the adapter reports one of the honest
 * non-success states below instead of fabricating a result.
 */
export const ENGINE_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "degraded",
  "not_configured",
] as const;

export type EngineStatus = (typeof ENGINE_STATUSES)[number];

/** States that represent an adapter being unable to act at all. */
export const UNCONFIGURED_STATUS: EngineStatus = "not_configured";

export function isTerminal(status: EngineStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "not_configured";
}

export function isSuccess(status: EngineStatus): boolean {
  return status === "succeeded";
}
