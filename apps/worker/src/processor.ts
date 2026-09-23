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
import type {
  AdapterResult,
  EngineStatus,
  JobState,
  OrchestrationJobId,
} from "@cloud-wai/contracts";
import type { JobQueue } from "@cloud-wai/adapters";
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
      return {
        jobId: job.id as OrchestrationJobId,
        kind: job.kind,
        status: "not_configured",
        applied: false,
        reason: `No handler registered for kind '${job.kind}'.`,
      };
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
      return {
        jobId: job.id as OrchestrationJobId,
        kind: job.kind,
        status: "failed",
        applied: false,
        reason,
      };
    }

    if (result.ok && result.status === "succeeded") {
      await queue.complete(job.id);
      logger.info("job completed", { jobId: job.id, kind: job.kind, status: result.status });
      return {
        jobId: job.id as OrchestrationJobId,
        kind: job.kind,
        status: result.status,
        applied: true,
        reason: null,
      };
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
    return {
      jobId: job.id as OrchestrationJobId,
      kind: job.kind,
      status: result.status,
      applied: false,
      reason,
    };
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
