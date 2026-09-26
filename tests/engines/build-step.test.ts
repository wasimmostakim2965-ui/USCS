/**
 * The build step (ADR-0018): the layer that turns source into the artifact a
 * serverless deploy needs.
 *
 * The tests here are about what the step refuses to do, because those refusals
 * are what keep a serverless deploy honest:
 *
 *  * a project with no repository is not built,
 *  * a builder that is not configured is not faked,
 *  * a build that is still running is waited on, not failed,
 *  * a build that finished with no artifact is a failure, not a deploy of
 *    nothing.
 */
import { describe, expect, it } from "vitest";
import { buildNotConfigured, runBuildStep, type BuildEngine } from "@cloud-wai/adapters";
import type { AdapterResult, OperationRef, ProviderRef } from "@cloud-wai/contracts";
import { err, ok } from "@cloud-wai/contracts";

const ORG = "org-a" as ProviderRef["organizationId"];

const buildRef: ProviderRef = {
  organizationId: ORG,
  provider: "railpack",
  resourceType: "build",
  resourceId: "b1",
};

/** A build engine that answers from a scripted sequence and records the waits. */
function scriptedEngine(
  artifacts: readonly AdapterResult<{
    image?: string;
    bucket?: string;
    functions?: Record<string, string>;
  }>[],
  started: AdapterResult<OperationRef> = ok("running", {
    providerRef: buildRef,
  } as OperationRef),
): { engine: BuildEngine; waits: number[] } {
  const waits: number[] = [];
  let index = 0;
  const engine = {
    __notConfigured: undefined,
    async build() {
      return started;
    },
    async getArtifact() {
      const next = artifacts[Math.min(index, artifacts.length - 1)]!;
      index += 1;
      return next;
    },
    async getBuildLogs() {
      return err("not_configured", "no logs");
    },
    async cancelBuild() {
      return ok("succeeded", undefined);
    },
  } as unknown as BuildEngine;
  return { engine, waits };
}

const input = {
  organizationId: ORG,
  idempotencyKey: "k1",
  timeoutMs: 100,
  repository: "https://github.com/x/y",
  branch: "main",
  buildPack: null,
};

describe("the build step", () => {
  it("refuses to build a project with no repository", async () => {
    const { engine } = scriptedEngine([]);
    const result = await runBuildStep({ build: engine }, { ...input, repository: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no git repository");
  });

  it("reports the builder's own reason when no builder is configured", async () => {
    const result = await runBuildStep({ build: buildNotConfigured("railpack") }, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("railpack");
  });

  it("waits while the build is running and returns the artifact when it lands", async () => {
    const { engine } = scriptedEngine([
      err("degraded", "still running"),
      err("degraded", "still running"),
      ok("succeeded", { image: "registry.test/app:abc" }),
    ]);
    const sleeps: number[] = [];
    const result = await runBuildStep(
      { build: engine, sleep: async (ms) => void sleeps.push(ms), pollIntervalMs: 5 },
      input,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact).toEqual({ kind: "image", uri: "registry.test/app:abc" });
      expect(result.buildRef).toEqual(buildRef);
    }
    // Two degraded answers means two waits, not three.
    expect(sleeps).toEqual([5, 5]);
  });

  it("fails a build that finished with no artifact instead of deploying nothing", async () => {
    const { engine } = scriptedEngine([ok("succeeded", {})]);
    const result = await runBuildStep({ build: engine }, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no artifact");
  });

  it("stops polling on a finished failure rather than waiting out the budget", async () => {
    const { engine } = scriptedEngine([err("failed", "the compile step exited 1")]);
    const sleeps: number[] = [];
    const result = await runBuildStep(
      { build: engine, sleep: async (ms) => void sleeps.push(ms), pollIntervalMs: 5 },
      input,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("the compile step exited 1");
    expect(sleeps).toEqual([]);
  });

  it("maps a function bundle to an s3 artifact the serverless engine can publish", async () => {
    const { engine } = scriptedEngine([
      ok("succeeded", { bucket: "cloud-wai-builds", functions: { "/api": "org-a/b1/api.zip" } }),
    ]);
    const result = await runBuildStep({ build: engine }, input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact).toEqual({
        kind: "s3",
        bucket: "cloud-wai-builds",
        key: "org-a/b1/api.zip",
      });
    }
  });

  it("gives up after the poll budget rather than looping forever", async () => {
    const { engine } = scriptedEngine([err("degraded", "still running")]);
    const result = await runBuildStep(
      { build: engine, sleep: async () => {}, pollIntervalMs: 1, maxPolls: 3 },
      input,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("did not produce an artifact");
  });
});
