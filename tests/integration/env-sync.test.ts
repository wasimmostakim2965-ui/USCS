/**
 * The worker's environment reconciliation.
 *
 * A customer can save a variable before their project has an application — they
 * configure the project, then deploy. The API stores it and says so honestly;
 * `buildEnvVarSync` is the step that pushes it once the application exists, and
 * it runs before the build so a pre-deploy variable is part of the first build.
 *
 * The properties a test must pin, because a blind writer or a swallow-the-error
 * version would both look green:
 *
 *   * a stored variable reaches the engine as a *create* the first time and an
 *     *update* the next, matching Coolify's two routes;
 *   * a variable the platform did not create (an engine default) is left alone,
 *     because the reconciler owns only the keys it knows about;
 *   * a row that will not decrypt is skipped rather than written as garbage;
 *   * the engine handle from the adapter is recorded so a later delete can
 *     address the variable;
 *   * no cipher means no sync contract at all — a null, not a silent no-op.
 */
import { describe, expect, it } from "vitest";
import { createSecretCipher, type SecretCipher } from "@cloud-wai/auth";
import { fakeHosting, type HostingAdapter } from "@cloud-wai/adapters";
import { buildEnvVarSync, type EnvSyncStore } from "@cloud-wai/worker";
import type { AdapterContext, OrganizationId, ProviderRef } from "@cloud-wai/contracts";

const ORG_A = "org-a" as OrganizationId;

const CIPHER: SecretCipher = createSecretCipher(Buffer.alloc(32, 9).toString("base64"))!;

const ctx: AdapterContext = {
  organizationId: ORG_A,
  idempotencyKey: "deploy-1",
  timeoutMs: 100,
};

interface StoredVariable {
  readonly key: string;
  readonly valueEncrypted: string;
  readonly isBuildTime: boolean;
}

/** A store that records what the sync wrote back, and no more than it needs. */
function makeStore(stored: readonly StoredVariable[]) {
  const refs: {
    organizationId: OrganizationId;
    projectId: string;
    key: string;
    engineRef: string;
  }[] = [];
  const store: EnvSyncStore = {
    async listEnvVarsForService() {
      return stored;
    },
    async setEnvVarEngineRef(input) {
      refs.push({
        organizationId: input.organizationId,
        projectId: input.projectId,
        key: input.key,
        engineRef: input.engineRef,
      });
      return null;
    },
  };
  return { store, refs };
}

/** A hosting engine with a real application, so a write has somewhere to land. */
async function provisionedHosting(): Promise<{ hosting: HostingAdapter; ref: ProviderRef }> {
  const hosting = fakeHosting();
  const created = await hosting.createApplication(ctx, { name: "alpha" });
  if (!created.ok) throw new Error("the fake engine refused to create the application");
  return { hosting, ref: created.value.providerRef };
}

function variable(key: string, value: string, isBuildTime = true): StoredVariable {
  return { key, valueEncrypted: CIPHER.encrypt(value), isBuildTime };
}

describe("the worker environment reconciler", () => {
  it("is null when there is no cipher, rather than a silent no-op", () => {
    const { store } = makeStore([]);
    expect(buildEnvVarSync({ hosting: fakeHosting(), store, cipher: null })).toBeNull();
  });

  it("creates a stored variable on the engine and records the engine handle", async () => {
    const { hosting, ref } = await provisionedHosting();
    const { store, refs } = makeStore([variable("DATABASE_URL", "postgres://secret")]);
    const sync = buildEnvVarSync({ hosting, store, cipher: CIPHER })!;

    await sync.sync(ctx, ref, "proj-a");

    const landed = await hosting.listEnvVars(ctx, ref);
    expect(landed.ok).toBe(true);
    if (landed.ok) {
      expect(landed.value.map((v) => v.key)).toEqual(["DATABASE_URL"]);
      expect(landed.value[0]!.value).toBe("postgres://secret");
    }
    // The handle the engine issued is what a later delete addresses.
    expect(refs).toEqual([
      { organizationId: ORG_A, projectId: "proj-a", key: "DATABASE_URL", engineRef: "env-DATABASE_URL" },
    ]);
  });

  it("updates rather than recreating a variable the engine already has", async () => {
    const { hosting, ref } = await provisionedHosting();
    // Seed the engine with the same key at an older value, as though a prior
    // deploy created it.
    await hosting.createEnvVar(ctx, {
      applicationRef: ref,
      variable: { key: "DATABASE_URL", value: "postgres://old", isBuildTime: true },
    });
    const { store } = makeStore([variable("DATABASE_URL", "postgres://new")]);
    const sync = buildEnvVarSync({ hosting, store, cipher: CIPHER })!;

    await sync.sync(ctx, ref, "proj-a");

    const landed = await hosting.listEnvVars(ctx, ref);
    expect(landed.ok).toBe(true);
    if (landed.ok) {
      expect(landed.value).toHaveLength(1);
      expect(landed.value[0]!.value).toBe("postgres://new");
    }
  });

  it("leaves an engine variable the platform did not create alone", async () => {
    const { hosting, ref } = await provisionedHosting();
    // An engine default, not a Cloud Wai row: it must survive reconciliation.
    await hosting.createEnvVar(ctx, {
      applicationRef: ref,
      variable: { key: "COOLIFY_DEFAULT", value: "keep-me", isBuildTime: false },
    });
    const { store } = makeStore([variable("DATABASE_URL", "postgres://secret")]);
    const sync = buildEnvVarSync({ hosting, store, cipher: CIPHER })!;

    await sync.sync(ctx, ref, "proj-a");

    const landed = await hosting.listEnvVars(ctx, ref);
    expect(landed.ok).toBe(true);
    if (landed.ok) {
      const byKey = new Map(landed.value.map((v) => [v.key, v.value]));
      expect(byKey.get("COOLIFY_DEFAULT")).toBe("keep-me");
      expect(byKey.get("DATABASE_URL")).toBe("postgres://secret");
    }
  });

  it("skips a row that will not decrypt instead of writing garbage", async () => {
    const { hosting, ref } = await provisionedHosting();
    const { store } = makeStore([
      { key: "TAMPERED", valueEncrypted: "v1:not-a-real-envelope", isBuildTime: true },
      variable("GOOD", "fine"),
    ]);
    const sync = buildEnvVarSync({ hosting, store, cipher: CIPHER })!;

    await sync.sync(ctx, ref, "proj-a");

    const landed = await hosting.listEnvVars(ctx, ref);
    expect(landed.ok).toBe(true);
    if (landed.ok) {
      expect(landed.value.map((v) => v.key)).toEqual(["GOOD"]);
    }
  });

  it("does nothing when the project has no stored variables", async () => {
    const { hosting, ref } = await provisionedHosting();
    const { store, refs } = makeStore([]);
    const sync = buildEnvVarSync({ hosting, store, cipher: CIPHER })!;

    await sync.sync(ctx, ref, "proj-a");

    const landed = await hosting.listEnvVars(ctx, ref);
    expect(landed.ok).toBe(true);
    if (landed.ok) expect(landed.value).toHaveLength(0);
    expect(refs).toHaveLength(0);
  });

  it("does not blind-write when the engine cannot even be listed", async () => {
    const failing = fakeHosting({ behaviour: "failed" });
    const { store, refs } = makeStore([variable("DATABASE_URL", "postgres://secret")]);
    const sync = buildEnvVarSync({ hosting: failing, store, cipher: CIPHER })!;

    // A listing that fails means the engine is unreachable; the sync must not
    // guess and push. The stored row is already safe in the table.
    await expect(
      sync.sync(ctx, { organizationId: ORG_A, provider: "coolify", resourceType: "application", resourceId: "app-1" }, "proj-a"),
    ).resolves.toBeUndefined();
    expect(refs).toHaveLength(0);
  });
});
