/**
 * @cloud-wai/ui — accessible Cloud Wai design system primitives.
 *
 * Owned by Cloud Wai, not copied from any engine. Components expose explicit
 * state so callers cannot render a success look for a `not_configured` result.
 */
import type { EngineStatus } from "@cloud-wai/contracts";

export type ViewState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "success"; data: unknown }
  | { kind: "degraded"; reason: string }
  | { kind: "error"; message: string };

/** Map an engine status to the only view state that honestly describes it. */
export function stateForStatus(status: EngineStatus, reason = ""): ViewState {
  switch (status) {
    case "succeeded":
      return { kind: "success", data: null };
    case "degraded":
      return { kind: "degraded", reason };
    case "failed":
      return { kind: "error", message: reason || "Engine reported failure." };
    case "not_configured":
      return { kind: "degraded", reason: "Engine is not configured in this deployment." };
    case "pending":
    case "running":
      return { kind: "loading" };
  }
}
