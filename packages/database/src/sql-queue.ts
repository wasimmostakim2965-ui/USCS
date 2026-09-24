/**
 * The durable job queue, backed by the control-plane database.
 *
 * `InMemoryJobQueue` proved the contract (`packages/adapters/src/queue.ts`);
 * this is the implementation a production deployment runs, and it is
 * deliberately the same rules expressed in SQL. Three properties decide it, and
 * each is enforced by the database rather than by this file:
 *
 *   * Idempotent enqueue. The insert carries `on_conflict` on
 *     `(organization_id, kind, idempotency_key)`, so a repeated command returns
 *     the original row. This is the same constraint migration 0003 created; a
 *     duplicate is impossible even if two API replicas race, because the
 *     database, not the caller, decides.
 *   * An exclusive claim. Claiming is `public.claim_orchestration_job()`
 *     (migration 0008), because `select ... for update skip locked` plus an
 *     attempt increment plus a lease write cannot be expressed as one REST call.
 *     Two workers calling it get two distinct jobs.
 *   * An honest terminal state. `complete`, `fail` and `terminate` write the
 *     state the worker reports; nothing here can produce `succeeded`.
 *
 * The queue is service-role written: RLS has no client policy for
 * `orchestration_jobs`, and the claim/reap functions are granted to
 * `service_role` alone. A browser cannot reach any of this.
 */
import type { Job, JobQueue, EnqueueInput } from "@cloud-wai/adapters";
import type { JobState } from "@cloud-wai/contracts";
import { ControlPlaneUnavailableError } from "./supabase-store.js";
import type { PostgrestClient } from "./postgrest.js";

interface JobRow {
  readonly id: string;
  readonly organization_id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly idempotency_key: string;
  readonly state: JobState;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly last_error: string | null;
  readonly lease_expires_at: string | null;
}

const COLUMNS =
  "id,organization_id,kind,payload,idempotency_key,state,attempts,max_attempts,created_at,started_at,finished_at,last_error,lease_expires_at";

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    organizationId: row.organization_id as Job["organizationId"],
    kind: row.kind,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastError: row.last_error,
    leaseExpiresAt: row.lease_expires_at,
  };
}

const DEFAULT_MAX_ATTEMPTS = 3;

export class SqlJobQueue implements JobQueue {
  constructor(private readonly client: PostgrestClient) {}

  private async must<T>(operation: string, req: Parameters<PostgrestClient["request"]>[0]) {
    const result = await this.client.request<T>(req);
    if (!result.ok) throw new ControlPlaneUnavailableError(operation, result.reason);
    return result.value.rows;
  }

  async enqueue<TPayload>(input: EnqueueInput<TPayload>): Promise<Job<TPayload>> {
    // `ignore-duplicates` makes the insert idempotent at the database: a repeat
    // of an existing key is not an error and creates no second row, and the
    // empty representation is the signal to read the row that already exists.
    const inserted = await this.must<JobRow[]>("enqueue", {
      method: "POST",
      path: `/orchestration_jobs?on_conflict=organization_id,kind,idempotency_key&select=${COLUMNS}`,
      prefer: "resolution=ignore-duplicates,return=representation",
      body: {
        organization_id: input.organizationId,
        kind: input.kind,
        payload: input.payload,
        idempotency_key: input.idempotencyKey,
        max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      },
    });

    if (inserted.length > 0) return toJob(inserted[0]!) as unknown as Job<TPayload>;

    const existing = await this.findByKey(input.organizationId, input.kind, input.idempotencyKey);
    // The row must exist: the insert was refused only because a peer wrote it,
    // or because the response body was empty for a reason this code cannot
    // interpret. Either way, returning a fabricated job would be a lie.
    if (!existing) {
      throw new ControlPlaneUnavailableError(
        "enqueue",
        "no row returned and no existing job found for the idempotency key",
      );
    }
    return existing as unknown as Job<TPayload>;
  }

  private async findByKey(
    organizationId: string,
    kind: string,
    idempotencyKey: string,
  ): Promise<Job | null> {
    const rows = await this.must<JobRow[]>("findByKey", {
      method: "GET",
      path: `/orchestration_jobs?select=${COLUMNS}&organization_id=eq.${enc(organizationId)}&kind=eq.${enc(kind)}&idempotency_key=eq.${enc(idempotencyKey)}&limit=1`,
    });
    const row = rows[0];
    return row ? toJob(row) : null;
  }

  async claim(workerId: string, leaseMs: number): Promise<Job | null> {
    const leaseSeconds = Math.max(1, Math.ceil(leaseMs / 1000));
    const rows = await this.must<JobRow[]>("claim", {
      method: "POST",
      path: "/rpc/claim_orchestration_job",
      body: { p_worker_id: workerId, p_lease_seconds: leaseSeconds },
    });
    const row = rows[0];
    return row ? toJob(row) : null;
  }

  async complete(jobId: string): Promise<void> {
    await this.patch(jobId, {
      state: "succeeded",
      finished_at: new Date().toISOString(),
      lease_expires_at: null,
      last_error: null,
    });
  }

  async fail(jobId: string, reason: string): Promise<void> {
    const current = await this.get(jobId);
    if (!current) return;
    const spent = current.attempts >= current.maxAttempts;
    await this.patch(jobId, {
      state: spent ? "failed" : "queued",
      last_error: reason,
      lease_expires_at: null,
      finished_at: spent ? new Date().toISOString() : null,
    });
  }

  async terminate(jobId: string, reason: string): Promise<void> {
    await this.patch(jobId, {
      state: "failed",
      last_error: reason,
      finished_at: new Date().toISOString(),
      lease_expires_at: null,
    });
  }

  async reapExpired(now: Date = new Date()): Promise<number> {
    const reaped = await this.must<number>("reapExpired", {
      method: "POST",
      path: "/rpc/reap_expired_jobs",
      body: { p_now: now.toISOString() },
    });
    return typeof reaped === "number" ? reaped : 0;
  }

  async get(jobId: string): Promise<Job | null> {
    const rows = await this.must<JobRow[]>("get", {
      method: "GET",
      path: `/orchestration_jobs?select=${COLUMNS}&id=eq.${enc(jobId)}&limit=1`,
    });
    const row = rows[0];
    return row ? toJob(row) : null;
  }

  private async patch(jobId: string, body: Record<string, unknown>): Promise<void> {
    await this.must<JobRow[]>("update", {
      method: "PATCH",
      path: `/orchestration_jobs?id=eq.${enc(jobId)}&select=${COLUMNS}`,
      prefer: "return=representation",
      body,
    });
  }
}

/** Percent-encode a query-string value so an id cannot alter the filter. */
function enc(value: string): string {
  return encodeURIComponent(value);
}
