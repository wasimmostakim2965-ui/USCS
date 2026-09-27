/**
 * Job processing.
 *
 * The worker is the only component that mutates engine-facing state. It reads a
 * claimed job, dispatches it through an adapter, and records what the adapter
 * actually reported. Three rules it never breaks:
 *
 *   1. never talks to an engine except through an adapter;
 *   2. never writes `succeeded` unless the adapter's own status was success;
 *   3. always terminates a claim — complete, fail, or leave it for `reapExpired`.
 */
import { err } from "@cloud-wai/contracts";
import type {
  AdapterResult,
  EngineStatus,
  JobState,
  OrchestrationJobId,
} from "@cloud-wai/contracts";
import type { JobQueue, Job } from "@cloud-wai/adapters";
import type { Logger } from "@cloud-wai/observability";

export interface JobOutcome {
  readonly jobId: OrchestrationJobId;
  readonly kind: string;
  readonly status: EngineStatus;
  readonly applied: boolean;
  readonly reason: string | null;
}

export interface JobContext {
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

/** A handler performs one kind of work and reports honestly. */
export type JobHandler<TPayload = unknown> = (
  payload: TPayload,
  ctx: JobContext,
) => Promise<AdapterResult<unknown>>;

/**
 * How long a job for an in-flight engine build waits before it is polled again.
 *
 * The engine accepted the work and is carrying it out; polling faster would only
 * burn the engine's API. This is the interval `defer` records as the job's next
 * due time. A build the engine never settles is still bounded by the worker's
 * stranded-deployment sweep, whose hard ceiling is an hour.
 */
export const DEFAULT_POLL_BACKOFF_MS = 10_000;

/**
 * How long a job may keep polling an engine build that never settles.
 *
 * Deferral spends no attempt, so without a wall-clock ceiling a job whose engine
 * answers `running` forever would poll forever. This matches the stranded-sweep
 * hard ceiling (`DEFAULT_HARD_CEILING_MS`): past an hour, "still building" is
 * not progress, and the job is failed with a reason that says so.
 */
export const DEFAULT_POLL_CEILING_MS = 60 * 60_000;

export interface WorkerOptions {
  readonly queue: JobQueue;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly logger: Logger;
  readonly workerId: string;
  /** How long a claim is valid before another worker may reap it. */
  readonly leaseMs?: number;
  readonly defaultTimeoutMs?: number;
  /**
   * How long a job for an in-flight engine build waits before it is polled
   * again. See `DEFAULT_POLL_BACKOFF_MS`.
   */
  readonly pollBackoffMs?: number;
  /** Wall-clock ceiling on in-flight polling. See `DEFAULT_POLL_CEILING_MS`. */
  readonly pollCeilingMs?: number;
  /**
   * Write the job's outcome onto the row the command acted on.
   *
   * The queue records that a job finished; the *deployment* a customer is
   * looking at is a different row, and only this applier may change it. It
   * receives the adapter's own result, so the customer-facing status is exactly
   * what the engine reported — never a state derived from "the job finished".
   * A missing applier is not an error: the worker then owns only the job row.
   */
  readonly apply?: (job: Job, result: AdapterResult<unknown>) => Promise<void>;
}

export class InProcessWorker {
  constructor(private readonly options: WorkerOptions) {}

  /** Process at most one job. Returns null when the queue is empty. */
  async tick(): Promise<JobOutcome | null> {
    const { queue, handlers, logger, workerId } = this.options;
    const leaseMs = this.options.leaseMs ?? 60_000;

    const job = await queue.claim(workerId, leaseMs);
    if (!job) return null;

    const handler = handlers[job.kind];
    if (!handler) {
      logger.warn("no handler for job kind", { kind: job.kind, jobId: job.id });
      // Retrying cannot conjure a handler; fail it now rather than looping.
      await queue.terminate(job.id, `No handler registered for kind '${job.kind}'.`);
      return this.settle(
        job,
        {
          jobId: job.id as OrchestrationJobId,
          kind: job.kind,
          status: "not_configured",
          applied: false,
          reason: `No handler registered for kind '${job.kind}'.`,
        },
        err("not_configured", `No handler registered for kind '${job.kind}'.`),
      );
    }

    let result: AdapterResult<unknown>;
    try {
      result = await handler(job.payload, {
        organizationId: job.organizationId,
        idempotencyKey: job.idempotencyKey,
        timeoutMs: this.options.defaultTimeoutMs ?? 30_000,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error("job handler threw", { jobId: job.id, kind: job.kind, detail: reason });
      await queue.fail(job.id, reason);
      return this.settle(
        job,
        {
          jobId: job.id as OrchestrationJobId,
          kind: job.kind,
          status: "failed",
          applied: false,
          reason,
        },
        err("failed", reason),
      );
    }

    if (result.ok && result.status === "succeeded") {
      await queue.complete(job.id);
      logger.info("job completed", { jobId: job.id, kind: job.kind, status: result.status });
      return this.settle(
        job,
        {
          jobId: job.id as OrchestrationJobId,
          kind: job.kind,
          status: result.status,
          applied: true,
          reason: null,
        },
        result,
      );
    }

    // Not a success. Three kinds of non-success are distinguished, and none of
    // them is ever recorded as `succeeded`:
    //
    //   * in-flight — the engine accepted the work and is still carrying it out
    //     (`running`/`pending`). This is neither a success nor a failure, so it
    //     is deferred: the job returns to the queue without spending an attempt
    //     and is not re-claimed until the poll interval elapses. Spending an
    //     attempt here was a real bug — a build that outlives the retry budget
    //     was failed while the engine was still building it.
    //   * transient — an engine call that failed. `fail` requeues while attempts
    //     remain, then fails terminally.
    //   * terminal — an engine we have no credentials for, or one reporting
    //     itself degraded. Retrying cannot help, so `terminate` goes straight to
    //     `failed`.
    const reason = result.ok ? `Adapter returned ${result.status}.` : result.reason;
    if (result.status === "running" || result.status === "pending") {
      // Polling is bounded by a wall-clock ceiling: deferral spends no attempt,
      // so an engine that never settles would otherwise poll forever.
      const ceilingMs = this.options.pollCeilingMs ?? DEFAULT_POLL_CEILING_MS;
      const ageMs = Date.now() - new Date(job.createdAt).getTime();
      if (Number.isFinite(ageMs) && ageMs >= ceilingMs) {
        const ceilingReason =
          `The engine still reports this build ${result.status} after ` +
          `${Math.round(ceilingMs / 60_000)} minutes; it is not being worked on.`;
        await queue.terminate(job.id, ceilingReason);
        logger.warn("job exceeded the in-flight poll ceiling", {
          jobId: job.id,
          kind: job.kind,
          status: result.status,
        });
        return this.settle(
          job,
          {
            jobId: job.id as OrchestrationJobId,
            kind: job.kind,
            status: result.status,
            applied: false,
            reason: ceilingReason,
          },
          err(result.status, ceilingReason),
        );
      }
      await queue.defer(job.id, reason, this.options.pollBackoffMs ?? DEFAULT_POLL_BACKOFF_MS);
      logger.info("job deferred for an in-flight engine build", {
        jobId: job.id,
        kind: job.kind,
        status: result.status,
      });
      return this.settle(
        job,
        {
          jobId: job.id as OrchestrationJobId,
          kind: job.kind,
          status: result.status,
          applied: false,
          reason: null,
        },
        result,
      );
    }
    if (result.status === "not_configured" || result.status === "degraded") {
      await queue.terminate(job.id, reason);
    } else {
      await queue.fail(job.id, reason);
    }
    logger.warn("job did not succeed", { jobId: job.id, kind: job.kind, status: result.status });
    return this.settle(
      job,
      {
        jobId: job.id as OrchestrationJobId,
        kind: job.kind,
        status: result.status,
        applied: false,
        reason,
      },
      result,
    );
  }

  /**
   * Mirror the outcome onto the customer-facing row, then return it.
   *
   * The queue's job state is already written by the caller; this is the separate
   * write to the deployment or data resource. It runs after the job state so a
   * failure to apply cannot leave the job `running`: the job is finished and the
   * row is behind, which is visible, rather than the reverse, which is not.
   */
  private async settle(
    job: Job,
    outcome: JobOutcome,
    result: AdapterResult<unknown>,
  ): Promise<JobOutcome> {
    const apply = this.options.apply;
    if (apply) {
      try {
        await apply(job, result);
      } catch (error) {
        // The job itself is already settled; an apply failure is the row's
        // problem, and swallowing it here would hide it. Log and continue.
        this.options.logger.error("job outcome could not be applied", {
          jobId: job.id,
          kind: job.kind,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcome;
  }

  /** Drain the queue, up to `max` jobs. */
  async drain(max = 100): Promise<readonly JobOutcome[]> {
    const outcomes: JobOutcome[] = [];
    for (let i = 0; i < max; i += 1) {
      const outcome = await this.tick();
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }
}

/** Map a job outcome to the persisted job state. */
export function jobStateFor(outcome: JobOutcome, queueState: JobState): JobState {
  return outcome.applied ? "succeeded" : queueState;
}
