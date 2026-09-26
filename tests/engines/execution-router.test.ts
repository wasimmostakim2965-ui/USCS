/**
 * The execution router: a project's execution model picks its engine.
 *
 * The invariants here are the architectural ones from ADR-0017, and they are
 * pinned as behaviour rather than left to a comment:
 *
 *   * a `serverless` project never reaches the container engine, and
 *   * an unconfigured serverless engine reports `not_configured`, never a
 *     Coolify build dressed up as a serverless success.
 *
 * If either regresses, a customer's serverless project would silently be built
 * as a container and the platform would call that a deployment.
 */
import { describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "@cloud-wai/contracts";
import {
  containerDeploymentEngine,
  deploymentEngineFor,
  fakeHosting,
  fakeServerless,
  hostingNotConfigured,
  serverlessNotConfigured,
} from "@cloud-wai/adapters";

const ORG = "org-a" as AdapterContext["organizationId"];
const ctx: AdapterContext = { organizationId: ORG, idempotencyKey: "k", timeoutMs: 1000 };
const ref = {
  organizationId: ORG,
  provider: "lambda" as const,
  resourceType: "function",
  resourceId: "fn-1",
};

describe("deploymentEngineFor", () => {
  it("routes a container project to the container engine", () => {
    const engine = deploymentEngineFor(
      { hosting: fakeHosting(), serverless: serverlessNotConfigured("lambda") },
      "container",
    );
    expect(engine.model).toBe("container");
  });

  it("routes a serverless project to the serverless engine", () => {
    const engine = deploymentEngineFor(
      { hosting: fakeHosting(), serverless: fakeServerless() },
      "serverless",
    );
    expect(engine.model).toBe("serverless");
  });

  it("never hands a serverless project to the container engine", async () => {
    // A container engine that would record any call, to prove none arrives.
    const hosting = fakeHosting();
    const createSpy = vi.spyOn(hosting, "createApplication");
    const engine = deploymentEngineFor(
      { hosting, serverless: serverlessNotConfigured("lambda", "Set AWS credentials.") },
      "serverless",
    );

    const result = await engine.ensureTarget(ctx, {
      name: "proj",
      gitRepository: "https://github.com/acme/app",
      gitBranch: "main",
      buildPack: "nixpacks",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("reports the engine's own reason when serverless is unconfigured", async () => {
    const engine = deploymentEngineFor(
      {
        hosting: fakeHosting(),
        serverless: serverlessNotConfigured("lambda", "Set AWS credentials."),
      },
      "serverless",
    );
    const result = await engine.deploy(ctx, ref);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("not_configured");
      expect(result.reason).toContain("Set AWS credentials.");
    }
  });

  it("gives a container project the not-configured reason when the container engine is absent", async () => {
    const engine = deploymentEngineFor(
      {
        hosting: hostingNotConfigured("coolify", "Set COOLIFY_URL."),
        serverless: fakeServerless(),
      },
      "container",
    );
    const result = await engine.deploy(ctx, ref);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });
});

describe("serverless port honesty", () => {
  it("refuses a deploy with no artifact rather than publishing nothing", async () => {
    const engine = deploymentEngineFor(
      { hosting: fakeHosting(), serverless: fakeServerless() },
      "serverless",
    );
    const result = await engine.deploy(ctx, ref);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("not_configured");
      expect(result.reason).toMatch(/artifact/i);
    }
  });

  it("refuses rollback and cancel, which are container operations", async () => {
    const engine = deploymentEngineFor(
      { hosting: fakeHosting(), serverless: fakeServerless() },
      "serverless",
    );
    const rolled = await engine.rollback(ctx, { ref, commit: "abc123" });
    const cancelled = await engine.cancel(ctx, ref);
    expect(rolled.ok).toBe(false);
    expect(cancelled.ok).toBe(false);
    if (!rolled.ok) expect(rolled.reason).toMatch(/no rollback/i);
    if (!cancelled.ok) expect(cancelled.reason).toMatch(/no cancel/i);
  });

  it("performs a deploy when it is given an artifact", async () => {
    const engine = deploymentEngineFor(
      { hosting: fakeHosting(), serverless: fakeServerless() },
      "serverless",
    );
    const result = await engine.deploy(ctx, ref, { kind: "s3", bucket: "b", key: "k.zip" });
    expect(result.ok).toBe(true);
  });
});

describe("container port", () => {
  it("refuses a rollback with no commit", async () => {
    const engine = containerDeploymentEngine(fakeHosting());
    const result = await engine.rollback(ctx, { ref, commit: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });

  it("ignores a serverless artifact", async () => {
    const engine = containerDeploymentEngine(fakeHosting());
    const result = await engine.deploy(ctx, ref, { kind: "s3", bucket: "b", key: "k.zip" });
    // The container engine builds from git; the artifact is not its business.
    expect(result.ok).toBe(true);
  });
});
