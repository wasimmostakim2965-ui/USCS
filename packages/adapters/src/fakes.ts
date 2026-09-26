/**
 * Deterministic in-memory engines.
 *
 * These implement the same adapter contracts as the real engines and make the
 * five states reachable in tests without a network: a fake can succeed, fail,
 * run slowly, be left unconfigured, or report `degraded`. They are NOT a stand-in
 * for the real engines in production — `notConfiguredEngine()` is what a
 * deployment without credentials actually wires up.
 */
import {
  err,
  ok,
  type AdapterResult,
  type OperationRef,
  type OrganizationId,
  type ProviderName,
  type ProviderRef,
} from "@cloud-wai/contracts";
import type {
  AdapterContext,
  DatabaseAdapter,
  DeploymentState,
  DomainVerifier,
  EnvVarState,
  HostingAdapter,
  LogPage,
  SecurityEdgeAdapter,
  ServerlessAdapter,
  StorageAdapter,
} from "./index.js";

/**
 * Build a provider reference. The tenant is carried alongside the engine's own
 * id so a response can never be mistaken for a tenant boundary on its own.
 */
function providerRef(
  organizationId: OrganizationId,
  provider: ProviderName,
  resourceType: string,
  resourceId: string,
): ProviderRef {
  return { organizationId, provider, resourceType, resourceId };
}

export interface FakeEngineOptions {
  readonly engine?: string;
  /** Force every call to this status. `succeeded` performs the real transition. */
  readonly behaviour?: "succeeded" | "failed" | "degraded" | "not_configured" | "timeout";
  /** Delay applied per call, to exercise timeout handling. */
  readonly delayMs?: number;
}

function refFor(
  engine: ProviderName,
  key: string,
  organizationId: OrganizationId,
  resourceType: string,
): ProviderRef {
  return providerRef(organizationId, engine, resourceType, key);
}

function operationRef(
  engine: ProviderName,
  key: string,
  organizationId: OrganizationId,
  resourceType: string,
): OperationRef {
  return {
    jobId: `job-${engine}-${key}` as OperationRef["jobId"],
    providerRef: refFor(engine, key, organizationId, resourceType),
  };
}

/** An adapter for an engine that this deployment has no credentials for. */
export function hostingNotConfigured(engine: string, hint?: string): HostingAdapter {
  const miss = <T>(): Promise<AdapterResult<T>> =>
    Promise.resolve(
      err(
        "not_configured",
        `${engine} is not configured in this deployment.${hint ? ` ${hint}` : ""}`,
      ),
    );
  return {
    __notConfigured: true as const,
    createApplication: miss,
    deploy: miss,
    getDeployment: miss,
    cancelDeployment: miss,
    rollback: miss,
    getLogs: miss,
    listEnvVars: miss,
    createEnvVar: miss,
    updateEnvVar: miss,
    deleteEnvVar: miss,
    deleteApplication: miss,
    reconcile: miss,
  };
}

export function databaseNotConfigured(engine: string, hint?: string): DatabaseAdapter {
  const miss = <T>(): Promise<AdapterResult<T>> =>
    Promise.resolve(
      err(
        "not_configured",
        `${engine} is not configured in this deployment.${hint ? ` ${hint}` : ""}`,
      ),
    );
  return {
    __notConfigured: true as const,
    provision: miss,
    rotateCredentials: miss,
    backup: miss,
    restore: miss,
    destroy: miss,
  };
}

export function storageNotConfigured(engine: string, hint?: string): StorageAdapter {
  const miss = <T>(): Promise<AdapterResult<T>> =>
    Promise.resolve(
      err(
        "not_configured",
        `${engine} is not configured in this deployment.${hint ? ` ${hint}` : ""}`,
      ),
    );
  return { __notConfigured: true as const, createBucket: miss, deleteBucket: miss };
}

/**
 * The honest serverless engine for a deployment with no AWS credentials.
 *
 * It exists so that a project whose provider is `lambda` reports
 * `not_configured` rather than falling through to the container engine, which
 * would deploy the wrong execution model and call it success.
 */
export function serverlessNotConfigured(engine: string, hint?: string): ServerlessAdapter {
  const miss = <T>(): Promise<AdapterResult<T>> =>
    Promise.resolve(
      err(
        "not_configured",
        `${engine} is not configured in this deployment.${hint ? ` ${hint}` : ""}`,
      ),
    );
  return {
    __notConfigured: true as const,
    createFunction: miss,
    deploy: miss,
    getDeployment: miss,
    deleteFunction: miss,
    getLogs: miss,
  };
}

export function securityNotConfigured(engine: string, hint?: string): SecurityEdgeAdapter {
  const miss = <T>(): Promise<AdapterResult<T>> =>
    Promise.resolve(
      err(
        "not_configured",
        `${engine} is not configured in this deployment.${hint ? ` ${hint}` : ""}`,
      ),
    );
  return {
    __notConfigured: true as const,
    publishRoute: miss,
    removeRoute: miss,
    applyPolicy: miss,
    quarantine: miss,
    inspectHealth: miss,
  };
}

/**
 * A working in-memory domain verifier, for tests and local development.
 *
 * By default every hostname is *unverified*: the honest default, because a fake
 * that confirmed everything would let a test pass a check production does not.
 * A test that wants a confirmation opts in with `verifiedHostnames`.
 */
export function fakeDomainVerifier(
  options: {
    readonly verifiedHostnames?: readonly string[];
    readonly behaviour?: "succeeded" | "degraded" | "not_configured";
  } = {},
): DomainVerifier {
  const verified = new Set((options.verifiedHostnames ?? []).map((h) => h.toLowerCase()));
  return {
    async resolveDomainVerification(_ctx, input) {
      if (options.behaviour === "not_configured") {
        return err("not_configured", "The domain verifier is not configured in this deployment.");
      }
      if (options.behaviour === "degraded") {
        return err("degraded", "The DNS lookup did not complete.");
      }
      const hostname = input.hostname.toLowerCase();
      const isVerified = verified.has(hostname);
      return ok("succeeded", {
        hostname,
        verified: isVerified,
        provider: "dns",
        providerResourceId: isVerified ? `fake/${hostname}` : null,
        detail: isVerified
          ? "The fake verifier confirms this hostname."
          : "The fake verifier does not confirm this hostname.",
      });
    },
  };
}

/**
 * A working in-memory serverless engine, for tests and local development.
 *
 * It models the two facts the real adapter enforces: a deploy with no built
 * artifact is refused (Lambda does not build from git), and a function resolves
 * by its own `resourceId` so a later deploy meets the function the control plane
 * stored, not the caller's key.
 */
export function fakeServerless(options: FakeEngineOptions = {}): ServerlessAdapter {
  const engine: ProviderName = "lambda";
  const label = options.engine ?? "fake-serverless";
  const behaviour = options.behaviour ?? "succeeded";
  const delay = options.delayMs ?? 0;
  const functions = new Map<string, { deployment: DeploymentState; logs: string[] }>();

  const gate = async <T>(compute: () => AdapterResult<T>): Promise<AdapterResult<T>> => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (behaviour === "not_configured") {
      return err("not_configured", `${label} is not configured in this deployment.`);
    }
    if (behaviour === "failed") return err("failed", `${label} refused the operation.`);
    if (behaviour === "degraded") return err("degraded", `${label} is reachable but unhealthy.`);
    return compute();
  };

  return {
    createFunction: (ctx, input) =>
      gate(() => {
        if (!input.artifact) {
          return err(
            "failed",
            "A serverless deploy needs a built artifact; Lambda does not build from git.",
          );
        }
        const created = operationRef(engine, ctx.idempotencyKey, ctx.organizationId, "function");
        functions.set(created.providerRef.resourceId, {
          deployment: {
            ref: created.providerRef,
            status: "succeeded",
            url: `https://${input.name}.lambda-url.fake/`,
          },
          logs: [`created function ${input.name}`],
        });
        return ok("succeeded", created);
      }),

    deploy: (ctx, input) =>
      gate(() => {
        if (!input.artifact) {
          return err(
            "failed",
            "A serverless deploy needs a built artifact; Lambda does not build from git.",
          );
        }
        const existing = functions.get(input.functionRef.resourceId);
        const ref = existing
          ? existing.deployment.ref
          : refFor(engine, input.functionRef.resourceId, ctx.organizationId, "function");
        functions.set(ref.resourceId, {
          deployment: { ref, status: "succeeded", url: existing?.deployment.url ?? null },
          logs: [...(existing?.logs ?? []), `deployed ${ref.resourceId}`],
        });
        return ok("succeeded", {
          jobId: `lambda-function-${ref.resourceId}` as OperationRef["jobId"],
          providerRef: ref,
        });
      }),

    getDeployment: (_ctx, ref) =>
      gate(() => {
        const found = functions.get(ref.resourceId);
        return ok("succeeded", found?.deployment ?? { ref, status: "pending", url: null });
      }),

    deleteFunction: (_ctx, ref) =>
      gate(() => {
        functions.delete(ref.resourceId);
        return ok("succeeded", undefined);
      }),

    getLogs: (_ctx, ref) =>
      gate(() => {
        const found = functions.get(ref.resourceId);
        return ok("succeeded", { lines: found?.logs ?? [], cursor: null });
      }),
  };
}

/** A working in-memory hosting engine, for tests and local development. */
export function fakeHosting(options: FakeEngineOptions = {}): HostingAdapter {
  const engine: ProviderName = "coolify";
  const label = options.engine ?? "fake-hosting";
  const behaviour = options.behaviour ?? "succeeded";
  const delay = options.delayMs ?? 0;
  const applications = new Map<
    string,
    {
      name: string;
      deployment: DeploymentState;
      logs: string[];
      env: Map<string, EnvVarState>;
    }
  >();

  const gate = async <T>(compute: () => AdapterResult<T>): Promise<AdapterResult<T>> => {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (behaviour === "not_configured") {
      return err("not_configured", `${label} is not configured in this deployment.`);
    }
    if (behaviour === "failed") return err("failed", `${label} refused the operation.`);
    if (behaviour === "degraded") return err("degraded", `${label} is reachable but unhealthy.`);
    return compute();
  };

  const ctxKey = (ctx: AdapterContext) => ctx.idempotencyKey;
  const appRef = (ctx: AdapterContext) =>
    refFor(engine, ctx.idempotencyKey, ctx.organizationId, "application");

  /**
   * Resolve an application the way the real Coolify adapter does: by the
   * engine's own `resourceId`, not the caller's idempotency key.
   *
   * A deploy and a later env write are separate calls with different idempotency
   * keys, so they can only meet on the application's `resourceId` — the handle
   * the control plane stored when the application was created. A fake that
   * keyed by idempotency key would let a cross-call write pass that Coolify
   * would 404, which is precisely the bug this fidelity prevents. The
   * idempotency key is the fallback only for the same call that created it.
   */
  const resolve = (ctx: AdapterContext, ref: { readonly resourceId: string }) =>
    applications.get(ref.resourceId) ?? applications.get(ctxKey(ctx));

  return {
    createApplication: (ctx, input) =>
      gate(() => {
        const key = ctxKey(ctx);
        const created = operationRef(engine, key, ctx.organizationId, "application");
        // Indexed by the engine's own resourceId, so a later call that only has
        // the stored handle can find it — the way Coolify's uuid works.
        applications.set(created.providerRef.resourceId, {
          name: input.name,
          deployment: { ref: created.providerRef, status: "pending", url: null },
          logs: [`created application ${input.name}`],
          env: new Map<string, EnvVarState>(),
        });
        return ok("succeeded", created);
      }),

    deploy: (ctx, input) =>
      gate(() => {
        const key = ctxKey(ctx);
        const app = resolve(ctx, input.applicationRef) ?? {
          name: String(input.applicationRef.resourceId),
          deployment: { ref: input.applicationRef, status: "pending" as const, url: null },
          logs: [],
          env: new Map<string, EnvVarState>(),
        };
        app.deployment = {
          ref: input.applicationRef,
          status: "succeeded",
          url: `https://${key}.fake.cloud-wai.test`,
        };
        app.logs.push("deployed");
        applications.set(input.applicationRef.resourceId, app);
        return ok("succeeded", operationRef(engine, key, ctx.organizationId, "deployment"));
      }),

    getDeployment: (ctx, ref) =>
      gate(() => {
        const app = applications.get(ref.resourceId);
        return ok("succeeded", app?.deployment ?? { ref, status: "pending", url: null });
      }),

    cancelDeployment: (ctx, ref) =>
      gate(() => {
        const app = applications.get(ref.resourceId);
        if (app) app.deployment = { ...app.deployment, status: "failed" };
        return ok("succeeded", undefined);
      }),

    rollback: (ctx, input) =>
      gate(() => {
        const key = ctxKey(ctx);
        // A real engine answers a rollback with a queued deployment, and a later
        // read of that deployment reports its state. The fake records the state
        // too, so a caller that reads back after rolling back gets the same shape
        // of answer it would get from Coolify instead of a fabricated "pending".
        const app = resolve(ctx, input.applicationRef);
        const deploymentRef = refFor(engine, key, ctx.organizationId, "deployment");
        applications.set(input.applicationRef.resourceId, {
          name: app?.name ?? "application",
          deployment: {
            ref: input.applicationRef,
            status: "succeeded",
            url: app?.deployment.url ?? `https://${key}.fake.cloud-wai.test`,
          },
          logs: [...(app?.logs ?? []), "rolled back"],
          env: app?.env ?? new Map<string, EnvVarState>(),
        });
        // Coolify answers a rollback with the *application* handle when it has
        // no deployment uuid to give (see the real adapter), so the caller can
        // read the state back through the handle it already holds.
        return ok("succeeded", {
          jobId: deploymentRef.resourceId,
          providerRef: input.applicationRef,
        });
      }),

    getLogs: (ctx, ref, _cursor): Promise<AdapterResult<LogPage>> =>
      gate(() =>
        ok("succeeded", { lines: applications.get(ref.resourceId)?.logs ?? [], cursor: null }),
      ),

    listEnvVars: (ctx, ref) =>
      gate(() => {
        const app = resolve(ctx, ref);
        return ok("succeeded", [...(app?.env.values() ?? [])]);
      }),

    createEnvVar: (ctx, input) =>
      gate(() => {
        const app = resolve(ctx, input.applicationRef);
        if (!app) return err("not_configured", `${label} has no application for this deploy.`);
        const state: EnvVarState = {
          key: input.variable.key,
          value: input.variable.value,
          isBuildTime: input.variable.isBuildTime ?? true,
          engineRef: `env-${input.variable.key}`,
        };
        app.env.set(input.variable.key, state);
        return ok("succeeded", state);
      }),

    updateEnvVar: (ctx, input) =>
      gate(() => {
        const app = resolve(ctx, input.applicationRef);
        if (!app) return err("not_configured", `${label} has no application for this deploy.`);
        const existing = app.env.get(input.variable.key);
        // An update of a variable that does not exist is a refusal, not an
        // upsert: the engine would 404, and inventing the row would hide that.
        if (!existing) {
          return err("failed", `${label} has no environment variable ${input.variable.key}.`);
        }
        const state: EnvVarState = {
          ...existing,
          value: input.variable.value,
          isBuildTime: input.variable.isBuildTime ?? existing.isBuildTime,
        };
        app.env.set(input.variable.key, state);
        return ok("succeeded", state);
      }),

    deleteEnvVar: (ctx, input) =>
      gate(() => {
        const app = resolve(ctx, input.applicationRef);
        if (!app) return err("not_configured", `${label} has no application for this deploy.`);
        for (const [key, state] of app.env) {
          if (state.engineRef === input.engineRef) {
            app.env.delete(key);
            return ok("succeeded", undefined);
          }
        }
        return err("failed", `${label} has no environment variable ${input.engineRef}.`);
      }),

    deleteApplication: (ctx, ref) =>
      gate(() => {
        applications.delete(ref.resourceId);
        return ok("succeeded", undefined);
      }),

    reconcile: (ctx, ref) =>
      gate(() => {
        const app = resolve(ctx, ref);
        // Reconciling an application we never created is honestly
        // `not_configured` for that ref, not a fabricated success.
        if (!app)
          return err("not_configured", `${label} has no application for ${ref.resourceId}.`);
        return ok("succeeded", app.deployment);
      }),
  };
}

/** A working in-memory database engine. */
export function fakeDatabase(options: FakeEngineOptions = {}): DatabaseAdapter {
  const engine: ProviderName = "postgres";
  const label = options.engine ?? "fake-database";
  const behaviour = options.behaviour ?? "succeeded";
  const created = new Map<string, ProviderRef>();
  const backups = new Map<string, ProviderRef>();

  const gate = async <T>(compute: () => AdapterResult<T>): Promise<AdapterResult<T>> => {
    if (behaviour === "not_configured") {
      return err("not_configured", `${label} is not configured in this deployment.`);
    }
    if (behaviour === "failed") return err("failed", `${label} refused the operation.`);
    if (behaviour === "degraded") return err("degraded", `${label} is reachable but unhealthy.`);
    return compute();
  };

  return {
    provision: (ctx, _input) =>
      gate(() => {
        const ref = refFor(engine, ctx.idempotencyKey, ctx.organizationId, "database");
        created.set(ctx.idempotencyKey, ref);
        return ok("succeeded", ref);
      }),

    rotateCredentials: (_ctx, ref) =>
      gate(() =>
        [...created.values()].some((c) => c.resourceId === ref.resourceId)
          ? ok("succeeded", undefined)
          : err("not_configured", `${label} has no database ${ref.resourceId}.`),
      ),

    backup: (ctx, ref) =>
      gate(() => {
        const backupRef = refFor(engine, ctx.idempotencyKey, ctx.organizationId, "backup");
        backups.set(`${backupRef.resourceId}`, ref);
        return ok("succeeded", backupRef);
      }),

    restore: (ctx, input) =>
      gate(() =>
        backups.has(input.backupRef.resourceId)
          ? ok("succeeded", operationRef(engine, ctx.idempotencyKey, ctx.organizationId, "restore"))
          : err("not_configured", `${label} has no backup ${input.backupRef.resourceId}.`),
      ),

    destroy: (ctx) =>
      gate(() => {
        created.delete(ctx.idempotencyKey);
        return ok("succeeded", undefined);
      }),
  };
}
