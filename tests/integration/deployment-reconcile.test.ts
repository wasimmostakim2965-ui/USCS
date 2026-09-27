/**
 * The stranded-deployment sweep (C7, residual gap).
 *
 * The requeue path (`deployment-resume.test.ts`) covers a job redelivered while
 * its build is in flight. What it cannot cover is a deployment row left
 * `pending`/`running` with no job left to requeue it — a job that terminated
 * while its row did not, or a build the engine accepted and never settled until
 * the attempt budget ran out. Those rows read as in-progress to the customer
 * forever, which is a worse lie than a failure, and this sweep is the only thing
 * that settles them.
 *
 * The engine here is a hand-rolled `HostingAdapter`, not a mock: it serves the
 * real interface and answers `getDeployment` from a scripted map, so the test
 * proves the sweep asks the engine the truth rather than deciding for itself.
 * The one thing pinned hardest: the sweep never writes `succeeded` from a
 * timeout — only the engine's own answer produces `succeeded`.
 */
import { describe, expect, it } from "vitest";
import type { Engines, HostingAdapter, DeploymentState } from "@cloud-wai/adapters";
import {
  databaseNotConfigured,
  securityNotConfigured,
  serverlessNotConfigured,
  storageNotConfigured,
  domainVerifierNotConfigured,
} from "@cloud-wai/adapters";
import { ok, err } from "@cloud-wai/contracts";
import type { ProviderRef } from "@cloud-wai/contracts";
import { buildDeploymentReconciler, type StrandedDeployment } from "@cloud-wai/worker";

const ORG = "org-a";

/**
 * A hosting engine whose reads are scripted by resource id.
 *
 * `answers` maps a ref's resource id to what the engine reports. A missing key
 * is the engine's honest "I have no record of that", which is the refusal the
 * sweep must not mistake for progress.
 */
function scriptingHosting(
  answers: Record<
    string,
    ReturnType<HostingAdapter["getDeployment"]> extends Promise<infer R> ? R : never
  >,
): { hosting: HostingAdapter; reads: string[] } {
  const reads: string[] = [];
  const hosting: HostingAdapter = {
    async createApplication() {
      return err("failed", "the sweep must never create an application");
    },
    async deploy() {
      return err("failed", "the sweep must never deploy");
    },
    async getDeployment(_ctx, ref) {
      reads.push(ref.resourceId);
      const answer = answers[ref.resourceId];
      if (!answer) return err("not_configured", `no deployment ${ref.resourceId}`);
      return answer as never;
    },
    async cancelDeployment() {
      return err("failed", "the sweep must never cancel");
    },
    async rollback() {
      return err("failed", "the sweep must never roll back");
    },
    async getLogs() {
      return ok("succeeded", { lines: [], cursor: null });
    },
    async listEnvVars() {
      return ok("succeeded", []);
    },
    async createEnvVar() {
      return err("not_configured", "no env vars here");
    },
    async updateEnvVar() {
      return err("not_configured", "no env vars here");
    },
    async deleteEnvVar() {
      return ok("succeeded", undefined);
    },
    async deleteApplication() {
      return err("failed", "the sweep must never destroy");
    },
    async reconcile() {
      return err("not_configured", "the sweep goes through the port, not reconcile");
    },
  };
  return { hosting, reads };
}

function enginesWith(hosting: HostingAdapter): Engines {
  return {
    hosting,
    serverless: serverlessNotConfigured("lambda", "x"),
    database: databaseNotConfigured("postgres", "x"),
    storage: storageNotConfigured("minio", "x"),
    securityEdge: securityNotConfigured("envoy", "x"),
    domainVerifier: domainVerifierNotConfigured("dns"),
    build: { __notConfigured: true } as never,
  } as Engines;
}

/** A stranded row, twenty minutes old by default — past the ten-minute threshold. */
function stranded(over: Partial<StrandedDeployment> = {}): StrandedDeployment {
  return {
    id: "dep-1",
    organizationId: ORG as StrandedDeployment["organizationId"],
    projectId: "proj-a",
    status: "running",
    providerResourceId: "app-1",
    deploymentResourceId: "run-1",
    createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    kind: "production",
    staged: false,
    ...over,
  };
}

/**
 * The write side, recording every call so a test can assert what the sweep did
 * *and did not* do. `settles` is what the reconciler wrote; `promotions` and
 * `usage` are the two side effects a confirmed success must carry.
 */
function writesFor(rows: readonly StrandedDeployment[]) {
  const settles: { id: string; status: string; reason: string | null }[] = [];
  const promotions: string[] = [];
  const usage: string[] = [];
  let listedWith: string | null = null;
  const writes = {
    async listStrandedDeploymentsForService(olderThan: string) {
      listedWith = olderThan;
      return rows;
    },
    async getProjectDeploymentTargetForService() {
      return { executionModel: "container" as const };
    },
  };
  const outcome = {
    async updateDeploymentStatus(input: {
      id: string;
      status: string;
      failureReason: string | null;
    }) {
      settles.push({ id: input.id, status: input.status, reason: input.failureReason });
      return {};
    },
    async promoteDeployment(input: { deploymentId: string }) {
      promotions.push(input.deploymentId);
      return {};
    },
    async recordUsage(input: { organizationId: string }) {
      usage.push(input.organizationId);
      return {};
    },
  };
  return {
    writes,
    outcome,
    settles,
    promotions,
    usage,
    listedWith: () => listedWith,
  };
}

describe("the stranded-deployment sweep settles rows the queue left behind", () => {
  it("writes the engine's own terminal state and promotes a confirmed success", async () => {
    const { hosting } = scriptingHosting({
      "run-1": ok<DeploymentState>("succeeded", {
        ref: {} as ProviderRef,
        status: "succeeded",
        url: "https://alpha.test",
      }),
    });
    const h = writesFor([stranded()]);
    const reconcile = buildDeploymentReconciler({
      engines: enginesWith(hosting),
      writes: h.writes,
      outcome: h.outcome,
    });

    const settled = await reconcile();
    expect(settled).toBe(1);
    expect(h.settles).toEqual([{ id: "dep-1", status: "succeeded", reason: null }]);
    // A confirmed success carries the same two side effects the job applier
    // gives it: the production pointer moves and one unit is billed.
    expect(h.promotions).toEqual(["dep-1"]);
    expect(h.usage).toEqual([ORG]);
  });

  it("fails a row the engine has no record of, rather than leaving it pending", async () => {
    const { hosting } = scriptingHosting({});
    const h = writesFor([stranded()]);
    const reconcile = buildDeploymentReconciler({
      engines: enginesWith(hosting),
      writes: h.writes,
      outcome: h.outcome,
    });

    await reconcile();
    // The engine's refusal is the answer: the build does not exist, so the row
    // is failed with the engine's reason — not `succeeded`, and not left to
    // imply progress.
    expect(h.settles).toHaveLength(1);
    expect(h.settles[0]!.status).toBe("failed");
    expect(h.settles[0]!.reason).toContain("no record");
    expect(h.promotions).toEqual([]);
    expect(h.usage).toEqual([]);
  });

  it("leaves a row the engine still reports in flight alone, below the ceiling", async () => {
    const { hosting } = scriptingHosting({
      "run-1": ok<DeploymentState>("running", {
        ref: {} as ProviderRef,
        status: "running",
        url: null,
      }),
    });
    const h = writesFor([stranded()]);
    const reconcile = buildDeploymentReconciler({
      engines: enginesWith(hosting),
      writes: h.writes,
      outcome: h.outcome,
    });

    const settled = await reconcile();
    expect(settled).toBe(0);
    expect(h.settles).toEqual([]);
  });

  it("never writes succeeded from a timeout: a past-ceiling row is failed, not green", async () => {
    // The engine still claims the build is running, an hour and a half in. A
    // build is not still coming; the honest write is a failure naming the
    // ceiling. `succeeded` from a timeout would be the platform lying about a
    // build it never confirmed.
    const { hosting } = scriptingHosting({
      "run-1": ok<DeploymentState>("running", {
        ref: {} as ProviderRef,
        status: "running",
        url: "https://should-not-count.test",
      }),
    });
    const h = writesFor([
      stranded({ createdAt: new Date(Date.now() - 90 * 60_000).toISOString() }),
    ]);
    const reconcile = buildDeploymentReconciler({
      engines: enginesWith(hosting),
      writes: h.writes,
      outcome: h.outcome,
    });

    await reconcile();
    expect(h.settles).toHaveLength(1);
    expect(h.settles[0]!.status).toBe("failed");
    expect(h.settles[0]!.reason).toContain("still running");
    expect(h.promotions).toEqual([]);
    expect(h.usage).toEqual([]);
  });

  it("fails a past-ceiling row with no engine handle at all", async () => {
    const { hosting, reads } = scriptingHosting({});
    const h = writesFor([
      stranded({
        providerResourceId: null,
        deploymentResourceId: null,
        createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      }),
    ]);
    const reconcile = buildDeploymentReconciler({
      engines: enginesWith(hosting),
      writes: h.writes,
      outcome: h.outcome,
    });

    await reconcile();
    expect(h.settles).toHaveLength(1);
    expect(h.settles[0]!.status).toBe("failed");
    expect(h.settles[0]!.reason).toContain("no engine handle");
    // There was nothing to ask: the row never reached an engine.
    expect(reads).toEqual([]);
  });

  it("does not promote a staged production build (the --skip-domain rule)", async () => {
    const { hosting } = scriptingHosting({
      "run-1": ok<DeploymentState>("succeeded", {
        ref: {} as ProviderRef,
        status: "succeeded",
        url: "https://alpha.test",
      }),
    });
    const h = writesFor([stranded({ staged: true })]);
    const reconcile = buildDeploymentReconciler({
      engines: enginesWith(hosting),
      writes: h.writes,
      outcome: h.outcome,
    });

    await reconcile();
    expect(h.settles[0]!.status).toBe("succeeded");
    // The build genuinely succeeded, but a staged build is deliberately not made
    // live — the sweep must honour the same rule the applier does.
    expect(h.promotions).toEqual([]);
    expect(h.usage).toEqual([ORG]);
  });

  it("scopes the sweep by the cutoff it derives from the clock", async () => {
    const { hosting } = scriptingHosting({});
    const h = writesFor([]);
    const fixed = new Date("2026-03-01T12:00:00.000Z");
    const reconcile = buildDeploymentReconciler({
      engines: enginesWith(hosting),
      writes: h.writes,
      outcome: h.outcome,
      now: () => fixed,
      staleAfterMs: 10 * 60_000,
    });

    await reconcile();
    // Ten minutes before the clock, exactly: a row younger than this is not yet
    // stale, so the sweep cannot mistake a build that is legitimately starting.
    expect(h.listedWith()).toBe("2026-03-01T11:50:00.000Z");
  });
});
