/**
 * Provider health.
 *
 * The blueprint requires the dashboard to "display provider health" and forbids
 * fake metrics or placeholder connected badges. So this reports what the
 * adapters actually said, including `not_configured` — the state a brand-new
 * installation is in. There is no default of "healthy".
 */
import { requireCapability } from "../guard.js";
import type { OrganizationId } from "@cloud-wai/contracts";
import { engineReport, type Engines } from "@cloud-wai/adapters";
import type { RequestContext } from "../context.js";

export interface HealthDeps {
  /** The live engine set; the report is derived per request. */
  readonly engines: Engines;
}

export interface ProviderHealth {
  readonly provider: string;
  /** `ready` or `not_configured` — never a guessed "healthy". */
  readonly state: "ready" | "not_configured";
  readonly detail: string;
}

/** Flatten the engine report into a list the dashboard can render directly. */
export function providerHealth(
  ctx: RequestContext,
  deps: HealthDeps,
  organizationId: OrganizationId,
): readonly ProviderHealth[] {
  requireCapability(ctx, organizationId, "org:read");
  return engineReport(deps.engines).map((entry) => ({
    provider: entry.engine,
    state: entry.configured ? ("ready" as const) : ("not_configured" as const),
    detail: entry.configured
      ? "Configured for this deployment."
      : "No credentials configured; this deployment cannot act on this engine yet.",
  }));
}
