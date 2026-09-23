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
      job.state = "running";
      job.attempts += 1;
      job.startedAt = now.toISOString();
      job.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
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
