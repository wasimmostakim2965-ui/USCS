/**
 * The job kinds the worker knows, and the adapters behind them.
 *
 * An adapter is injected rather than constructed here so a deployment without
 * engine credentials wires up `hostingNotConfigured(...)` and the worker then
 * records `not_configured` — the UI shows that honestly instead of a fake green.
 */
import type { AdapterResult, ProviderRef } from "@cloud-wai/contracts";
import type { DatabaseAdapter, HostingAdapter } from "@cloud-wai/adapters";
import type { JobContext, JobHandler } from "./processor.js";

export const JOB_KINDS = [
  "deployment.create",
  "deployment.deploy",
  "deployment.rollback",
  "deployment.cancel",
  "data.provision",
  "data.backup",
  "data.restore",
  "data.destroy",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export interface WorkerEngines {
  readonly hosting: HostingAdapter;
  readonly database: DatabaseAdapter;
}

export interface CreateDeploymentPayload {
  readonly name: string;
  readonly projectSlug: string;
}

export interface DeployPayload {
  readonly applicationRef: ProviderRef;
}

export interface DataProvisionPayload {
  readonly name: string;
}

/**
 * Build the handler table.
 *
 * Every handler receives the payload and a context carrying the tenant and the
 * idempotency key, and returns the adapter's own result unmodified.
 */
export function buildHandlers(engines: WorkerEngines): Record<JobKind, JobHandler> {
  return {
    "deployment.create": (payload, ctx) =>
      engines.hosting.createApplication(
        {
          organizationId: ctx.organizationId as never,
          idempotencyKey: ctx.idempotencyKey,
          timeoutMs: ctx.timeoutMs,
        },
        { name: (payload as CreateDeploymentPayload).name },
      ),

    "deployment.deploy": (payload, ctx) =>
      engines.hosting.deploy(
        {
          organizationId: ctx.organizationId as never,
          idempotencyKey: ctx.idempotencyKey,
          timeoutMs: ctx.timeoutMs,
        },
        { applicationRef: (payload as DeployPayload).applicationRef },
      ),

    "deployment.rollback": (payload, ctx) =>
      engines.hosting.rollback(
        {
          organizationId: ctx.organizationId as never,
          idempotencyKey: ctx.idempotencyKey,
          timeoutMs: ctx.timeoutMs,
        },
        { applicationRef: (payload as DeployPayload).applicationRef },
      ),

    "deployment.cancel": (payload, ctx) =>
      engines.hosting.cancelDeployment(
        {
          organizationId: ctx.organizationId as never,
          idempotencyKey: ctx.idempotencyKey,
          timeoutMs: ctx.timeoutMs,
        },
        (payload as DeployPayload).applicationRef,
      ),

    "data.provision": (payload, ctx) =>
      engines.database.provision(
        {
          organizationId: ctx.organizationId as never,
          idempotencyKey: ctx.idempotencyKey,
          timeoutMs: ctx.timeoutMs,
        },
        { name: (payload as DataProvisionPayload).name },
      ),

    "data.backup": (payload, ctx) =>
      engines.database.backup(
        {
          organizationId: ctx.organizationId as never,
          idempotencyKey: ctx.idempotencyKey,
          timeoutMs: ctx.timeoutMs,
        },
        (payload as { ref: ProviderRef }).ref,
      ),

    "data.restore": (payload, ctx) => {
      const p = payload as { backupRef: ProviderRef; targetRef: ProviderRef };
      return engines.database.restore(
        {
          organizationId: ctx.organizationId as never,
          idempotencyKey: ctx.idempotencyKey,
          timeoutMs: ctx.timeoutMs,
        },
        { backupRef: p.backupRef, targetRef: p.targetRef },
      );
    },

    "data.destroy": (payload, ctx) =>
      engines.database.destroy(
        {
          organizationId: ctx.organizationId as never,
          idempotencyKey: ctx.idempotencyKey,
          timeoutMs: ctx.timeoutMs,
        },
        (payload as { ref: ProviderRef }).ref,
      ),
  } satisfies Record<JobKind, JobHandler>;
}

/** Re-exported so callers can name the adapter result shape without deep imports. */
export type { AdapterResult };
