/**
 * @cloud-wai/security-control — policy compilation, distribution and incidents.
 *
 * This app sits between the policy the API accepts and the edge that enforces
 * it. Two responsibilities, both with rules that must not be relaxed:
 *
 *   * distribution never rolls a policy backwards, and the engine's own answer
 *     decides whether a distribution succeeded;
 *   * an incident is never silently closed. Closing records a resolution and why,
 *     and a `false_positive` close is distinguishable from a real fix.
 */
import type { AdapterContext, SecurityEdgeAdapter } from "@cloud-wai/adapters";
import type { AdapterResult, OrganizationId, ProviderRef } from "@cloud-wai/contracts";
import {
  isIncidentOpen,
  mayDistribute,
  validatePolicy,
  type IncidentSeverity,
  type IncidentState,
  type PolicyVersion,
  type SecurityPolicy,
} from "@cloud-wai/security";

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
      "Records an incident for every distribution the engine rejects.",
    ],
  };
}

/**
 * The active policy version per organization.
 *
 * Kept in memory here; the durable copy is `security_policies.version` in the
 * control plane. The rule this type exists to enforce: a version only ever moves
 * forward.
 */
export class PolicyVersionRegistry {
  private readonly active = new Map<OrganizationId, PolicyVersion>();

  get(organizationId: OrganizationId): PolicyVersion | null {
    return this.active.get(organizationId) ?? null;
  }

  /** Record a version that was successfully distributed. Never moves backwards. */
  record(organizationId: OrganizationId, version: PolicyVersion): void {
    const current = this.active.get(organizationId);
    if (current && version.policyId === current.policyId && version.version < current.version) {
      return;
    }
    this.active.set(organizationId, version);
  }
}

export interface IncidentRecord {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly kind: string;
  readonly severity: IncidentSeverity;
  readonly state: IncidentState;
  readonly summary: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly resolution: string | null;
}

export class IncidentTracker {
  private readonly byId = new Map<string, IncidentRecord>();
  private counter = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  open(input: {
    organizationId: OrganizationId;
    kind: string;
    severity: IncidentSeverity;
    summary: string;
  }): IncidentRecord {
    const incident: IncidentRecord = {
      id: `inc-${++this.counter}`,
      organizationId: input.organizationId,
      kind: input.kind,
      severity: input.severity,
      state: "open",
      summary: input.summary,
      openedAt: this.clock().toISOString(),
      closedAt: null,
      resolution: null,
    };
    this.byId.set(incident.id, incident);
    return incident;
  }

  triage(incidentId: string): IncidentRecord | null {
    const incident = this.byId.get(incidentId);
    if (!incident || incident.state !== "open") return null;
    const updated: IncidentRecord = { ...incident, state: "triaged" };
    this.byId.set(incidentId, updated);
    return updated;
  }

  /**
   * Close an incident.
   *
   * A resolution is required: an incident that disappears without one is worse
   * than one left open, because the next reader cannot tell whether it was fixed
   * or forgotten.
   */
  close(
    incidentId: string,
    resolution: string,
    outcome: "resolved" | "false_positive" = "resolved",
  ): IncidentRecord | null {
    const incident = this.byId.get(incidentId);
    if (!incident || !isIncidentOpen(incident)) return null;
    if (resolution.trim().length === 0) return null;

    const updated: IncidentRecord = {
      ...incident,
      state: outcome,
      resolution,
      closedAt: this.clock().toISOString(),
    };
    this.byId.set(incidentId, updated);
    return updated;
  }

  openIncidents(organizationId: OrganizationId): readonly IncidentRecord[] {
    return [...this.byId.values()].filter(
      (incident) => incident.organizationId === organizationId && isIncidentOpen(incident),
    );
  }

  get(incidentId: string): IncidentRecord | null {
    return this.byId.get(incidentId) ?? null;
  }
}

export interface DistributionOutcome {
  readonly distributed: boolean;
  readonly version: PolicyVersion;
  readonly reason: string;
}

export interface DistributionDeps {
  readonly edge: SecurityEdgeAdapter;
  readonly registry: PolicyVersionRegistry;
  readonly incidents: IncidentTracker;
  /** Names the policy for the edge; compiled syntax stays inside the adapter. */
  readonly providerRef: (policy: SecurityPolicy) => ProviderRef;
}

/**
 * Distribute a policy to the edge.
 *
 * Refuses a policy that would roll the active version backwards, applies it
 * through the edge adapter, and records the new version only when the engine
 * reported success. A non-success opens an incident — a rejected distribution is
 * a security event, not a rounding error.
 */
export async function distributePolicy(
  deps: DistributionDeps,
  policy: SecurityPolicy,
  ctx: AdapterContext,
): Promise<AdapterResult<DistributionOutcome>> {
  const valid = validatePolicy(policy);
  if (!valid.ok) return { ok: false, status: "failed", reason: valid.reason };

  const candidate: PolicyVersion = { policyId: policy.id, version: policy.version };
  const allow = mayDistribute(candidate, deps.registry.get(ctx.organizationId));
  if (!allow.ok) return { ok: false, status: "failed", reason: allow.reason };

  const applied = await deps.edge.applyPolicy(ctx, { ref: deps.providerRef(policy) });
  if (!applied.ok) {
    const incident = deps.incidents.open({
      organizationId: ctx.organizationId,
      kind: "policy_distribution_rejected",
      severity: applied.status === "not_configured" ? "medium" : "high",
      summary: `Policy ${policy.id} v${policy.version} was not applied: ${applied.reason}`,
    });
    return {
      ok: false,
      status: applied.status,
      reason: `${applied.reason} (incident ${incident.id})`,
    };
  }

  // The engine's echoed version is authoritative, but it can never be below what
  // we sent: a lower number would mean the edge quietly rolled back.
  const engineVersion = applied.value.version;
  const recorded: PolicyVersion = {
    policyId: candidate.policyId,
    version: engineVersion > policy.version ? engineVersion : policy.version,
  };
  deps.registry.record(ctx.organizationId, recorded);

  return {
    ok: true,
    status: "succeeded",
    value: { distributed: true, version: recorded, reason: "applied" },
  };
}
