/**
 * Billing procedures.
 *
 * Billing is the organization-level surface Vercel lacks (its dashboards are
 * per-project only), so this is a roll-up over `usage_records`. It is a read,
 * and it is the only path to that table from the API: no procedure here lets a
 * client assert a metric or a quantity.
 *
 * Honest caveat: nothing in this build *writes* a usage row yet. The table, its
 * RLS policy and the service-role write grant exist and the worker runs with the
 * credentials to write one, but no engine adapter reports a metric and no job
 * records one, so in practice the roll-up is always empty. That is why an empty
 * organization renders as an empty list and not as a zero balance — and why the
 * dashboard says the list stays empty until a metric source is wired, rather
 * than promising a recording that does not happen.
 */
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import {
  USAGE_METRICS,
  type Budget,
  type ControlPlaneWrites,
  type DataStore,
  type UsageRecord,
} from "@cloud-wai/database";
import type { OrganizationId } from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";

export interface BillingDeps {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  /** Injected so a period boundary and an enforcement check agree in a test. */
  readonly now?: () => Date;
}

/** One metric's totals for an organization. */
export interface UsageTotal {
  readonly metric: string;
  readonly total: number;
  /** How many records back this total, so a thin figure is visible as thin. */
  readonly records: number;
  /** The most recent `recorded_at` for this metric, or null when there is none. */
  readonly lastRecordedAt: string | null;
}

export interface UsageReport {
  readonly totals: readonly UsageTotal[];
  /** Every raw record, newest first, so the dashboard can list without a second call. */
  readonly records: readonly UsageRecord[];
}

/**
 * The organization's usage, both rolled up and raw.
 *
 * The roll-up is computed here from the rows the store returned rather than
 * issued as a SQL aggregate, so the same answer holds for any store
 * implementation and the totals can never disagree with the records beside them.
 */
export async function readUsage(
  ctx: RequestContext,
  deps: BillingDeps,
  organizationId: OrganizationId,
): Promise<UsageReport> {
  requireCapability(ctx, organizationId, "billing:read");
  const records = await deps.store.listUsageRecords(ctx.principal.userId, organizationId);

  const totals = new Map<
    string,
    { total: number; records: number; lastRecordedAt: string | null }
  >();
  for (const record of records) {
    const current = totals.get(record.metric) ?? { total: 0, records: 0, lastRecordedAt: null };
    totals.set(record.metric, {
      total: current.total + record.quantity,
      records: current.records + 1,
      lastRecordedAt:
        current.lastRecordedAt === null || record.recordedAt > current.lastRecordedAt
          ? record.recordedAt
          : current.lastRecordedAt,
    });
  }

  const rolled = [...totals.entries()]
    .map(([metric, value]) => ({ metric, ...value }))
    .sort((a, b) => a.metric.localeCompare(b.metric));

  return { totals: rolled, records };
}

/* -------------------------------------------------------------- budgets (W9) */

/**
 * The budgets an organization has set.
 *
 * Each one carries the period's spend beside the cap, computed here from the
 * same usage rows the billing roll-up reads, so a percentage on the dashboard
 * cannot disagree with the totals above it. The sum is over `usage_records`
 * since the start of the current calendar month, service-scoped, because the cap
 * is enforced against that figure and the two must be one number.
 */
export interface BudgetStatus {
  readonly metric: string;
  readonly limitQuantity: number;
  readonly period: "monthly";
  readonly hardCap: boolean;
  /** Recorded quantity for the metric in the current period. */
  readonly usedQuantity: number;
  /** `usedQuantity / limitQuantity`; 0 when the limit is 0 to avoid a fake. */
  readonly ratio: number;
  /** True when a hard cap is at or past its limit. */
  readonly exceeded: boolean;
}

export interface BudgetReport {
  readonly budgets: readonly BudgetStatus[];
  /** The window the usage figures were summed over, so the UI can name it. */
  readonly periodStart: string;
}

/** The first instant of the current calendar month, UTC. */
export function monthlyPeriodStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** The spend of one metric in a window, summed from the recorded rows. */
export async function usageSince(
  deps: BillingDeps,
  organizationId: OrganizationId,
  metric: string,
  since: string,
): Promise<number> {
  const store = deps.store as Partial<ControlPlaneWrites>;
  if (typeof store.listUsageForService !== "function") return 0;
  const records = await store.listUsageForService(organizationId, metric, since);
  return records.reduce((sum, record) => sum + record.quantity, 0);
}

/**
 * The organization's budgets with their current-period spend.
 *
 * A read; a viewer may call it, because a cap is a fact about the organization.
 */
export async function readBudgets(
  ctx: RequestContext,
  deps: BillingDeps,
  organizationId: OrganizationId,
): Promise<BudgetReport> {
  requireCapability(ctx, organizationId, "billing:read");
  const clock = deps.now ?? (() => new Date());
  const periodStart = monthlyPeriodStart(clock());
  const list = deps.store.listBudgets;
  if (typeof list !== "function") {
    throw new ApiError("engine_unavailable", "This deployment cannot read a budget yet.");
  }
  const rows = await list(ctx.principal.userId, organizationId);

  const budgets: BudgetStatus[] = [];
  for (const budget of rows) {
    const usedQuantity = await usageSince(deps, organizationId, budget.metric, periodStart);
    budgets.push({
      metric: budget.metric,
      limitQuantity: budget.limitQuantity,
      period: budget.period,
      hardCap: budget.hardCap,
      usedQuantity,
      ratio: budget.limitQuantity > 0 ? usedQuantity / budget.limitQuantity : 0,
      exceeded: budget.hardCap && usedQuantity >= budget.limitQuantity,
    });
  }

  return { budgets: budgets.sort((a, b) => a.metric.localeCompare(b.metric)), periodStart };
}

/**
 * Refuse new work when a metric's hard cap is already reached.
 *
 * This runs on the request path *before* a job is enqueued — the point of a hard
 * cap is that the work does not start, not that it is reported after the fact.
 * Only a `hard_cap = true` budget refuses; a soft budget is informational and
 * blocks nothing, which is stated rather than implied.
 *
 * The check is deliberately a "gate, not a throttle": it refuses when usage is at
 * or over the limit, and it does not try to reserve the next unit. A cap can
 * therefore be overshot by concurrent requests, and the honest word for that is
 * "cap", not "quota".
 */
export async function assertWithinBudget(
  deps: BillingDeps,
  organizationId: OrganizationId,
  metric: string,
): Promise<void> {
  const store = deps.store as Partial<ControlPlaneWrites>;
  if (typeof store.getBudgetForService !== "function") return;
  const budget = await store.getBudgetForService(organizationId, metric);
  if (!budget || !budget.hardCap) return;

  const clock = deps.now ?? (() => new Date());
  const used = await usageSince(deps, organizationId, metric, monthlyPeriodStart(clock()));
  if (used >= budget.limitQuantity) {
    throw new ApiError(
      "budget_exceeded",
      `This organization has reached its hard cap of ${budget.limitQuantity} ${metric} for this month. Raise the cap in Billing to continue.`,
      { metric, limitQuantity: budget.limitQuantity, usedQuantity: used },
    );
  }
}

export interface SaveBudgetInput {
  readonly organizationId: OrganizationId;
  readonly metric: string;
  readonly limitQuantity: number;
  readonly hardCap: boolean;
}

/**
 * Set or replace one metric's cap.
 *
 * The metric must be one the platform actually records: a cap on a metric
 * nothing writes would be a number that can never move, and calling that a
 * "budget" would be a lie. `billing:manage` is an owner-only capability, so the
 * owner is the role that sets a cap; the RLS policy is the second enforcement of
 * that same rule, not the only one.
 */
export async function saveBudget(
  ctx: RequestContext,
  deps: BillingDeps,
  input: SaveBudgetInput,
): Promise<Budget> {
  requireCapability(ctx, input.organizationId, "billing:manage");

  const store = deps.store as Partial<ControlPlaneWrites>;
  if (typeof store.saveBudget !== "function") {
    throw new ApiError("engine_unavailable", "This deployment cannot record a budget yet.");
  }

  const metric = input.metric.trim();
  if (!(USAGE_METRICS as readonly string[]).includes(metric)) {
    throw new ApiError(
      "invalid_input",
      `Unknown metric '${metric}'. Recorded metrics: ${USAGE_METRICS.join(", ")}.`,
    );
  }
  if (!Number.isFinite(input.limitQuantity) || input.limitQuantity < 0) {
    throw new ApiError("invalid_input", "The limit must be a non-negative number.");
  }

  const saved = await store.saveBudget({
    organizationId: input.organizationId,
    metric,
    limitQuantity: input.limitQuantity,
    hardCap: input.hardCap,
    updatedBy: ctx.principal.userId,
  });

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "billing.budget_saved",
    targetType: "budget",
    targetId: metric,
    metadata: { metric, limitQuantity: input.limitQuantity, hardCap: input.hardCap },
  });

  return saved;
}

/** Remove a metric's cap. Owner-only; doing so stops the hard-cap refusal. */
export async function removeBudget(
  ctx: RequestContext,
  deps: BillingDeps,
  input: { readonly organizationId: OrganizationId; readonly metric: string },
): Promise<{ readonly removed: boolean }> {
  requireCapability(ctx, input.organizationId, "billing:manage");

  const store = deps.store as Partial<ControlPlaneWrites>;
  if (typeof store.deleteBudget !== "function") {
    throw new ApiError("engine_unavailable", "This deployment cannot record a budget yet.");
  }

  const removed = await store.deleteBudget(
    ctx.principal.userId,
    input.organizationId,
    input.metric,
  );
  if (removed) {
    await deps.store.recordAuditEvent({
      organizationId: input.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "billing.budget_removed",
      targetType: "budget",
      targetId: input.metric,
      metadata: { metric: input.metric },
    });
  }
  return { removed };
}
