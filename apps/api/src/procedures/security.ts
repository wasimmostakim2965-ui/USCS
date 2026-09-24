/**
 * Security policy procedures: read, save and distribute an edge policy.
 *
 * ADR-0006 phase 3 requires policy to run end to end against the adapters. This
 * module is that write path, and it follows the deployment and domain paths:
 * the policy row is written before the edge is called, and the state the caller
 * sees is the edge's answer, never the request.
 *
 * The rules it keeps, restated at the API boundary so a caller cannot route
 * around them:
 *
 *   * A policy's `state` is the edge's observation, never the customer's. A save
 *     request may change the name, risk level and action, and always writes
 *     `draft`; the state becomes `active` only after the edge accepted a
 *     distribution.
 *   * Policy never rolls backwards. A distribution whose version is below the
 *     active one is refused before the edge is called.
 *   * A refused distribution records a `rejected` transition and leaves the
 *     policy honestly non-active.
 *
 * `apps/security-control` owns the incident lifecycle and the compiled-rule
 * distribution used off the request path; this module is the request-path half
 * the dashboard calls. Both use the same `@cloud-wai/security` rules, and this
 * module deliberately does not import that app — apps do not depend on apps.
 */
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import type { Engines, JobQueue } from "@cloud-wai/adapters";
import type {
  ControlPlaneWrites,
  DataStore,
  SecurityPolicy,
  SecurityPolicyEvent,
} from "@cloud-wai/database";
import type { SecurityPolicyId, OrganizationId, ProviderRef } from "@cloud-wai/contracts";
import { POLICY_JOB_KIND, type PolicyJobPayload } from "@cloud-wai/contracts";
import {
  ENFORCEMENT_ACTIONS,
  RISK_LEVELS,
  mayDistribute,
  validatePolicy,
  type EnforcementAction,
  type PolicyVersion,
  type RiskLevel,
} from "@cloud-wai/security";
import type { RequestContext } from "../context.js";

type SecurityWrites = Pick<
  ControlPlaneWrites,
  "getSecurityPolicy" | "saveSecurityPolicy" | "recordPolicyEvent" | "listPolicyEvents"
>;

const REQUIRED_WRITES = [
  "getSecurityPolicy",
  "saveSecurityPolicy",
  "recordPolicyEvent",
  "listPolicyEvents",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

export interface SecurityDeps {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  readonly engines: Engines;
  readonly newId: () => string;
  readonly now?: () => Date;
  /**
   * When wired, a distribution becomes a durable job the worker executes instead
   * of a call to the edge on the request path. Omitted in tests that pin the
   * synchronous behaviour.
   */
  readonly queue?: JobQueue;
}

const ADAPTER_TIMEOUT_MS = 20_000;

function writesFor(deps: SecurityDeps): SecurityWrites {
  const store = deps.store;
  const missing = REQUIRED_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as SecurityWrites;
}

/** The current policy and its transition history, membership-scoped. */
export async function readSecurityPolicy(
  ctx: RequestContext,
  deps: SecurityDeps,
  organizationId: OrganizationId,
): Promise<{ policy: SecurityPolicy | null; events: readonly SecurityPolicyEvent[] }> {
  requireCapability(ctx, organizationId, "security:read");
  const writes = writesFor(deps);
  const policy = await writes.getSecurityPolicy(ctx.principal.userId, organizationId);
  const events = await writes.listPolicyEvents(ctx.principal.userId, organizationId);
  return { policy, events };
}

export interface SavePolicyInput {
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly riskLevel: RiskLevel;
  readonly action: EnforcementAction;
}

/**
 * Save a policy as a draft.
 *
 * Only the customer's own fields are accepted: name, risk level and action. The
 * state is written `draft` — a save never activates a policy, and distribution
 * is what moves it. The version advances monotonically from the stored one, so a
 * save cannot rewind a policy the edge is already enforcing.
 */
export async function saveSecurityPolicy(
  ctx: RequestContext,
  deps: SecurityDeps,
  input: SavePolicyInput,
): Promise<SecurityPolicy> {
  requireCapability(ctx, input.organizationId, "security:update");

  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    throw new ApiError("invalid_input", "A policy name must be 1-120 characters.");
  }
  if (!RISK_LEVELS.includes(input.riskLevel)) {
    throw new ApiError("invalid_input", "Unknown risk level.");
  }
  if (!ENFORCEMENT_ACTIONS.includes(input.action)) {
    throw new ApiError("invalid_input", "Unknown enforcement action.");
  }

  const writes = writesFor(deps);
  const existing = await writes.getSecurityPolicy(ctx.principal.userId, input.organizationId);

  const now = (deps.now?.() ?? new Date()).toISOString();
  const draft: SecurityPolicy = {
    id: (existing?.id ?? deps.newId()) as SecurityPolicyId,
    organizationId: input.organizationId,
    name,
    riskLevel: input.riskLevel,
    action: input.action,
    // A customer save never activates; the state is the edge's to report.
    state: "draft",
    // Monotonic: editing a policy produces a newer version the edge will accept.
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const valid = validatePolicy(draft);
  if (!valid.ok) throw new ApiError("invalid_input", valid.reason);

  const saved = await writes.saveSecurityPolicy({
    id: draft.id,
    organizationId: draft.organizationId,
    name: draft.name,
    riskLevel: draft.riskLevel,
    action: draft.action,
    state: "draft",
    version: draft.version,
    createdBy: ctx.principal.userId,
  });

  await writes.recordPolicyEvent({
    id: deps.newId(),
    organizationId: input.organizationId,
    policyId: saved.id,
    fromState: existing?.state ?? null,
    toState: "draft",
    version: saved.version,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    detail: "Policy saved as a draft.",
  });

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "policy.saved",
    targetType: "security_policy",
    targetId: saved.id,
    metadata: { version: saved.version, riskLevel: saved.riskLevel, action: saved.action },
  });

  return saved;
}

export interface DistributePolicyInput {
  readonly organizationId: OrganizationId;
}

export interface DistributePolicyResult {
  readonly policy: SecurityPolicy;
  readonly distributed: boolean;
  /** The edge's own words when it did not apply the policy. */
  readonly engineReason: string | null;
}

/**
 * Distribute the stored policy to the edge.
 *
 * The version is checked against the stored one before the edge is called, so a
 * stale candidate is refused without a network round-trip. On success the policy
 * is recorded `active` at the version the edge echoed; on any refusal it stays
 * where it was and the reason is returned, never a fabricated success.
 */
export async function distributeSecurityPolicy(
  ctx: RequestContext,
  deps: SecurityDeps,
  input: DistributePolicyInput,
): Promise<DistributePolicyResult> {
  requireCapability(ctx, input.organizationId, "security:update");

  const writes = writesFor(deps);
  const policy = await writes.getSecurityPolicy(ctx.principal.userId, input.organizationId);
  if (!policy) throw new ApiError("not_found", "No security policy has been saved yet.");

  const valid = validatePolicy(policy);
  if (!valid.ok) throw new ApiError("invalid_input", valid.reason);

  // The active version is the policy's own stored version: a distribution may
  // re-send it (idempotent) but never a lower one. The edge rejects a stale
  // version too; refusing here keeps the refusal before the network call.
  const active: PolicyVersion | null =
    policy.state === "active" ? { policyId: policy.id, version: policy.version } : null;
  const candidate: PolicyVersion = { policyId: policy.id, version: policy.version };
  const allow = mayDistribute(candidate, active);
  if (!allow.ok) {
    throw new ApiError("conflict", allow.reason);
  }

  const ref: ProviderRef = {
    organizationId: policy.organizationId,
    provider: "coraza",
    resourceType: "policy",
    resourceId: policy.id,
  };

  // Durable path: record the distribution as a job and let the worker call the
  // edge. The policy keeps its state — activation is the edge's answer, which
  // the worker writes after the edge has replied. Nothing is fabricated here.
  if (deps.queue) {
    const payload: PolicyJobPayload = {
      organizationId: policy.organizationId,
      policyId: policy.id,
      version: policy.version,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
    };
    await deps.queue.enqueue({
      organizationId: policy.organizationId,
      kind: POLICY_JOB_KIND,
      payload,
      idempotencyKey: `distribute-${policy.id}-v${policy.version}`,
    });
    await deps.store.recordAuditEvent({
      organizationId: policy.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "policy.distribution_enqueued",
      targetType: "security_policy",
      targetId: policy.id,
      metadata: { version: policy.version },
    });
    return { policy, distributed: false, engineReason: null };
  }

  const applied = await deps.engines.securityEdge.applyPolicy(
    {
      organizationId: policy.organizationId,
      idempotencyKey: `distribute-${policy.id}-v${policy.version}`,
      timeoutMs: ADAPTER_TIMEOUT_MS,
    },
    { ref },
  );

  if (!applied.ok) {
    // Nothing becomes active on a refusal. The policy keeps its state and the
    // caller learns why the edge did not take it.
    await writes.recordPolicyEvent({
      id: deps.newId(),
      organizationId: policy.organizationId,
      policyId: policy.id,
      fromState: policy.state,
      toState: "rejected",
      version: policy.version,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      detail: applied.reason,
    });

    await deps.store.recordAuditEvent({
      organizationId: policy.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "policy.rejected",
      targetType: "security_policy",
      targetId: policy.id,
      metadata: { version: policy.version, status: applied.status },
    });

    return {
      policy,
      distributed: false,
      engineReason: applied.reason,
    };
  }

  // The engine's echoed version is authoritative, but never below what we sent:
  // a lower number would mean the edge quietly rolled back.
  const acknowledged =
    applied.value.version > policy.version ? applied.value.version : policy.version;

  const activePolicy = await writes.saveSecurityPolicy({
    id: policy.id,
    organizationId: policy.organizationId,
    name: policy.name,
    riskLevel: policy.riskLevel,
    action: policy.action,
    state: "active",
    version: acknowledged,
    createdBy: ctx.principal.userId,
  });

  await writes.recordPolicyEvent({
    id: deps.newId(),
    organizationId: policy.organizationId,
    policyId: policy.id,
    fromState: policy.state,
    toState: "active",
    version: activePolicy.version,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    detail: "Policy distributed and accepted by the edge.",
  });

  await deps.store.recordAuditEvent({
    organizationId: policy.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "policy.distributed",
    targetType: "security_policy",
    targetId: policy.id,
    metadata: { version: activePolicy.version },
  });

  return { policy: activePolicy, distributed: true, engineReason: null };
}
