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
import type { DataStore, UsageRecord } from "@cloud-wai/database";
import type { OrganizationId } from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";

export interface BillingDeps {
  readonly store: DataStore;
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
