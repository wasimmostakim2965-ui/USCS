/**
 * @cloud-wai/security — policy model, risk levels and edge configuration.
 *
 * Cloud Wai owns the policy vocabulary. Engine specifics (Coraza directive
 * syntax, Envoy filter YAML, nftables rulesets) are produced by the security
 * adapter, never by callers.
 */
import type { SecurityPolicyId, OrganizationId } from "@cloud-wai/contracts";

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Action an edge rule takes when it matches. */
export const ENFORCEMENT_ACTIONS = ["allow", "log", "challenge", "block", "quarantine"] as const;
export type EnforcementAction = (typeof ENFORCEMENT_ACTIONS)[number];

/**
 * A compiled, versioned edge policy.
 *
 * `version` is monotonic per organization so the edge can reject a stale
 * distribution — policy must never silently roll backwards.
 */
export interface SecurityPolicy {
  readonly id: SecurityPolicyId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly riskLevel: RiskLevel;
  readonly action: EnforcementAction;
  readonly version: number;
}

export interface PolicyVersion {
  readonly policyId: SecurityPolicyId;
  readonly version: number;
}

/**
 * The incident lifecycle.
 *
 * An incident opens on a signal (a blocked request, a health regression, a
 * suspected origin leak), is triaged, and closes with a recorded resolution.
 * `resolved` and `false_positive` are terminal; `open` and `triaged` are not.
 */
export const INCIDENT_STATES = ["open", "triaged", "resolved", "false_positive"] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export interface SecurityIncident {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly kind: string;
  readonly severity: IncidentSeverity;
  readonly state: IncidentState;
  readonly summary: string;
  /** When the signal was first observed. */
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly resolution: string | null;
}

export function isIncidentOpen(incident: SecurityIncident): boolean {
  return incident.state === "open" || incident.state === "triaged";
}

/** Validate a policy before it is compiled or distributed. */
export function validatePolicy(
  policy: SecurityPolicy,
): { ok: true } | { ok: false; reason: string } {
  if (policy.name.trim().length === 0) return { ok: false, reason: "A policy must have a name." };
  if (policy.name.length > 120)
    return { ok: false, reason: "A policy name is at most 120 characters." };
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    return { ok: false, reason: "A policy version must be a positive integer." };
  }
  if (!RISK_LEVELS.includes(policy.riskLevel)) return { ok: false, reason: "Unknown risk level." };
  if (!ENFORCEMENT_ACTIONS.includes(policy.action)) {
    return { ok: false, reason: "Unknown enforcement action." };
  }
  return { ok: true };
}

/**
 * Decide whether a candidate policy version may be distributed.
 *
 * Versions are monotonic per organization so the edge cannot silently roll
 * backwards: a candidate must be newer than what is already active. Equal is
 * allowed because re-distribution is idempotent, but older never is.
 */
export function mayDistribute(
  candidate: PolicyVersion,
  active: PolicyVersion | null,
): { ok: true } | { ok: false; reason: string } {
  if (!active) return { ok: true };
  if (candidate.policyId !== active.policyId) {
    return { ok: false, reason: "The candidate policy is not the active policy." };
  }
  if (candidate.version < active.version) {
    return {
      ok: false,
      reason: `Version ${candidate.version} is older than the active version ${active.version}. Policy never rolls backwards.`,
    };
  }
  return { ok: true };
}
