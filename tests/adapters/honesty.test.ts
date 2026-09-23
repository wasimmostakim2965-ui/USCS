/**
 * Adapter honesty: an engine that is not configured must never look successful,
 * and a slow engine must not hang the caller.
 */
import { describe, expect, it } from "vitest";
import { isSuccess } from "@cloud-wai/contracts";
import type { AdapterContext, ProviderRef } from "@cloud-wai/contracts";
import {
  databaseNotConfigured,
  fakeDatabase,
  fakeHosting,
  guarded,
  hostingNotConfigured,
  notConfigured,
  securityNotConfigured,
  storageNotConfigured,
  withTimeout,
} from "@cloud-wai/adapters";

const org = "org-a" as AdapterContext["organizationId"];

function ctx(key: string, timeoutMs = 1_000): AdapterContext {
  return { organizationId: org, idempotencyKey: key, timeoutMs };
}

const APP_REF = {
  organizationId: org,
  provider: "coolify",
  resourceType: "application",
  resourceId: "app-1",
} as ProviderRef;

describe("unconfigured engines report not_configured", () => {
  it("hosting", async () => {
    const adapter = hostingNotConfigured("coolify", "Set COOLIFY_URL and COOLIFY_TOKEN.");
    const result = await adapter.deploy(ctx("k1"), { applicationRef: APP_REF });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("not_configured");
    expect(result.reason).toContain("COOLIFY_URL");
    expect(isSuccess(result.status)).toBe(false);
  });

  it("every hosting operation is honest, not just deploy", async () => {
    const adapter = hostingNotConfigured("coolify");
    const ref = APP_REF;
    const calls = [
      adapter.createApplication(ctx("k"), {
        name: "n",
        gitRepository: "https://github.com/example/n",
        gitBranch: "main",
      }),
      adapter.deploy(ctx("k"), { applicationRef: ref }),
      adapter.getDeployment(ctx("k"), ref),
      adapter.cancelDeployment(ctx("k"), ref),
      adapter.rollback(ctx("k"), { applicationRef: ref, commit: "abc123" }),
      adapter.getLogs(ctx("k"), ref),
      adapter.deleteApplication(ctx("k"), ref),
      adapter.reconcile(ctx("k"), ref),
    ];
    for (const result of await Promise.all(calls)) {
      expect(result.ok).toBe(false);
      expect(result.status).toBe("not_configured");
    }
  });

  it("database", async () => {
    const result = await databaseNotConfigured("postgres").provision(ctx("k"), { name: "db" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });

  it("storage", async () => {
    const result = await storageNotConfigured("minio").createBucket(ctx("k"), { name: "b" });
    expect(result.ok).toBe(false);
  });

  it("security edge", async () => {
    const result = await securityNotConfigured("envoy").inspectHealth(ctx("k"), {
      ref: { organizationId: org, provider: "envoy", resourceType: "route", resourceId: "r" },
    });
    expect(result.ok).toBe(false);
  });

  it("the helper never reports success", () => {
    const result = notConfigured<number>("coolify");
    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_configured");
  });
});

describe("a configured fake engine behaves", () => {
  it("creates and deploys, then reads back the state", async () => {
    const adapter = fakeHosting();
    const created = await adapter.createApplication(ctx("alpha"), { name: "Alpha" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const deployed = await adapter.deploy(ctx("alpha"), {
      applicationRef: created.value.providerRef,
    });
    expect(deployed.ok).toBe(true);

    const state = await adapter.getDeployment(ctx("alpha"), created.value.providerRef);
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.value.status).toBe("succeeded");
  });

  it("carries the organization on every provider reference", async () => {
    const adapter = fakeHosting();
    const result = await adapter.createApplication(ctx("alpha"), { name: "Alpha" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The tenant is never inferred from the engine's own identifier.
      expect(result.value.providerRef.organizationId).toBe(org);
    }
  });

  it("reconciles an unknown application as not_configured, not success", async () => {
    const adapter = fakeHosting();
    const ref = {
      organizationId: org,
      provider: "coolify",
      resourceType: "application",
      resourceId: "never-created",
    } as ProviderRef;
    const result = await adapter.reconcile(ctx("never-created"), ref);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });

  it("surfaces a refusal as failed", async () => {
    const adapter = fakeHosting({ behaviour: "failed" });
    const result = await adapter.createApplication(ctx("k"), { name: "n" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("failed");
  });

  it("surfaces an unhealthy engine as degraded", async () => {
    const adapter = fakeHosting({ behaviour: "degraded" });
    const result = await adapter.createApplication(ctx("k"), { name: "n" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("degraded");
  });

  it("backs up and restores a database, and refuses an unknown backup", async () => {
    const adapter = fakeDatabase();
    const db = await adapter.provision(ctx("beta"), { name: "beta-db" });
    expect(db.ok).toBe(true);
    if (!db.ok) throw new Error("unreachable");

    const backup = await adapter.backup(ctx("beta"), db.value);
    expect(backup.ok).toBe(true);
    if (!backup.ok) throw new Error("unreachable");

    const restored = await adapter.restore(ctx("beta"), {
      backupRef: backup.value,
      targetRef: db.value,
    });
    expect(restored.ok).toBe(true);

    const foreign = await adapter.restore(ctx("beta"), {
      backupRef: {
        organizationId: "org-b" as AdapterContext["organizationId"],
        provider: "postgres",
        resourceType: "backup",
        resourceId: "someone-elses",
      },
      targetRef: db.value,
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.status).toBe("not_configured");
  });
});

describe("timeouts and error containment", () => {
  it("bounds a slow engine call and aborts it", async () => {
    await expect(
      withTimeout("deploy", 10, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return "too late";
      }),
    ).rejects.toThrow(/exceeded 10ms/);
  });

  it("turns a thrown engine error into a failed AdapterResult", async () => {
    const result = await guarded<string>("deploy", 100, async () => {
      throw new Error("ECONNREFUSED 10.0.0.5:8000");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });

  it("never upgrades a timeout into success", async () => {
    const result = await guarded<string>("deploy", 10, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "late";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(isSuccess(result.status)).toBe(false);
  });
});
