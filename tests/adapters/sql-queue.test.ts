/**
 * The SQL-backed queue's client wiring.
 *
 * The SQL semantics themselves are proven against a real PostgreSQL in
 * `tests/isolation/rls/11_jobs_probe.sql` and `14_jobs_claim_probe.sql`. What
 * those cannot check is whether *this* TypeScript client calls PostgREST
 * correctly: the `on_conflict` target, the `resolution=ignore-duplicates`
 * preference, the RPC names and argument shapes, and the state each method
 * writes. A wrong `on_conflict` column list is a silent duplicate, so it is
 * worth a test of its own.
 *
 * The double below is an in-process PostgREST stand-in, not a mock of the queue:
 * it speaks the same request shape (path, method, prefer, body) and applies the
 * same rules the SQL does. That is what makes a request-shape mistake visible.
 */
import { describe, expect, it } from "vitest";
import { createPostgrestClient } from "@cloud-wai/database";
import { SqlJobQueue } from "@cloud-wai/database";
import type { OrganizationId } from "@cloud-wai/contracts";

const ORG_A = "org-a" as OrganizationId;

interface StoredRow {
  [key: string]: unknown;
  id: string;
  organization_id: string;
  kind: string;
  idempotency_key: string;
  state: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  lease_expires_at: string | null;
  payload: unknown;
}

/**
 * A minimal PostgREST that honours the parts of the protocol this queue uses.
 *
 * It records every request so a test can assert the request the queue built, and
 * it enforces the unique `(organization_id, kind, idempotency_key)` rule so the
 * idempotency path is really exercised rather than assumed.
 */
function fakePostgrest() {
  const rows = new Map<string, StoredRow>();
  const requests: { method: string; path: string; prefer?: string | undefined; body?: unknown }[] =
    [];
  let counter = 0;

  const eqFilters = (path: string) => {
    const query = path.split("?")[1] ?? "";
    const filters: [string, string][] = [];
    for (const part of query.split("&")) {
      const [key, raw] = part.split("=");
      if (!key || raw === undefined) continue;
      if (!raw.startsWith("eq.")) continue;
      filters.push([key, decodeURIComponent(raw.slice(3))]);
    }
    return filters;
  };

  const matches = (row: StoredRow, path: string) =>
    eqFilters(path).every(([key, value]) => String(row[key]) === value);

  const json = (status: number, body: unknown) => ({
    ok: true as const,
    status,
    value: { rows: body },
  });

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/rest\/v1/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const prefer = (init?.headers as Record<string, string> | undefined)?.["prefer"];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, prefer, body });

    const respond = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (path.startsWith("/rpc/claim_orchestration_job")) {
      const workerId = body.p_worker_id as string;
      const leaseSeconds = body.p_lease_seconds as number;
      const claimed = [...rows.values()].find(
        (r) => r.state === "queued" && r.attempts < r.max_attempts,
      );
      if (!claimed) return respond(201, []);
      claimed.state = "running";
      claimed.attempts += 1;
      claimed.started_at = "2026-01-01T00:00:00.000Z";
      claimed.lease_expires_at = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      void workerId;
      return respond(201, [claimed]);
    }

    if (path.startsWith("/rpc/reap_expired_jobs")) {
      let reaped = 0;
      for (const row of rows.values()) {
        if (row.state !== "running" || !row.lease_expires_at) continue;
        if (new Date(row.lease_expires_at).getTime() > Date.now()) continue;
        row.state = row.attempts >= row.max_attempts ? "failed" : "queued";
        row.lease_expires_at = null;
        reaped += 1;
      }
      return respond(200, reaped);
    }

    if (method === "POST" && path.startsWith("/orchestration_jobs")) {
      const isIgnoreDup = (prefer ?? "").includes("resolution=ignore-duplicates");
      const duplicate = [...rows.values()].find(
        (r) =>
          r.organization_id === body.organization_id &&
          r.kind === body.kind &&
          r.idempotency_key === body.idempotency_key,
      );
      if (duplicate && isIgnoreDup) return respond(201, []);
      if (duplicate) return respond(409, { message: "duplicate key" });
      const row: StoredRow = {
        id: `job-${++counter}`,
        organization_id: body.organization_id,
        kind: body.kind,
        idempotency_key: body.idempotency_key,
        state: "queued",
        attempts: 0,
        max_attempts: body.max_attempts ?? 3,
        created_at: "2026-01-01T00:00:00.000Z",
        started_at: null,
        finished_at: null,
        last_error: null,
        lease_expires_at: null,
        payload: body.payload,
      };
      rows.set(row.id, row);
      return respond(201, [row]);
    }

    if (method === "GET" && path.startsWith("/orchestration_jobs")) {
      return respond(
        200,
        [...rows.values()].filter((r) => matches(r, path)),
      );
    }

    if (method === "PATCH" && path.startsWith("/orchestration_jobs")) {
      for (const row of rows.values()) {
        if (matches(row, path)) Object.assign(row, body);
      }
      return respond(
        200,
        [...rows.values()].filter((r) => matches(r, path)),
      );
    }

    return respond(404, { message: "unknown" });
  }) as unknown as typeof fetch;

  return { rows, requests, fetchImpl };
}

function queueWith(fake: ReturnType<typeof fakePostgrest>) {
  const client = createPostgrestClient({
    url: "https://example.test",
    serviceRoleKey: "service-role-key",
    fetchImpl: fake.fetchImpl,
  });
  return new SqlJobQueue(client);
}

describe("sql job queue", () => {
  it("enqueues idempotently on (organization, kind, key)", async () => {
    const fake = fakePostgrest();
    const q = queueWith(fake);

    const first = await q.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: { name: "site" },
      idempotencyKey: "k1",
    });
    const again = await q.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: { name: "site" },
      idempotencyKey: "k1",
    });

    expect(again.id).toBe(first.id);
    // The same key on a different kind is a distinct job, per the SQL constraint.
    const otherKind = await q.enqueue({
      organizationId: ORG_A,
      kind: "data.backup",
      payload: {},
      idempotencyKey: "k1",
    });
    expect(otherKind.id).not.toBe(first.id);
    expect(fake.rows.size).toBe(2);

    const insert = fake.requests.find((r) => r.method === "POST" && r.path.includes("on_conflict"));
    expect(insert?.path).toContain("on_conflict=organization_id,kind,idempotency_key");
    expect(insert?.prefer).toContain("resolution=ignore-duplicates");
  });

  it("claims through the SQL function so a claim is exclusive", async () => {
    const fake = fakePostgrest();
    const q = queueWith(fake);
    await q.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: {},
      idempotencyKey: "k1",
    });

    const first = await q.claim("worker-1", 30_000);
    const second = await q.claim("worker-2", 30_000);

    expect(first?.state).toBe("running");
    expect(first?.attempts).toBe(1);
    expect(first?.leaseExpiresAt).not.toBeNull();
    expect(second).toBeNull();
    expect(fake.requests.some((r) => r.path.startsWith("/rpc/claim_orchestration_job"))).toBe(true);
  });

  it("writes succeeded only when complete is called", async () => {
    const fake = fakePostgrest();
    const q = queueWith(fake);
    const job = await q.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: {},
      idempotencyKey: "k1",
    });
    await q.claim("worker-1", 30_000);
    await q.complete(job.id);

    const stored = await q.get(job.id);
    expect(stored?.state).toBe("succeeded");
    expect(stored?.finishedAt).not.toBeNull();
  });

  it("requeues a failed job that still has attempts, fails it when spent", async () => {
    const fake = fakePostgrest();
    const q = queueWith(fake);
    const job = await q.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: {},
      idempotencyKey: "k1",
      maxAttempts: 2,
    });

    await q.claim("worker-1", 30_000);
    await q.fail(job.id, "engine timed out");
    expect((await q.get(job.id))?.state).toBe("queued");

    await q.claim("worker-1", 30_000);
    await q.fail(job.id, "engine timed out again");
    const spent = await q.get(job.id);
    expect(spent?.state).toBe("failed");
    expect(spent?.lastError).toBe("engine timed out again");
  });

  it("terminates a job as failed, never succeeded", async () => {
    const fake = fakePostgrest();
    const q = queueWith(fake);
    const job = await q.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: {},
      idempotencyKey: "k1",
    });
    await q.terminate(job.id, "no handler for this kind");
    const stored = await q.get(job.id);
    expect(stored?.state).toBe("failed");
    expect(stored?.state).not.toBe("succeeded");
  });

  it("reaps through the SQL function", async () => {
    const fake = fakePostgrest();
    const q = queueWith(fake);
    await q.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: {},
      idempotencyKey: "k1",
    });
    await q.claim("worker-1", 30_000);
    // Force the lease into the past, as a crashed worker would leave it.
    for (const row of fake.rows.values()) {
      row.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    }
    const reaped = await q.reapExpired();
    expect(reaped).toBe(1);
    expect((await q.get([...fake.rows.keys()][0]!))?.state).toBe("queued");
  });
});
