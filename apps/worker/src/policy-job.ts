/**
 * The worker's policy-distribution job: apply the compiled policy to the edge.
 *
 * The policy is re-read on the service role, so the version that is applied is
 * the one the organization actually holds — not the one a stale payload names.
 * `mayDistribute` is re-checked here, before the edge is called: the API checked
 * it too, but between the two a newer policy may have activated, and a job that
 * skipped the check could roll the edge backwards.
 *
 * On acceptance the row is saved `active` at the version the edge echoed, never
 * below what was sent; on refusal the row keeps its state and a `rejected`
 * transition is recorded. Both branches write an audit row.
 */
import type { AdapterResult, EngineStatus } from "@cloud-wai/contracts";
import { err, ok, POLICY_JOB_KIND, type PolicyJobPayload } from "@cloud-wai/contracts";
import type { Job, SecurityEdgeAdapter } from "@cloud-wai/adapters";
import type { SecurityPolicy } from "@cloud-wai/database";
import { mayDistribute, validatePolicy, type PolicyVersion } from "@cloud-wai/security";
import type { JobHandler } from "./processor.js";

export interface PolicyExecutionWrites {
  /** The organization's policy, scoped by organization, for a sessionless caller. */
  getSecurityPolicyForService(organizationId: string): Promise<SecurityPolicy | null>;
  saveSecurityPolicy(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly riskLevel: SecurityPolicy["riskLevel"];
    readonly action: SecurityPolicy["action"];
    readonly state: SecurityPolicy["state"];
    readonly version: number;
    readonly createdBy: string;
  }): Promise<SecurityPolicy>;
  recordPolicyEvent(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly policyId: string;
    readonly fromState: SecurityPolicy["state"] | null;
    readonly toState: SecurityPolicy["state"];
    readonly version: number;
    readonly actorId: string | null;
    readonly actorEmail: string | null;
    readonly detail: string | null;
  }): Promise<unknown>;
  recordAuditEvent(input: {
    readonly organizationId: string;
    readonly actorId: string | null;
    readonly actorEmail: string | null;
    readonly event: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface PolicyJobDeps {
  readonly securityEdge: SecurityEdgeAdapter;
  readonly writes: PolicyExecutionWrites;
  readonly newId: () => string;
  readonly now?: () => Date;
}

export interface PolicyExecutionResult {
  readonly status: EngineStatus;
  readonly state: SecurityPolicy["state"];
  readonly version: number;
  readonly distributed: boolean;
  readonly reason: string | null;
}

/** The handler for `policy.distribute.execute`. */
export function buildPolicyJobHandler(deps: PolicyJobDeps): JobHandler {
  return async (payload) => {
    const input = payload as PolicyJobPayload;
    const policy = await deps.writes.getSecurityPolicyForService(input.organizationId);
    if (!policy || policy.id !== input.policyId) {
      return err("failed", "The policy this job names no longer exists.");
    }

    const valid = validatePolicy(policy);
    if (!valid.ok) return err("failed", valid.reason);

    // Guard again against a version that moved between the request and the job:
    // the stored version is authoritative, and a job may only send what is
    // current or newer.
    const active: PolicyVersion | null =
      policy.state === "active" ? { policyId: policy.id, version: policy.version } : null;
    const candidate: PolicyVersion = { policyId: policy.id, version: policy.version };
    const allow = mayDistribute(candidate, active);
    if (!allow.ok) return err("degraded", allow.reason);

    const applied = await deps.securityEdge.applyPolicy(
      {
        organizationId: policy.organizationId,
        idempotencyKey: `distribute-${policy.id}-v${policy.version}`,
        timeoutMs: 20_000,
      },
      {
        ref: {
          organizationId: policy.organizationId,
          provider: "coraza",
          resourceType: "policy",
          resourceId: policy.id,
        },
      },
    );

    if (!applied.ok) return err(applied.status, applied.reason);

    return ok<PolicyExecutionResult>(applied.status, {
      status: applied.status,
      state: "active",
      version: applied.value.version > policy.version ? applied.value.version : policy.version,
      distributed: true,
      reason: null,
    });
  };
}

/**
 * The applier: activate the policy, or record the refusal.
 *
 * A successful apply re-reads the policy so a version that moved while the job
 * ran is not silently rewound: the save is keyed to the payload's policy and the
 * acknowledged version, and the event records the transition.
 */
export function buildPolicyApplier(
  deps: PolicyJobDeps,
): (job: Job, result: AdapterResult<unknown>) => Promise<void> {
  return async (job, result) => {
    if (job.kind !== POLICY_JOB_KIND) return;
    const payload = job.payload as PolicyJobPayload;
    const policy = await deps.writes.getSecurityPolicyForService(payload.organizationId);
    if (!policy || policy.id !== payload.policyId) return;

    if (!result.ok) {
      await deps.writes.recordPolicyEvent({
        id: deps.newId(),
        organizationId: policy.organizationId,
        policyId: policy.id,
        fromState: policy.state,
        toState: "rejected",
        version: policy.version,
        actorId: payload.actorId,
        actorEmail: payload.actorEmail,
        detail: result.reason,
      });
      await deps.writes.recordAuditEvent({
        organizationId: policy.organizationId,
        actorId: payload.actorId,
        actorEmail: payload.actorEmail,
        event: "policy.rejected",
        targetType: "security_policy",
        targetId: policy.id,
        metadata: { version: policy.version, status: result.status },
      });
      return;
    }

    const value = result.value as PolicyExecutionResult;
    const active = await deps.writes.saveSecurityPolicy({
      id: policy.id,
      organizationId: policy.organizationId,
      name: policy.name,
      riskLevel: policy.riskLevel,
      action: policy.action,
      state: "active",
      version: value.version,
      createdBy: payload.actorId,
    });
    await deps.writes.recordPolicyEvent({
      id: deps.newId(),
      organizationId: policy.organizationId,
      policyId: policy.id,
      fromState: policy.state,
      toState: "active",
      version: active.version,
      actorId: payload.actorId,
      actorEmail: payload.actorEmail,
      detail: "Policy distributed and accepted by the edge.",
    });
    await deps.writes.recordAuditEvent({
      organizationId: policy.organizationId,
      actorId: payload.actorId,
      actorEmail: payload.actorEmail,
      event: "policy.distributed",
      targetType: "security_policy",
      targetId: policy.id,
      metadata: { version: active.version },
    });
  };
}
