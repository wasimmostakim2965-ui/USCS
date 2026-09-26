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
import {
  VERIFIED_BOTS,
  validateDenyRule,
  validateRateLimitRule,
  validateTrustedSource,
  type Engines,
  type JobQueue,
} from "@cloud-wai/adapters";
import type {
  ControlPlaneWrites,
  DataStore,
  RateLimit,
  SecurityEvent,
  SecurityIncident,
  SecurityPolicy,
  SecurityPolicyEvent,
  SecurityRule,
  TrustedSource,
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

type SecurityRuleWrites = Pick<
  ControlPlaneWrites,
  "listSecurityRules" | "createSecurityRule" | "deleteSecurityRule"
>;

type SecurityEventReads = Pick<ControlPlaneWrites, "listSecurityEvents">;

type SecurityIncidentWrites = Pick<
  ControlPlaneWrites,
  "listSecurityIncidents" | "transitionSecurityIncident"
>;

type TrustedSourceWrites = Pick<
  ControlPlaneWrites,
  "listTrustedSources" | "createTrustedSource" | "deleteTrustedSource"
>;

type RateLimitWrites = Pick<
  ControlPlaneWrites,
  "listRateLimits" | "createRateLimit" | "deleteRateLimit"
>;

const REQUIRED_WRITES = [
  "getSecurityPolicy",
  "saveSecurityPolicy",
  "recordPolicyEvent",
  "listPolicyEvents",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

const REQUIRED_RULE_WRITES = [
  "listSecurityRules",
  "createSecurityRule",
  "deleteSecurityRule",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

const REQUIRED_TRUSTED_WRITES = [
  "listTrustedSources",
  "createTrustedSource",
  "deleteTrustedSource",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

const REQUIRED_RATE_LIMIT_WRITES = [
  "listRateLimits",
  "createRateLimit",
  "deleteRateLimit",
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

/**
 * The rule writes, checked separately from the policy writes.
 *
 * A deployment that supports policies but predates the deny list is still a
 * working deployment for everything else; only the rule procedures report the
 * honest `engine_unavailable`, and only when they are called.
 */
function ruleWritesFor(deps: SecurityDeps): SecurityRuleWrites {
  const store = deps.store;
  const missing = REQUIRED_RULE_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as SecurityRuleWrites;
}

/** The trusted-source writes, checked the same way and separately. */
function trustedWritesFor(deps: SecurityDeps): TrustedSourceWrites {
  const store = deps.store;
  const missing = REQUIRED_TRUSTED_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as TrustedSourceWrites;
}

/** The rate-limit writes, checked the same way and separately. */
function rateLimitWritesFor(deps: SecurityDeps): RateLimitWrites {
  const store = deps.store;
  const missing = REQUIRED_RATE_LIMIT_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as RateLimitWrites;
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
  /**
   * `normal` inspects; `attack` challenges browsers. Omitted means the stored
   * mode is kept, so an ordinary save never silently drops a live posture.
   */
  readonly protectionMode?: "normal" | "attack";
  /**
   * How long attack mode lasts. Omitted with `protectionMode: "attack"` means it
   * does not expire. A past timestamp is treated as `normal`.
   */
  readonly protectionExpiresAt?: string | null;
}

/** The accepted protection window, mirroring the edge's own duration choices. */
const MAX_PROTECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Save a policy as a draft.
 *
 * Only the customer's own fields are accepted: name, risk level, action, and the
 * protection posture. The state is written `draft` — a save never activates a
 * policy, and distribution is what moves it. The version advances monotonically
 * from the stored one, so a save cannot rewind a policy the edge is already
 * enforcing.
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

  // The posture: keep the stored one unless the caller changed it, so a routine
  // save does not drop a live attack mode. An *explicit* window is capped at 24h,
  // the longest the edge accepts, so a customer cannot park a challenge on their
  // own visitors by choosing an absurd expiry. Omitting the window while asking
  // for `attack` deliberately means "until switched back" — that is the posture
  // the dashboard offers ("leave empty to keep it on until you switch back") and
  // the type documents, so it is not an accident and is not capped.
  const protectionMode = input.protectionMode ?? existing?.protectionMode ?? "normal";
  let protectionExpiresAt: string | null =
    input.protectionExpiresAt !== undefined
      ? input.protectionExpiresAt
      : (existing?.protectionExpiresAt ?? null);
  if (protectionMode === "normal") {
    protectionExpiresAt = null;
  } else if (protectionExpiresAt !== null) {
    const expiresAt = new Date(protectionExpiresAt).getTime();
    if (Number.isNaN(expiresAt)) {
      throw new ApiError("invalid_input", "The protection window is not a valid timestamp.");
    }
    if (expiresAt - Date.parse(now) > MAX_PROTECTION_WINDOW_MS) {
      throw new ApiError("invalid_input", "Attack mode lasts at most 24 hours.");
    }
  }

  const draft: SecurityPolicy = {
    id: (existing?.id ?? deps.newId()) as SecurityPolicyId,
    organizationId: input.organizationId,
    name,
    riskLevel: input.riskLevel,
    action: input.action,
    // A customer save never activates; the state is the edge's to report.
    state: "draft",
    protectionMode,
    protectionExpiresAt,
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
    protectionMode: draft.protectionMode,
    protectionExpiresAt: draft.protectionExpiresAt,
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
    detail: `Policy saved as a draft (${protectionMode} protection).`,
  });

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "policy.saved",
    targetType: "security_policy",
    targetId: saved.id,
    metadata: {
      version: saved.version,
      riskLevel: saved.riskLevel,
      action: saved.action,
      protectionMode: saved.protectionMode,
    },
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

    // A refused distribution is a security event, not a rounding error. Group it
    // as an incident so it is triaged rather than buried in the policy log. The
    // store method is optional: a deployment that predates the incident table
    // still records the rejection as a policy event above.
    const incidents = deps.store as Partial<ControlPlaneWrites>;
    if (typeof incidents.openSecurityIncidentForService === "function") {
      await incidents.openSecurityIncidentForService({
        id: deps.newId(),
        organizationId: policy.organizationId,
        kind: "policy_distribution_rejected",
        severity: applied.status === "not_configured" ? "medium" : "high",
        summary: `Policy v${policy.version} was not applied: ${applied.reason}`,
        openedAt: (deps.now ?? (() => new Date()))().toISOString(),
      });
    }

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
    protectionMode: policy.protectionMode,
    protectionExpiresAt: policy.protectionExpiresAt,
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
// ---------------------------------------------------------------------------
// The deny list
//
// A rule is a customer's own input, so it is validated here against the same
// grammar the compiler uses. A value that does not match is refused, never
// escaped into a directive: the whole point of the deny list is to stop hostile
// traffic, and a value that reached Coraza by concatenation would be the way to
// let it in instead.
// ---------------------------------------------------------------------------

/** The deny-rule kinds, validated at the boundary and again at compile time. */
const RULE_KINDS = ["ip", "cidr", "asn", "user-agent"] as const;
type RuleKind = (typeof RULE_KINDS)[number];

export async function listSecurityRules(
  ctx: RequestContext,
  deps: SecurityDeps,
  organizationId: OrganizationId,
): Promise<readonly SecurityRule[]> {
  requireCapability(ctx, organizationId, "security:read");
  return ruleWritesFor(deps).listSecurityRules(ctx.principal.userId, organizationId);
}

export interface AddSecurityRuleInput {
  readonly organizationId: OrganizationId;
  readonly kind: RuleKind;
  readonly value: string;
  readonly note?: string | null;
}

export async function addSecurityRule(
  ctx: RequestContext,
  deps: SecurityDeps,
  input: AddSecurityRuleInput,
): Promise<SecurityRule> {
  requireCapability(ctx, input.organizationId, "security:update");

  if (!RULE_KINDS.includes(input.kind)) {
    throw new ApiError("invalid_input", "Unknown rule kind.");
  }
  const value = (input.value ?? "").trim();
  // One validator, shared with the compiler, so an API-accepted value is always
  // a value the compiler will emit.
  const valid = validateDenyRule({ kind: input.kind, value });
  if (!valid.ok) throw new ApiError("invalid_input", valid.reason);

  const note = input.note?.trim() ?? "";
  if (note.length > 200) throw new ApiError("invalid_input", "A note is at most 200 characters.");

  const writes = ruleWritesFor(deps);
  const created = await writes.createSecurityRule({
    id: deps.newId(),
    organizationId: input.organizationId,
    kind: input.kind,
    value,
    note: note === "" ? null : note,
    createdBy: ctx.principal.userId,
  });

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "security_rule.added",
    targetType: "security_rule",
    targetId: created.id,
    metadata: { kind: created.kind, value: created.value },
  });

  return created;
}

export interface RemoveSecurityRuleInput {
  readonly organizationId: OrganizationId;
  readonly ruleId: string;
}

export async function removeSecurityRule(
  ctx: RequestContext,
  deps: SecurityDeps,
  input: RemoveSecurityRuleInput,
): Promise<{ removed: boolean }> {
  requireCapability(ctx, input.organizationId, "security:update");
  const removed = await ruleWritesFor(deps).deleteSecurityRule(
    ctx.principal.userId,
    input.organizationId,
    input.ruleId,
  );

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "security_rule.removed",
    targetType: "security_rule",
    targetId: input.ruleId,
    metadata: { removed },
  });

  return { removed };
}

// ---------------------------------------------------------------------------
// Trusted sources — the allow half, so attack mode never locks out a webhook
// ---------------------------------------------------------------------------

/** The trusted-source kinds. Address literals only; a name would be forgeable. */
const TRUSTED_KINDS = ["ip", "cidr"] as const;
type TrustedKind = (typeof TRUSTED_KINDS)[number];

export async function listTrustedSources(
  ctx: RequestContext,
  deps: SecurityDeps,
  organizationId: OrganizationId,
): Promise<readonly TrustedSource[]> {
  requireCapability(ctx, organizationId, "security:read");
  return trustedWritesFor(deps).listTrustedSources(ctx.principal.userId, organizationId);
}

export interface AddTrustedSourceInput {
  readonly organizationId: OrganizationId;
  readonly kind: TrustedKind;
  readonly value: string;
  readonly note?: string | null;
}

export async function addTrustedSource(
  ctx: RequestContext,
  deps: SecurityDeps,
  input: AddTrustedSourceInput,
): Promise<TrustedSource> {
  requireCapability(ctx, input.organizationId, "security:update");

  if (!TRUSTED_KINDS.includes(input.kind)) {
    throw new ApiError("invalid_input", "Unknown trusted-source kind.");
  }
  const value = (input.value ?? "").trim();
  // The same validator the compiler runs, so an API-accepted address is always
  // an address the compiler will emit — and never directive syntax.
  const valid = validateTrustedSource({ kind: input.kind, value });
  if (!valid.ok) throw new ApiError("invalid_input", valid.reason);

  const note = input.note?.trim() ?? "";
  if (note.length > 200) throw new ApiError("invalid_input", "A note is at most 200 characters.");

  const writes = trustedWritesFor(deps);
  const created = await writes.createTrustedSource({
    id: deps.newId(),
    organizationId: input.organizationId,
    kind: input.kind,
    value,
    note: note === "" ? null : note,
    createdBy: ctx.principal.userId,
  });

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "security_trusted_source.added",
    targetType: "security_trusted_source",
    targetId: created.id,
    metadata: { kind: created.kind, value: created.value },
  });

  return created;
}

export interface RemoveTrustedSourceInput {
  readonly organizationId: OrganizationId;
  readonly sourceId: string;
}

export async function removeTrustedSource(
  ctx: RequestContext,
  deps: SecurityDeps,
  input: RemoveTrustedSourceInput,
): Promise<{ removed: boolean }> {
  requireCapability(ctx, input.organizationId, "security:update");
  const removed = await trustedWritesFor(deps).deleteTrustedSource(
    ctx.principal.userId,
    input.organizationId,
    input.sourceId,
  );

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "security_trusted_source.removed",
    targetType: "security_trusted_source",
    targetId: input.sourceId,
    metadata: { removed },
  });

  return { removed };
}

// ---------------------------------------------------------------------------
// Rate limits — throttling the disproportionate, not the hostile
// ---------------------------------------------------------------------------

/** The rate-limit keys. `header` requires a header name; the others forbid one. */
const RATE_LIMIT_KEY_KINDS = ["ip", "header", "global"] as const;
type RateLimitKeyKind = (typeof RATE_LIMIT_KEY_KINDS)[number];

export async function listRateLimits(
  ctx: RequestContext,
  deps: SecurityDeps,
  organizationId: OrganizationId,
): Promise<readonly RateLimit[]> {
  requireCapability(ctx, organizationId, "security:read");
  return rateLimitWritesFor(deps).listRateLimits(ctx.principal.userId, organizationId);
}

export interface AddRateLimitInput {
  readonly organizationId: OrganizationId;
  readonly key: RateLimitKeyKind;
  readonly headerName?: string | null;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly note?: string | null;
}

export async function addRateLimit(
  ctx: RequestContext,
  deps: SecurityDeps,
  input: AddRateLimitInput,
): Promise<RateLimit> {
  requireCapability(ctx, input.organizationId, "security:update");

  if (!RATE_LIMIT_KEY_KINDS.includes(input.key)) {
    throw new ApiError("invalid_input", "Unknown rate-limit key.");
  }
  // A header name on a non-header key is a half-specified rule, not something to
  // silently drop: the caller meant something and must be told it is refused.
  if (input.key !== "header" && input.headerName != null && input.headerName !== "") {
    throw new ApiError("invalid_input", "Only a header-keyed limit may name a header.");
  }
  const headerName = input.key === "header" ? (input.headerName ?? "").trim() : undefined;
  // The same validator the compiler runs, so an API-accepted rule is always a
  // rule the compiler will emit — and never directive syntax.
  const valid = validateRateLimitRule({
    id: "pending",
    key: input.key,
    ...(headerName !== undefined ? { headerName } : {}),
    limit: input.limit,
    windowSeconds: input.windowSeconds,
  });
  if (!valid.ok) throw new ApiError("invalid_input", valid.reason);

  const note = input.note?.trim() ?? "";
  if (note.length > 200) throw new ApiError("invalid_input", "A note is at most 200 characters.");

  // One limit per key (and, for a header-keyed limit, per header). The table's
  // unique constraint enforces this, but a duplicate would otherwise surface as
  // an opaque engine error: the caller is told which existing limit it clashes
  // with, the same way a duplicate hostname or git link is reported.
  const normalizedHeader = headerName && headerName !== "" ? headerName : null;
  const writes = rateLimitWritesFor(deps);
  const clash = (await writes.listRateLimits(ctx.principal.userId, input.organizationId)).find(
    (limit) => limit.key === input.key && (limit.headerName ?? null) === normalizedHeader,
  );
  if (clash) {
    throw new ApiError(
      "conflict",
      normalizedHeader
        ? `A limit for the ${normalizedHeader} header already exists.`
        : `A ${input.key}-keyed limit already exists.`,
    );
  }

  const created = await writes.createRateLimit({
    id: deps.newId(),
    organizationId: input.organizationId,
    key: input.key,
    headerName: normalizedHeader,
    limit: input.limit,
    windowSeconds: input.windowSeconds,
    note: note === "" ? null : note,
    createdBy: ctx.principal.userId,
  });

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "security_rate_limit.added",
    targetType: "security_rate_limit",
    targetId: created.id,
    metadata: {
      key: created.key,
      limit: created.limit,
      windowSeconds: created.windowSeconds,
    },
  });

  return created;
}

export interface RemoveRateLimitInput {
  readonly organizationId: OrganizationId;
  readonly rateLimitId: string;
}

export async function removeRateLimit(
  ctx: RequestContext,
  deps: SecurityDeps,
  input: RemoveRateLimitInput,
): Promise<{ removed: boolean }> {
  requireCapability(ctx, input.organizationId, "security:update");
  const removed = await rateLimitWritesFor(deps).deleteRateLimit(
    ctx.principal.userId,
    input.organizationId,
    input.rateLimitId,
  );

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "security_rate_limit.removed",
    targetType: "security_rate_limit",
    targetId: input.rateLimitId,
    metadata: { removed },
  });

  return { removed };
}

/** The edge's recent decisions for this organization, newest first. */
export async function listSecurityEvents(
  ctx: RequestContext,
  deps: SecurityDeps,
  organizationId: OrganizationId,
  limit?: number,
): Promise<{ events: readonly SecurityEvent[] }> {
  requireCapability(ctx, organizationId, "security:read");

  const store = deps.store;
  if (typeof store.listSecurityEvents !== "function") {
    throw new ApiError("engine_unavailable", "This deployment cannot read edge decisions yet.");
  }
  const reads = store as unknown as SecurityEventReads;
  const events = await reads.listSecurityEvents(ctx.principal.userId, organizationId, limit);
  return { events };
}

/**
 * The verified-bot directory the edge will compile.
 *
 * Exposed so the dashboard can show which crawlers keep working when attack mode
 * is on — the answer to "will I lose SEO if I press this". It is static, so it
 * is a pure read with no capability beyond membership.
 */
export async function readVerifiedBots(
  ctx: RequestContext,
  deps: SecurityDeps,
  organizationId: OrganizationId,
): Promise<{ bots: readonly { name: string; userAgent: string; confirmSuffix: string }[] }> {
  requireCapability(ctx, organizationId, "security:read");
  void deps;
  return { bots: VERIFIED_BOTS };
}

// ---------------------------------------------------------------------------
// Incidents — the grouped signal above the raw decisions
//
// The decisions view answers "what did the edge do with this request". This view
// answers the operator's next question: "is anything wrong, and is it being
// handled". An incident is opened by a detector (the worker, off the request
// path) and moved through its lifecycle here, by an admin, with a resolution.
// ---------------------------------------------------------------------------

const INCIDENT_STATES = ["open", "triaged", "resolved", "false_positive"] as const;
type IncidentStateInput = (typeof INCIDENT_STATES)[number];

/** The states a caller may move an incident *into*. `open` is the start, not a transition. */
const TRANSITION_STATES = ["triaged", "resolved", "false_positive"] as const;
type TransitionState = (typeof TRANSITION_STATES)[number];

/** An incident's current state, as the API's own type so the guard can narrow it. */
interface IncidentRow {
  readonly id: string;
  readonly state: IncidentStateInput;
  readonly resolution: string | null;
}

/**
 * The incident writes, checked separately like the rule writes: a deployment
 * that predates the incident table is still a working deployment for everything
 * else, and only these procedures report the honest `engine_unavailable`.
 */
function incidentWritesFor(deps: SecurityDeps): SecurityIncidentWrites {
  const store = deps.store;
  const required = ["listSecurityIncidents", "transitionSecurityIncident"] as const;
  const missing = required.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot read security incidents yet.`,
    );
  }
  return store as unknown as SecurityIncidentWrites;
}

/** The organization's incidents, newest first. */
export async function listSecurityIncidents(
  ctx: RequestContext,
  deps: SecurityDeps,
  organizationId: OrganizationId,
): Promise<{ incidents: readonly SecurityIncident[] }> {
  requireCapability(ctx, organizationId, "security:read");
  const incidents = await incidentWritesFor(deps).listSecurityIncidents(
    ctx.principal.userId,
    organizationId,
  );
  return { incidents };
}

export interface TransitionIncidentInput {
  readonly organizationId: OrganizationId;
  readonly incidentId: string;
  readonly state: TransitionState;
  /** Required to close, refused if blank. Ignored for `triaged`. */
  readonly resolution?: string | null;
}

/**
 * Move an incident through its lifecycle.
 *
 * The API enforces the same rules the table's trigger does, so a caller gets a
 * clear `invalid_input` rather than a raw database error: an incident must be
 * triaged before it is resolved, and a close must carry a resolution. The trigger
 * remains the backstop for a path that bypasses this procedure.
 */
export async function transitionSecurityIncident(
  ctx: RequestContext,
  deps: SecurityDeps,
  input: TransitionIncidentInput,
): Promise<SecurityIncident> {
  requireCapability(ctx, input.organizationId, "security:update");

  if (!TRANSITION_STATES.includes(input.state)) {
    throw new ApiError("invalid_input", "Unknown incident state.");
  }

  const closing = input.state === "resolved" || input.state === "false_positive";
  const resolution = (input.resolution ?? "").trim();
  if (closing && resolution.length === 0) {
    // An incident that disappears without a resolution is worse than one left
    // open: the next reader cannot tell whether it was fixed or forgotten.
    throw new ApiError("invalid_input", "Closing an incident requires a resolution.");
  }
  if (resolution.length > 500) {
    throw new ApiError("invalid_input", "A resolution is at most 500 characters.");
  }

  const writes = incidentWritesFor(deps);
  const current = await findIncident(deps, ctx, input.organizationId, input.incidentId);
  if (!current) throw new ApiError("not_found", "No such incident in this organization.");

  if (current.state === "resolved" || current.state === "false_positive") {
    throw new ApiError("conflict", "A closed incident cannot be reopened; open a new one.");
  }
  if (current.state === "open" && closing) {
    throw new ApiError("conflict", "An incident must be triaged before it is closed.");
  }

  const updated = await writes.transitionSecurityIncident({
    organizationId: input.organizationId,
    incidentId: input.incidentId,
    state: input.state,
    resolution: closing ? resolution : null,
    triagedBy: ctx.principal.userId,
  });
  if (!updated) throw new ApiError("not_found", "No such incident in this organization.");

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: `security_incident.${input.state}`,
    targetType: "security_incident",
    targetId: updated.id,
    metadata: { from: current.state, to: updated.state, severity: updated.severity },
  });

  return updated;
}

/** Read one incident from the list, so a transition is decided against live state. */
async function findIncident(
  deps: SecurityDeps,
  ctx: RequestContext,
  organizationId: OrganizationId,
  incidentId: string,
): Promise<IncidentRow | null> {
  const incidents = await incidentWritesFor(deps).listSecurityIncidents(
    ctx.principal.userId,
    organizationId,
  );
  const found = incidents.find((incident) => incident.id === incidentId);
  return found ? { id: found.id, state: found.state, resolution: found.resolution } : null;
}
