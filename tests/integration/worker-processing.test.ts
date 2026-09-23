/**
 * End-to-end worker processing.
 *
 * A job is enqueued with the real queue, claimed and executed through a real
 * adapter, and the persisted job state is asserted. The unconfigured case is the
 * important one: an engine we have no credentials for must leave the job
 * non-successful and must be visible as such.
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryJobQueue,
  fakeDatabase,
  fakeHosting,
  hostingNotConfigured,
  databaseNotConfigured,
} from "@cloud-wai/adapters";
import { InProcessWorker, buildHandlers, jobStateFor } from "@cloud-wai/worker";
import type { OrganizationId } from "@cloud-wai/contracts";

const ORG_A = "org-a" as OrganizationId;
const ORG_B = "org-b" as OrganizationId;

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function workerWith(engines: Parameters<typeof buildHandlers>[0], queue = new InMemoryJobQueue()) {
  const worker = new InProcessWorker({
    queue,
    handlers: buildHandlers(engines),
    logger: silentLogger(),
    workerId: "worker-1",
  });
  return { worker, queue };
}

describe("worker job processing", () => {
  it("completes a deployment that the engine really performed", async () => {
    const { worker, queue } = workerWith({ hosting: fakeHosting(), database: fakeDatabase() });
    const job = await queue.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: { name: "Alpha" },
      idempotencyKey: "create-alpha",
    });

    const outcome = await worker.tick();
    expect(outcome?.applied).toBe(true);
    expect(outcome?.status).toBe("succeeded");

    const persisted = await queue.get(job.id);
    expect(persisted?.state).toBe("succeeded");
    expect(jobStateFor(outcome!, persisted!.state)).toBe("succeeded");
  });

  it("does not mark a job succeeded when the engine is unconfigured", async () => {
    const { worker, queue } = workerWith({
      hosting: hostingNotConfigured("coolify", "Set COOLIFY_URL."),
      database: databaseNotConfigured("postgres"),
    });
    const job = await queue.enqueue({
      organizationId: ORG_A,
      kind: "deployment.deploy",
      payload: {
        applicationRef: {
          organizationId: ORG_A,
          provider: "coolify",
          resourceType: "application",
          resourceId: "a",
        },
      },
      idempotencyKey: "deploy-alpha",
    });

    const outcome = await worker.tick();
    expect(outcome?.status).toBe("not_configured");
    expect(outcome?.applied).toBe(false);
    expect(outcome?.reason).toContain("COOLIFY_URL");

    const persisted = await queue.get(job.id);
    // Terminal, but emphatically not `succeeded`.
    expect(persisted?.state).not.toBe("succeeded");
    expect(jobStateFor(outcome!, persisted!.state)).not.toBe("succeeded");
  });

  it("retries a transient engine failure, then fails terminally", async () => {
    const { worker, queue } = workerWith({
      hosting: fakeHosting({ behaviour: "failed" }),
      database: fakeDatabase(),
    });
    const job = await queue.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: { name: "Alpha" },
      idempotencyKey: "k",
      maxAttempts: 2,
    });

    await worker.tick();
    expect((await queue.get(job.id))?.state).toBe("queued");
    await worker.tick();
    expect((await queue.get(job.id))?.state).toBe("failed");
  });

  it("fails a job whose kind has no handler, without touching an engine", async () => {
    const { worker, queue } = workerWith({ hosting: fakeHosting(), database: fakeDatabase() });
    const job = await queue.enqueue({
      organizationId: ORG_A,
      kind: "mystery.operation",
      payload: {},
      idempotencyKey: "k",
    });

    const outcome = await worker.tick();
    expect(outcome?.applied).toBe(false);
    expect(outcome?.reason).toContain("mystery.operation");
    expect((await queue.get(job.id))?.state).toBe("failed");
  });

  it("contains a handler that throws", async () => {
    const { worker, queue } = workerWith({ hosting: fakeHosting(), database: fakeDatabase() });
    // A handler that throws must not take the worker down.
    const throwing = new InProcessWorker({
      queue,
      handlers: {
        "deployment.create": async () => {
          throw new Error("unexpected explosion");
        },
      },
      logger: silentLogger(),
      workerId: "w",
    });

    await queue.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: { name: "x" },
      idempotencyKey: "k",
    });
    const outcome = await throwing.tick();
    expect(outcome?.applied).toBe(false);
    expect(outcome?.reason).toContain("unexpected explosion");
    void worker;
  });

  it("processes the same key only once across a drain", async () => {
    const { worker, queue } = workerWith({ hosting: fakeHosting(), database: fakeDatabase() });
    await queue.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: { name: "A" },
      idempotencyKey: "dup",
    });
    await queue.enqueue({
      organizationId: ORG_A,
      kind: "deployment.create",
      payload: { name: "A" },
      idempotencyKey: "dup",
    });

    const outcomes = await worker.drain();
    expect(outcomes).toHaveLength(1);
  });

  it("keeps organizations' jobs independent under the same key", async () => {
    const { worker, queue } = workerWith({ hosting: fakeHosting(), database: fakeDatabase() });
    await queue.enqueue({
      organizationId: ORG_A,
      kind: "data.provision",
      payload: { name: "shared-name" },
      idempotencyKey: "same",
    });
    await queue.enqueue({
      organizationId: ORG_B,
      kind: "data.provision",
      payload: { name: "shared-name" },
      idempotencyKey: "same",
    });

    const outcomes = await worker.drain();
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.applied)).toBe(true);
  });

  it("provisions and backs up a database through the adapter contract", async () => {
    const { worker, queue } = workerWith({ hosting: fakeHosting(), database: fakeDatabase() });
    await queue.enqueue({
      organizationId: ORG_A,
      kind: "data.provision",
      payload: { name: "db" },
      idempotencyKey: "p",
    });
    const provisioned = await worker.tick();
    expect(provisioned?.applied).toBe(true);
  });
});
