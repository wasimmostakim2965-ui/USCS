/**
 * The build engine port (ADR-0018).
 *
 * What is being defended here is not "a build runs". It is the two boundaries
 * that make the port safe to wire a serverless project to:
 *
 * 1. An unconfigured builder reports `not_configured` — it never fabricates an
 *    artifact, because a fabricated artifact would be deployed as if it were
 *    real code.
 * 2. "No artifact yet" and "no artifact ever" are different answers. A caller
 *    that cannot tell them apart would retry a finished failure forever, or
 *    treat a running build as a failed one.
 */
import { describe, expect, it } from "vitest";
import {
  buildEngines,
  buildNotConfigured,
  createRailpackBuildEngine,
  engineConfigFromEnv,
  engineReport,
  isConfigured,
} from "@cloud-wai/adapters";
import type { AdapterContext, ProviderRef } from "@cloud-wai/contracts";

const ORG_A = "org-a" as AdapterContext["organizationId"];

const ctx = (org: AdapterContext["organizationId"]): AdapterContext => ({
  organizationId: org,
  idempotencyKey: "build-key-1",
  timeoutMs: 100,
});

/** A fetch that answers with a scripted sequence, so no network is involved. */
function scriptedFetch(responses: readonly { status: number; body: unknown }[]): typeof fetch {
  let index = 0;
  return (async () => {
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function builder(responses: readonly { status: number; body: unknown }[]) {
  return createRailpackBuildEngine({
    credentials: () => ({ baseUrl: "https://builder.test", token: "tok" }),
    fetchImpl: scriptedFetch(responses),
  });
}

describe("build engine port", () => {
  it("reports not_configured when no builder is wired, and invents no artifact", async () => {
    const engines = buildEngines({});
    const started = await engines.build.build(ctx(ORG_A), {
      source: { kind: "git", repository: "https://github.com/x/y" },
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.status).toBe("not_configured");

    // The artifact read is the dangerous one: a stand-in that returned an empty
    // artifact would be deployed as if the build had succeeded.
    const artifact = await engines.build.getArtifact(ctx(ORG_A), {
      organizationId: ORG_A,
      provider: "railpack",
      resourceType: "build",
      resourceId: "b1",
    });
    expect(artifact.ok).toBe(false);
    if (!artifact.ok) expect(artifact.status).toBe("not_configured");
  });

  it("is reported as an unconfigured engine until builder credentials exist", () => {
    const absent = engineReport(buildEngines({})).find((r) => r.engine === "railpack");
    expect(absent?.configured).toBe(false);

    const present = engineReport(
      buildEngines({
        buildCredentials: { "org-a": { baseUrl: "https://builder.test", token: "tok" } },
      }),
    ).find((r) => r.engine === "railpack");
    expect(present?.configured).toBe(true);
    expect(isConfigured(buildNotConfigured("railpack"))).toBe(false);
  });

  it("reads per-organization builder credentials from the environment", () => {
    const config = engineConfigFromEnv({
      "BUILD_ENGINE_URL__org-a": "https://builder.test",
      "BUILD_ENGINE_TOKEN__org-a": "tok-a",
      // A URL without a token is not a usable builder, so it is dropped rather
      // than half-configured.
      "BUILD_ENGINE_URL__org-b": "https://builder-b.test",
      "BUILD_ENGINE_TOKEN__org-c": "tok-c",
    });
    expect(config.buildCredentials).toEqual({
      "org-a": { baseUrl: "https://builder.test", token: "tok-a" },
    });
  });

  it("refuses a git source with no repository rather than building nothing", async () => {
    const engine = builder([{ status: 202, body: { id: "b1" } }]);
    const result = await engine.build(ctx(ORG_A), {
      source: { kind: "git", repository: "   " },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("failed");
  });

  it("refuses a 2xx build response that names no build id", async () => {
    // A success that references nothing would be indistinguishable from a build
    // that never started, which is exactly the fake success the platform forbids.
    const engine = builder([{ status: 202, body: { status: "queued" } }]);
    const result = await engine.build(ctx(ORG_A), {
      source: { kind: "git", repository: "https://github.com/x/y" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("failed");
  });

  it("returns an artifact only once the build produced output", async () => {
    const engine = builder([
      {
        status: 200,
        body: {
          id: "b1",
          status: "succeeded",
          artifact: {
            image: "registry.test/app:abc",
            resolvedCommit: "abc123",
            framework: "nextjs",
          },
        },
      },
    ]);
    const result = await engine.getArtifact(ctx(ORG_A), {
      organizationId: ORG_A,
      provider: "railpack",
      resourceType: "build",
      resourceId: "b1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.image).toBe("registry.test/app:abc");
      expect(result.value.framework).toBe("nextjs");
      expect(result.value.resolvedCommit).toBe("abc123");
    }
  });

  it("distinguishes a running build from a finished build with no output", async () => {
    const running = builder([{ status: 200, body: { id: "b1", status: "running" } }]);
    const ref: ProviderRef = {
      organizationId: ORG_A,
      provider: "railpack",
      resourceType: "build",
      resourceId: "b1",
    };
    const whileRunning = await running.getArtifact(ctx(ORG_A), ref);
    expect(whileRunning.ok).toBe(false);
    if (!whileRunning.ok) expect(whileRunning.status).toBe("degraded");

    const finishedEmpty = builder([
      { status: 200, body: { id: "b1", status: "succeeded", artifact: {} } },
    ]);
    const afterFinish = await finishedEmpty.getArtifact(ctx(ORG_A), ref);
    expect(afterFinish.ok).toBe(false);
    if (!afterFinish.ok) expect(afterFinish.status).toBe("failed");
  });

  it("reports a framework the builder could not detect as null, not a guess", async () => {
    const engine = builder([
      {
        status: 200,
        body: { id: "b1", status: "succeeded", artifact: { image: "reg/app:1", framework: null } },
      },
    ]);
    const result = await engine.getArtifact(ctx(ORG_A), {
      organizationId: ORG_A,
      provider: "railpack",
      resourceType: "build",
      resourceId: "b1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.framework).toBeNull();
  });

  it("carries the tenant on every provider reference", async () => {
    const engine = builder([{ status: 202, body: { id: "b1" } }]);
    const result = await engine.build(ctx(ORG_A), {
      source: { kind: "git", repository: "https://github.com/x/y" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.providerRef.organizationId).toBe(ORG_A);
  });
});
