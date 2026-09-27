/**
 * Durable job queue semantics.
 *
 * The queue is the contract between the API (which accepts a command) and the
 * worker (which carries it out). Its three properties matter:
 *
 *   * idempotent: enqueuing the same (organization, kind, key) twice returns the
 *     existing job, so a retried request cannot create a second deployment;
 *   * claimable: a job can be taken by exactly one worker at a time, and a claim
 *     that is not completed expires so a crashed worker does not wedge it;
 *   * honest: a job finishes as `succeeded` only when the adapter said so.
 *
 * `InMemoryJobQueue` implements the contract with the same rules the SQL
 * implementation will use (`unique (organization_id, idempotency_key)` plus
 * `for update skip locked`).
 */
import type { JobState, OrganizationId } from "@cloud-wai/contracts";

export interface Job<TPayload = unknown> {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly kind: string;
  readonly payload: TPayload;
  readonly idempotencyKey: string;
  readonly state: JobState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastError: string | null;
  readonly leaseExpiresAt: string | null;
  /**
   * When a deferred job may next be claimed, or null when it is claimable now.
   * Set by `defer` for in-flight engine work; never a success.
   */
  readonly deferredUntil: string | null;
}

export interface EnqueueInput<TPayload> {
  readonly organizationId: OrganizationId;
  readonly kind: string;
  readonly payload: TPayload;
  readonly idempotencyKey: string;
  readonly maxAttempts?: number;
}

export interface JobQueue {
  enqueue<TPayload>(input: EnqueueInput<TPayload>): Promise<Job<TPayload>>;
  claim(workerId: string, leaseMs: number): Promise<Job | null>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, reason: string): Promise<void>;
  /**
   * Fail a job terminally, without consuming further attempts.
   *
   * Used when retrying cannot help — an engine this deployment has no
   * credentials for, or a job kind with no handler. The state becomes `failed`,
   * never `succeeded`: the work did not happen.
   */
  terminate(jobId: string, reason: string): Promise<void>;
  /**
   * Return a job to the queue *without* spending an attempt.
   *
   * Distinct from `fail`, which consumes the retry budget. This is for work the
   * engine has accepted and is still carrying out — a build the hosting engine
   * reports `running`. That is neither a success nor a failure, so it must not
   * count against `maxAttempts`: a build that takes longer than
   * `maxAttempts × backoff` would otherwise be failed as a transient error even
   * though it is progressing. The job is left `queued` with its lease cleared,
   * so the next poll (subject to the caller's backoff) re-reads the engine and
   * settles the row when the engine finally answers.
   *
   * The job never becomes `succeeded` here; only the engine's own success does.
   *
   * `deferMs` is the poll interval: the job is not claimable until it elapses,
   * so a fast worker loop does not re-poll an engine build thousands of times a
   * second. A caller that omits it gets an immediate requeue.
   */
  defer(jobId: string, reason: string, deferMs?: number): Promise<void>;
  /** Return an expired lease to the queue so another worker can pick it up. */
  reapExpired(now?: Date): Promise<number>;
  get(jobId: string): Promise<Job | null>;
}

export class JobQueueConflictError extends Error {
  constructor(
    readonly kind: string,
    readonly idempotencyKey: string,
  ) {
    super(`A job for ${kind} with key ${idempotencyKey} already exists.`);
    this.name = "JobQueueConflictError";
  }
}

interface StoredJob extends Job {
  state: JobState;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  leaseExpiresAt: string | null;
  deferredUntil: string | null;
}

export class InMemoryJobQueue implements JobQueue {
  private readonly byKey = new Map<string, StoredJob>();
  private readonly byId = new Map<string, StoredJob>();
  private counter = 0;
  private clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  private keyOf(job: { organizationId: string; kind: string; idempotencyKey: string }) {
    return `${job.organizationId}::${job.kind}::${job.idempotencyKey}`;
  }

  async enqueue<TPayload>(input: EnqueueInput<TPayload>): Promise<Job<TPayload>> {
    const key = this.keyOf(input);
    const existing = this.byKey.get(key);
    // Idempotent: a repeat returns the original job rather than a duplicate.
    if (existing) return existing as unknown as Job<TPayload>;

    const now = this.clock().toISOString();
    const job: StoredJob = {
      id: `job-${++this.counter}`,
      organizationId: input.organizationId,
      kind: input.kind,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      state: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      lastError: null,
      leaseExpiresAt: null,
      deferredUntil: null,
    };
    this.byKey.set(key, job);
    this.byId.set(job.id, job);
    return job as unknown as Job<TPayload>;
  }

  async claim(workerId: string, leaseMs: number): Promise<Job | null> {
    const now = this.clock();
    for (const job of this.byId.values()) {
      if (job.state !== "queued") continue;
      if (job.attempts >= job.maxAttempts) continue;
      // A deferred job stays invisible until its poll interval elapses, so an
      // in-flight engine build is not re-polled on every worker tick.
      if (job.deferredUntil && new Date(job.deferredUntil).getTime() > now.getTime()) continue;
      job.state = "running";
      job.attempts += 1;
      job.startedAt = now.toISOString();
      job.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      job.deferredUntil = null;
      void workerId; // recorded by the SQL implementation; unused in memory
      return job;
    }
    return null;
  }

  async complete(jobId: string): Promise<void> {
    const job = this.byId.get(jobId);
    if (!job) return;
    job.state = "succeeded";
    job.finishedAt = this.clock().toISOString();
    job.leaseExpiresAt = null;
    job.lastError = null;
  }

  async fail(jobId: string, reason: string): Promise<void> {
    const job = this.byId.get(jobId);
    if (!job) return;
    job.lastError = reason;
    job.leaseExpiresAt = null;
    if (job.attempts >= job.maxAttempts) {
      job.state = "failed";
      job.finishedAt = this.clock().toISOString();
    } else {
      // Requeue for another attempt.
      job.state = "queued";
    }
  }

  async terminate(jobId: string, reason: string): Promise<void> {
    const job = this.byId.get(jobId);
    if (!job) return;
    job.state = "failed";
    job.lastError = reason;
    job.finishedAt = this.clock().toISOString();
    job.leaseExpiresAt = null;
  }

  async defer(jobId: string, reason: string, deferMs = 0): Promise<void> {
    const job = this.byId.get(jobId);
    if (!job) return;
    // No terminal state is written: the engine owns the build and has not
    // settled it, so the job merely goes back for another poll once the interval
    // elapses. The attempt the claim just spent is *returned*: `attempts` is the
    // budget for transient failures, and a poll that found the build still
    // running is not a failure. Polling is bounded by the caller's wall-clock
    // ceiling instead.
    job.state = "queued";
    job.lastError = reason;
    job.startedAt = null;
    job.leaseExpiresAt = null;
    job.attempts = Math.max(0, job.attempts - 1);
    job.deferredUntil =
      deferMs > 0 ? new Date(this.clock().getTime() + deferMs).toISOString() : null;
  }

  async reapExpired(now: Date = this.clock()): Promise<number> {
    let reaped = 0;
    for (const job of this.byId.values()) {
      if (job.state !== "running" || !job.leaseExpiresAt) continue;
      if (new Date(job.leaseExpiresAt).getTime() > now.getTime()) continue;
      if (job.attempts >= job.maxAttempts) {
        job.state = "failed";
        job.finishedAt = now.toISOString();
        job.lastError = "lease expired and no attempts remain";
      } else {
        job.state = "queued";
        job.lastError = "lease expired";
      }
      job.leaseExpiresAt = null;
      reaped += 1;
    }
    return reaped;
  }

  async get(jobId: string): Promise<Job | null> {
    return this.byId.get(jobId) ?? null;
  }
}
