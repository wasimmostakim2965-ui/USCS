/**
 * Observability procedures.
 *
 * This is a read over the platform's own units of work. `orchestration_jobs` is
 * the durable queue: every deployment, backup and policy distribution is a row
 * whose state, attempts and timestamps the worker and the engine write. Nothing
 * here computes a synthetic metric or samples a process — the numbers are
 * derived from rows that exist, and a state is only ever the state the queue
 * recorded.
 *
 * The honest limit, stated where the dashboard reads it: a job's *duration* is
 * only knowable when both `started_at` and `finished_at` are present, so a
 * queued or running job contributes to the state counts but not to the latency
 * figures. Reporting a running job as "0 ms" would be a lie in the same family
 * as a green badge over an unconfigured engine.
 */
import { percentiles } from "@cloud-wai/observability";
import { requireCapability } from "../guard.js";
import type { DataStore, OrchestrationJob } from "@cloud-wai/database";
import type { JobState, OrganizationId } from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";

export interface ObservabilityDeps {
  readonly store: DataStore;
}

/** How one job state is represented across the organization. */
export interface JobStateCount {
  readonly state: JobState;
  readonly count: number;
}

/**
 * Latency of finished jobs.
 *
 * Null when there is nothing finished to measure — an explicit "no figure",
 * never a zero that reads as "instant". `p50` and `p95` are nearest-rank over
 * the durations the store returned, so they can only be computed from rows that
 * actually have both timestamps.
 */
export interface JobLatency {
  readonly samples: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

/** One job kind's activity, so a noisy kind is visible rather than averaged away. */
export interface JobKindSummary {
  readonly kind: string;
  readonly total: number;
  readonly failed: number;
  readonly retried: number;
  /** Finished jobs of this kind that ended with a reason the engine gave. */
  readonly lastError: string | null;
}

export interface ObservabilityReport {
  readonly totals: {
    readonly jobs: number;
    readonly active: number;
    readonly failed: number;
    readonly retried: number;
  };
  readonly byState: readonly JobStateCount[];
  readonly byKind: readonly JobKindSummary[];
  readonly latency: JobLatency;
  /** Every job, newest first, so the dashboard lists without a second call. */
  readonly jobs: readonly OrchestrationJob[];
}

/** Nearest-rank percentile over a sorted numeric sample. */
function percentileOrNull(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return percentiles(sorted, p);
}

/**
 * The organization's job activity, rolled up and raw.
 *
 * A job is "retried" when its attempt count exceeds one — the queue increments
 * `attempts` on every claim, so this is the queue's own number, not a guess. A
 * job is "active" while it is queued or running. Durations come only from jobs
 * with both timestamps; the sample count is reported beside the percentiles so a
 * thin figure is visible as thin.
 */
export async function readObservability(
  ctx: RequestContext,
  deps: ObservabilityDeps,
  organizationId: OrganizationId,
): Promise<ObservabilityReport> {
  requireCapability(ctx, organizationId, "deployment:read");
  const jobs = await deps.store.listOrchestrationJobs(ctx.principal.userId, organizationId);

  const stateCounts = new Map<JobState, number>();
  const kindTotals = new Map<string, { total: number; failed: number; retried: number }>();
  const kindErrors = new Map<string, string | null>();
  const durations: number[] = [];
  let retried = 0;
  let failed = 0;
  let active = 0;

  for (const job of jobs) {
    stateCounts.set(job.state, (stateCounts.get(job.state) ?? 0) + 1);

    const kind = kindTotals.get(job.kind) ?? { total: 0, failed: 0, retried: 0 };
    kind.total += 1;

    if (job.attempts > 1) {
      retried += 1;
      kind.retried += 1;
    }
    if (job.state === "failed") {
      failed += 1;
      kind.failed += 1;
      // Keep the most recent failure reason: the list is newest first, so the
      // first one seen for a kind is the latest.
      if (!kindErrors.has(job.kind) && job.lastError) {
        kindErrors.set(job.kind, job.lastError);
      }
    }
    if (job.state === "queued" || job.state === "running") active += 1;

    kindTotals.set(job.kind, kind);

    if (job.startedAt && job.finishedAt) {
      const started = Date.parse(job.startedAt);
      const finished = Date.parse(job.finishedAt);
      if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
        durations.push(finished - started);
      }
    }
  }

  const sortedDurations = [...durations].sort((a, b) => a - b);

  const byState = [...stateCounts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((a, b) => a.state.localeCompare(b.state));

  const byKind = [...kindTotals.entries()]
    .map(([kind, value]) => ({
      kind,
      total: value.total,
      failed: value.failed,
      retried: value.retried,
      lastError: kindErrors.get(kind) ?? null,
    }))
    .sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind));

  return {
    totals: { jobs: jobs.length, active, failed, retried },
    byState,
    byKind,
    latency: {
      samples: sortedDurations.length,
      p50Ms: percentileOrNull(sortedDurations, 50),
      p95Ms: percentileOrNull(sortedDurations, 95),
      maxMs: sortedDurations.length > 0 ? sortedDurations[sortedDurations.length - 1]! : null,
    },
    jobs,
  };
}
