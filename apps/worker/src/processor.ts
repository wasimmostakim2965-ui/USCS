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

export interface WorkerOptions {
  readonly queue: JobQueue;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly logger: Logger;
  readonly workerId: string;
  /** How long a claim is valid before another worker may reap it. */
  readonly leaseMs?: number;
  readonly defaultTimeoutMs?: number;
  /**
   * Write the job's outcome onto the row the command acted on.
   *
   * The queue records that a job finished; the *deployment* a customer is
   * looking at is a different row, and only this applier may change it. It
   * receives the adapter's own result, so the customer-facing status is exactly
   * what the engine reported — never a state derived from "the job finished".
   * A missing applier is not an error: the worker then owns only the job row.
   */
  readonly apply?: (
    job: Job,
    result: AdapterResult<unknown>,
  ) => Promise<void>;
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

    // Not a success. A transient failure should be retried; an engine we have no
    // credentials for, or one reporting itself degraded, will not improve by
    // retrying — fail it terminally. Either way the state is `failed`, never
    // `succeeded`: the work did not happen.
    const reason = result.ok ? `Adapter returned ${result.status}.` : result.reason;
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
