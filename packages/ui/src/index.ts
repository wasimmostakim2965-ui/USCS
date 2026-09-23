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

/**
 * A dashboard section.
 *
 * `state` is the only thing a view may render from. A section that could not
 * load carries no data at all, so there is nothing for a component to
 * accidentally display as if it had succeeded.
 */
export interface Section<T> {
  readonly title: string;
  readonly state: SectionState<T>;
}

export type SectionState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "empty"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly T[] }
  | { readonly kind: "degraded"; readonly reason: string }
  | { readonly kind: "error"; readonly message: string };

export function loading<T>(title: string): Section<T> {
  return { title, state: { kind: "loading" } };
}

export function ready<T>(title: string, items: readonly T[]): Section<T> {
  // An empty list is `empty`, not `ready`: a view can then say so explicitly
  // rather than rendering a blank panel that looks like a loading failure.
  return items.length === 0
    ? { title, state: { kind: "empty", message: "Nothing here yet." } }
    : { title, state: { kind: "ready", items } };
}

export function degraded<T>(title: string, reason: string): Section<T> {
  return { title, state: { kind: "degraded", reason } };
}

export function errored<T>(title: string, message: string): Section<T> {
  return { title, state: { kind: "error", message } };
}

/** True only for a section that has data to show. */
export function hasData<T>(section: Section<T>): boolean {
  return section.state.kind === "ready";
}

/**
 * Whether a section is showing something other than success.
 *
 * Used by the shell to render a banner; a `degraded` section must be visible as
 * degraded, not hidden in a collapsed panel.
 */
export function needsAttention<T>(section: Section<T>): boolean {
  return section.state.kind === "degraded" || section.state.kind === "error";
}

/**
 * The deployment status label and tone.
 *
 * `not_configured` is its own tone, deliberately distinct from failure: it is a
 * deployment fact, not an error the customer caused.
 */
export interface StatusPresentation {
  readonly label: string;
  readonly tone: "neutral" | "progress" | "positive" | "warning" | "danger";
}

export function presentDeploymentStatus(status: EngineStatus): StatusPresentation {
  switch (status) {
    case "pending":
      return { label: "Queued", tone: "neutral" };
    case "running":
      return { label: "Deploying", tone: "progress" };
    case "succeeded":
      return { label: "Live", tone: "positive" };
    case "degraded":
      return { label: "Degraded", tone: "warning" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "not_configured":
      return { label: "Not configured", tone: "neutral" };
  }
}
