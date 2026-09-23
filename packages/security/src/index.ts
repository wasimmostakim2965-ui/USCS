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
