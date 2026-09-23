/**
 * Durable queue semantics: idempotent enqueue, single-claim, retry, and honest
 * terminal states. These are the properties the SQL implementation must match.
 */
import { describe, expect, it } from "vitest";
import { InMemoryJobQueue } from "@cloud-wai/adapters";
import type { OrganizationId } from "@cloud-wai/contracts";

const ORG_A = "org-a" as OrganizationId;
const ORG_B = "org-b" as OrganizationId;

describe("job queue", () => {
  it("is idempotent per (organization, kind, key)", async () => {
    const q = new InMemoryJobQueue();
    const first = await q.enqueue({
      organizationId: ORG_A,
      kind: "deploy",
      payload: { p: 1 },
      idempotencyKey: "k1",
    });
    const again = await q.enqueue({
      organizationId: ORG_A,
      kind: "deploy",
      payload: { p: 1 },
      idempotencyKey: "k1",
    });
    expect(again.id).toBe(first.id);
  });

  it("lets the same key exist in two organizations independently", async () => {
    const q = new InMemoryJobQueue();
    const a = await q.enqueue({
      organizationId: ORG_A,
      kind: "deploy",
      payload: {},
      idempotencyKey: "same",
    });
    const b = await q.enqueue({
      organizationId: ORG_B,
      kind: "deploy",
      payload: {},
      idempotencyKey: "same",
    });
    expect(a.id).not.toBe(b.id);
  });

  it("claims a job exactly once", async () => {
    const q = new InMemoryJobQueue();
    await q.enqueue({ organizationId: ORG_A, kind: "deploy", payload: {}, idempotencyKey: "k1" });
    const first = await q.claim("worker-1", 30_000);
    const second = await q.claim("worker-2", 30_000);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("marks completion as succeeded only when told to", async () => {
    const q = new InMemoryJobQueue();
    const job = await q.enqueue({
      organizationId: ORG_A,
      kind: "deploy",
      payload: {},
      idempotencyKey: "k1",
    });
    const claimed = await q.claim("worker-1", 30_000);
    expect(claimed?.state).toBe("running");

    await q.complete(job.id);
    const done = await q.get(job.id);
    expect(done?.state).toBe("succeeded");
  });

  it("requeues a failure while attempts remain, then fails terminally", async () => {
    const q = new InMemoryJobQueue();
    const job = await q.enqueue({
      organizationId: ORG_A,
      kind: "deploy",
      payload: {},
      idempotencyKey: "k1",
      maxAttempts: 2,
    });

    await q.claim("w", 30_000);
    await q.fail(job.id, "engine refused");
    expect((await q.get(job.id))?.state).toBe("queued");

    await q.claim("w", 30_000);
    await q.fail(job.id, "engine refused again");
    const terminal = await q.get(job.id);
    expect(terminal?.state).toBe("failed");
    expect(terminal?.attempts).toBe(2);
    expect(terminal?.lastError).toBe("engine refused again");
  });

  it("reaps an expired lease so a crashed worker does not wedge the job", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const q = new InMemoryJobQueue(() => now);

    const job = await q.enqueue({
      organizationId: ORG_A,
      kind: "deploy",
      payload: {},
      idempotencyKey: "k1",
    });
    await q.claim("worker-1", 1_000);

    // Worker crashes; the lease lapses.
    now = new Date("2026-01-01T00:00:05Z");
    const reaped = await q.reapExpired();
    expect(reaped).toBe(1);
    expect((await q.get(job.id))?.state).toBe("queued");

    // Another worker can now take it.
    const reclaimed = await q.claim("worker-2", 1_000);
    expect(reclaimed?.id).toBe(job.id);
  });

  it("fails a job whose lease expired with no attempts left", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const q = new InMemoryJobQueue(() => now);
    const job = await q.enqueue({
      organizationId: ORG_A,
      kind: "deploy",
      payload: {},
      idempotencyKey: "k1",
      maxAttempts: 1,
    });
    await q.claim("worker-1", 1_000);

    now = new Date("2026-01-01T00:01:00Z");
    await q.reapExpired();
    const state = await q.get(job.id);
    expect(state?.state).toBe("failed");
    expect(state?.state).not.toBe("succeeded");
  });

  it("claims nothing from an empty queue", async () => {
    const q = new InMemoryJobQueue();
    expect(await q.claim("w", 1_000)).toBeNull();
  });
});
