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
  HostingAdapter,
  LogPage,
  SecurityEdgeAdapter,
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

/** A working in-memory hosting engine, for tests and local development. */
export function fakeHosting(options: FakeEngineOptions = {}): HostingAdapter {
  const engine: ProviderName = "coolify";
  const label = options.engine ?? "fake-hosting";
  const behaviour = options.behaviour ?? "succeeded";
  const delay = options.delayMs ?? 0;
  const applications = new Map<
    string,
    { name: string; deployment: DeploymentState; logs: string[] }
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

  return {
    createApplication: (ctx, input) =>
      gate(() => {
        const key = ctxKey(ctx);
        applications.set(key, {
          name: input.name,
          deployment: { ref: appRef(ctx), status: "pending", url: null },
          logs: [`created application ${input.name}`],
        });
        return ok("succeeded", operationRef(engine, key, ctx.organizationId, "application"));
      }),

    deploy: (ctx, input) =>
      gate(() => {
        const key = ctxKey(ctx);
        const app = applications.get(key) ?? {
          name: String(input.applicationRef.resourceId),
          deployment: { ref: input.applicationRef, status: "pending" as const, url: null },
          logs: [],
        };
        app.deployment = {
          ref: input.applicationRef,
          status: "succeeded",
          url: `https://${key}.fake.cloud-wai.test`,
        };
        app.logs.push("deployed");
        applications.set(key, app);
        return ok("succeeded", operationRef(engine, key, ctx.organizationId, "deployment"));
      }),

    getDeployment: (ctx, ref) =>
      gate(() => {
        const app = applications.get(ctxKey(ctx));
        return ok("succeeded", app?.deployment ?? { ref, status: "pending", url: null });
      }),

    cancelDeployment: (ctx) =>
      gate(() => {
        const app = applications.get(ctxKey(ctx));
        if (app) app.deployment = { ...app.deployment, status: "failed" };
        return ok("succeeded", undefined);
      }),

    rollback: (ctx) =>
      gate(() => {
        const key = ctxKey(ctx);
        // A real engine answers a rollback with a queued deployment, and a later
        // read of that deployment reports its state. The fake records the state
        // too, so a caller that reads back after rolling back gets the same shape
        // of answer it would get from Coolify instead of a fabricated "pending".
        const app = applications.get(key);
        applications.set(key, {
          name: app?.name ?? "application",
          deployment: {
            ref: refFor(engine, key, ctx.organizationId, "application"),
            status: "succeeded",
            url: app?.deployment.url ?? `https://${key}.fake.cloud-wai.test`,
          },
          logs: [...(app?.logs ?? []), "rolled back"],
        });
        return ok("succeeded", operationRef(engine, key, ctx.organizationId, "deployment"));
      }),

    getLogs: (ctx, _ref, _cursor): Promise<AdapterResult<LogPage>> =>
      gate(() =>
        ok("succeeded", { lines: applications.get(ctxKey(ctx))?.logs ?? [], cursor: null }),
      ),

    deleteApplication: (ctx) =>
      gate(() => {
        applications.delete(ctxKey(ctx));
        return ok("succeeded", undefined);
      }),

    reconcile: (ctx, ref) =>
      gate(() => {
        const app = applications.get(ctxKey(ctx));
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

    rotateCredentials: (ctx) =>
      gate(() =>
        created.has(ctx.idempotencyKey)
          ? ok("succeeded", undefined)
          : err("not_configured", `${label} has no database for ${ctx.idempotencyKey}.`),
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
