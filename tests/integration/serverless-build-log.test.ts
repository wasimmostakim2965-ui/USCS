/**
 * A serverless deploy's build log is addressable (Phase C, the visible-stage gap).
 *
 * A container engine builds for itself, so a failed build is written to the
 * engine's own deployment log and `deployments.deployment_resource_id` addresses
 * it. A serverless deploy is different: the build runs on a separate builder
 * engine and only the deploy runs on the runtime, so the failure lives in the
 * *builder's* log. Before this the builder's handle was thrown away, and a failed
 * serverless build was a one-line reason with no log to open — the honest but
 * incomplete state the roadmap calls a visible-stage gap.
 *
 * These tests pin the two halves of the fix at the executor:
 *
 *   * the builder's handle is written the moment the builder accepts the build,
 *     *before* the artifact is polled — so a build that fails, hangs, or outlives
 *     this process still has its log addressed by the row;
 *   * the settled result carries the handle, so the applier persists it and the
 *     logs procedure can read the build's own log.
 *
 * The build engine is hand-rolled, not a mock: it serves the real `BuildEngine`
 * port and controls the exact sequence a real builder produces.
 */
import { describe, expect, it } from "vitest";
import type { BuildEngine, Engines, ServerlessAdapter } from "@cloud-wai/adapters";
import {
  databaseNotConfigured,
  fakeServerless,
  buildNotConfigured,
  fakeHosting,
  securityNotConfigured,
  storageNotConfigured,
  domainVerifierNotConfigured,
  hostingNotConfigured,
} from "@cloud-wai/adapters";
import {
  err,
  ok,
  type AdapterResult,
  type OperationRef,
  type ProviderRef,
} from "@cloud-wai/contracts";
import { executeDeployment } from "@cloud-wai/worker";

const ORG = "org-a";
const PROJECT = "proj-a";
const FUNCTION_HANDLE = "fn-1";
const BUILD_HANDLE = "build-1";

const buildRef: ProviderRef = {
  organizationId: ORG as ProviderRef["organizationId"],
  provider: "railpack",
  resourceType: "build",
  resourceId: BUILD_HANDLE,
};

/**
 * A builder that accepts the build and then answers the artifact poll from a
 * scripted result. `onBuildStarted` is recorded so the test can prove it fired
 * *before* the artifact was read.
 */
function builder(
  artifact: AdapterResult<{ image?: string; bucket?: string; functions?: Record<string, string> }>,
  order: string[],
): BuildEngine {
  return {
    async build() {
      order.push("build");
      return ok("running", { providerRef: buildRef } as OperationRef);
    },
    async getArtifact() {
      order.push("getArtifact");
      return artifact;
    },
    async getBuildLogs() {
      return ok("succeeded", { lines: ["npm ci", "build failed: exit 1"], cursor: null });
    },
    async cancelBuild() {
      return ok("succeeded", undefined);
    },
  } as unknown as BuildEngine;
}

function enginesWith(build: BuildEngine, serverless: ServerlessAdapter): Engines {
  return {
    hosting: fakeHosting(),
    serverless,
    database: databaseNotConfigured("postgres", "x"),
    storage: storageNotConfigured("minio", "x"),
    build,
    securityEdge: securityNotConfigured("envoy", "x"),
    domainVerifier: domainVerifierNotConfigured("dns"),
  };
}

/** The service-role reads the executor makes, with the builder handle recorded. */
function writes(target: {
  executionModel: "serverless" | "container";
  provider: string | null;
  providerResourceId: string | null;
}) {
  const recorded: { buildProvider: string; buildProviderResourceId: string }[] = [];
  return {
    recorded,
    writes: {
      async getProjectDeploymentTargetForService() {
        return { ...target, rootDirectory: null };
      },
      async setProjectProviderResource({}) {
        return {};
      },
      async getPreviewTargetForService() {
        return null;
      },
      async setPreviewTargetProvider() {
        return {};
      },
      async markDeploymentBuildHandle(input: {
        buildProvider: string;
        buildProviderResourceId: string;
      }) {
        recorded.push({
          buildProvider: input.buildProvider,
          buildProviderResourceId: input.buildProviderResourceId,
        });
      },
    },
  };
}

const input = {
  organizationId: ORG as never,
  projectId: PROJECT,
  projectSlug: "alpha",
  deploymentId: "dep-1",
  idempotencyKey: "durable-1",
  action: "create" as const,
  gitRepository: "https://github.com/acme/alpha.git",
  gitBranch: "main",
  buildPack: null,
  rootDirectory: null,
  commit: null,
  timeoutMs: 1000,
  kind: "production" as const,
  previewKey: null,
  environmentId: null,
};

describe("a serverless deploy records its builder's handle", () => {
  it("writes the builder handle before reading the artifact, and carries it on success", async () => {
    const order: string[] = [];
    const { recorded, writes: w } = writes({
      executionModel: "serverless",
      provider: "lambda",
      providerResourceId: FUNCTION_HANDLE,
    });
    // Interleave the recorder into the same order log, so the test proves the
    // handle is written *before* the artifact poll, not merely that it is written.
    const recordingWrites = {
      ...w,
      async markDeploymentBuildHandle(input: {
        buildProvider: string;
        buildProviderResourceId: string;
      }) {
        order.push("markBuildHandle");
        await w.markDeploymentBuildHandle(input);
      },
    };
    const engines = enginesWith(
      builder(ok("succeeded", { image: "registry.test/alpha:abc" }), order),
      fakeServerless(),
    );

    const result = await executeDeployment({ engines, writes: recordingWrites as never }, input);

    expect(result.status).toBe("succeeded");
    // The builder handle is on the result, so the applier persists it.
    expect(result.buildProviderResourceId).toBe(BUILD_HANDLE);
    expect(result.buildProvider).toBe("railpack");
    // And it was recorded before the artifact was even read.
    expect(order).toEqual(["build", "markBuildHandle", "getArtifact"]);
    expect(recorded).toEqual([
      { buildProvider: "railpack", buildProviderResourceId: BUILD_HANDLE },
    ]);
  });

  it("still records the builder handle when the build fails, so its log is addressable", async () => {
    const order: string[] = [];
    const { recorded, writes: w } = writes({
      executionModel: "serverless",
      provider: "lambda",
      providerResourceId: FUNCTION_HANDLE,
    });
    const recordingWrites = {
      ...w,
      async markDeploymentBuildHandle(input: {
        buildProvider: string;
        buildProviderResourceId: string;
      }) {
        order.push("markBuildHandle");
        await w.markDeploymentBuildHandle(input);
      },
    };
    const engines = enginesWith(
      builder(err("failed", "build failed: exit 1"), order),
      fakeServerless(),
    );

    const result = await executeDeployment({ engines, writes: recordingWrites as never }, input);

    expect(result.status).toBe("failed");
    // The failure is the builder's own words, and the handle it was reached by is
    // on the record — which is what lets the logs procedure read that build's log.
    expect(result.reason).toContain("build failed");
    expect(recorded).toEqual([
      { buildProvider: "railpack", buildProviderResourceId: BUILD_HANDLE },
    ]);
  });

  it("records no builder handle for a container deploy, which builds for itself", async () => {
    const order: string[] = [];
    const { recorded, writes: w } = writes({
      executionModel: "container",
      provider: "coolify",
      providerResourceId: "app-1",
    });
    // A container engine: the router reports the build engine is not reached at
    // all, because the runtime builds from git itself.
    const engines = enginesWith(
      buildNotConfigured("railpack", "no builder wired"),
      fakeServerless(),
    );
    void hostingNotConfigured;

    const result = await executeDeployment({ engines, writes: w as never }, input);

    // The container deploy still runs (fakeHosting is wired) and records no
    // builder handle, because there is no builder to record.
    expect(result.buildProviderResourceId).toBeNull();
    expect(result.buildProvider).toBeNull();
    expect(recorded).toEqual([]);
    void order;
  });
});
