/**
 * The stranded-deployment sweep (audit finding C7, residual gap).
 *
 * The requeue rule polls an in-flight build (see `resumeRunningDeployment`), but
 * it only runs while a job for that deployment is being redelivered. Two ways a
 * row escapes it and reads `pending`/`running` forever:
 *
 *   * the job reached a terminal state while the deployment row did not — a
 *     processor that failed the job for a reason unrelated to the build, a queue
 *     row deleted out of band, an attempt budget spent;
 *   * the engine accepted the build and then never settled it, so the job was
 *     requeued until its attempts ran out and was failed as a transient error.
 *
 * Either way the customer is left looking at a build that is not being worked on,
 * which is a worse lie than a failure: `pending` implies progress. This sweep is
 * the counterpart the queue's `reapExpired` cannot supply — the queue reaps
 * *jobs*, and this settles the *deployment rows* those jobs left behind.
 *
 * What it will not do is invent an outcome. It asks the engine the truth through
 * the uniform `DeploymentEngine` port � `getDeployment`, which reads the
 * deployment queue for a run ref and the application record for an application
 * ref. (The hosting adapter's own `reconcile` stays a read-only view for the API's
 * engine-status page; the port deliberately does not widen to it, because the port
 * is the intersection the worker needs and adding to it would change an adapter
 * interface.) It writes what the engine reported. A deployment whose engine says
 * `succeeded` is promoted exactly as the applier would; one whose engine has no
 * record of the build is failed with the engine's own reason. Only when the
 * engine cannot answer at all, and the row has passed a hard ceiling, does the
 * sweep settle it as `failed` with a reason that says so plainly — a build the
 * platform has waited an hour for is not still coming.
 *
 * It never writes `succeeded` from a timeout: `succeeded` is only ever the
 * engine's own answer. And it only ever writes a row whose organization it read
 * from that row, so the cross-tenant read the sweep needs never becomes a
 * cross-tenant write.
 */
import type { EngineStatus, OrganizationId, ProviderRef } from "@cloud-wai/contracts";
import type { Engines } from "@cloud-wai/adapters";
import { deploymentEngineFor } from "@cloud-wai/adapters";
import type { DeploymentJobOutcomeWriter } from "./deployment-job.js";

/** How stale a non-terminal row must be before the sweep looks at it. */
export const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
/**
 * How old a row must be before an engine that cannot confirm it is believed to
 * have lost it. A build still reported `running` past this is settled `failed`
 * with a reason naming the ceiling, never `succeeded`.
 */
export const DEFAULT_HARD_CEILING_MS = 60 * 60_000;
/** The most rows one sweep settles, so a backlog cannot block the loop. */
export const DEFAULT_SWEEP_LIMIT = 50;

/** One stranded row, as the sweep needs it — no secret, no other tenant's data. */
export interface StrandedDeployment {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly projectId: string;
  readonly status: EngineStatus;
  readonly providerResourceId: string | null;
  readonly deploymentResourceId: string | null;
  readonly createdAt: string;
  readonly kind: "production" | "preview";
  readonly staged: boolean;
}

export interface DeploymentReconcileWrites {
  /**
   * Non-terminal rows older than the cutoff, across every tenant.
   *
   * Service-role and cross-tenant on purpose: the sweeper does not know which
   * organizations to look in. Each row carries its own `organizationId`, which is
   * the scope of the write that follows.
   */
  listStrandedDeploymentsForService(
    olderThan: string,
    options?: { readonly limit?: number | undefined } | undefined,
  ): Promise<readonly StrandedDeployment[]>;
  /**
   * The project's engine target, scoped by organization.
   *
   * The worker has no session, so this is the service-role read whose where
   * clause carries the tenant. The execution model it returns decides which
   * engine the sweep asks, through the same router the deploy paths use — the
   * sweep never imports an adapter.
   */
  getProjectDeploymentTargetForService(
    organizationId: OrganizationId,
    projectId: string,
  ): Promise<{ readonly executionModel: "container" | "serverless" } | null>;
}

export interface DeploymentReconcilerDeps {
  readonly engines: Engines;
  readonly writes: DeploymentReconcileWrites;
  readonly outcome: DeploymentJobOutcomeWriter;
  readonly now?: () => Date;
  readonly staleAfterMs?: number;
  readonly hardCeilingMs?: number;
  readonly limit?: number;
  readonly timeoutMs?: number;
}

export interface DeploymentReconciler {
  /**
   * Settle the stranded rows the sweep can resolve, and report how many were
   * written. Rows the engine still reports in flight are left alone.
   */
  (now?: Date): Promise<number>;
}

function ageMs(createdAt: string, now: Date): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return Number.POSITIVE_INFINITY;
  return now.getTime() - created;
}

/** A row past the ceiling whose engine will not confirm it is settled failed. */
function unconfirmedReason(status: EngineStatus, ceilingMs: number, detail: string): string {
  const minutes = Math.round(ceilingMs / 60_000);
  return (
    `The deployment was still ${status} after ${minutes} minutes and the engine could not ` +
    `confirm the build: ${detail}`
  );
}

/**
 * Build the sweep the worker runs on each cycle.
 *
 * The returned function is the whole sweep: read the stranded rows, ask each
 * row's engine the truth, and write only what the engine said — or the honest
 * ceiling failure when it said nothing for too long.
 */
export function buildDeploymentReconciler(deps: DeploymentReconcilerDeps): DeploymentReconciler {
  const clock = deps.now ?? (() => new Date());
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const hardCeilingMs = deps.hardCeilingMs ?? DEFAULT_HARD_CEILING_MS;
  const limit = deps.limit ?? DEFAULT_SWEEP_LIMIT;
  const timeoutMs = deps.timeoutMs ?? 30_000;

  return async (now: Date = clock()): Promise<number> => {
    const cutoff = new Date(now.getTime() - staleAfterMs).toISOString();
    const stranded = await deps.writes.listStrandedDeploymentsForService(cutoff, { limit });

    let settled = 0;
    for (const row of stranded) {
      const settledNow = await settleOne(deps, row, now, hardCeilingMs, timeoutMs);
      if (settledNow) settled += 1;
    }
    return settled;
  };
}

/**
 * Resolve one stranded row, or leave it for a later sweep.
 *
 * Returns true when a row was written. A write happens only when the engine
 * answered (with a terminal state, or with a `not_configured` that means the
 * build does not exist), or when the row passed the ceiling with no answer.
 */
async function settleOne(
  deps: DeploymentReconcilerDeps,
  row: StrandedDeployment,
  now: Date,
  hardCeilingMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const target = await deps.writes.getProjectDeploymentTargetForService(
    row.organizationId,
    row.projectId,
  );
  // A preview is a container build of its own application; a production deploy
  // follows the project's model. This mirrors the executor's routing exactly, so
  // the sweep cannot ask the wrong engine about a row.
  const model = row.kind === "preview" ? "container" : (target?.executionModel ?? "container");
  const engine = deploymentEngineFor(deps.engines, model);

  const ctx = {
    organizationId: row.organizationId,
    idempotencyKey: `reconcile-deployment-${row.id}`,
    timeoutMs,
  };

  // Prefer the engine's *deployment* handle: it addresses the run itself, which
  // is what was left unsettled. The application ref is the fallback, which is the
  // only handle a row that never got past `ensureTarget` can carry.
  const ref: ProviderRef | null = row.deploymentResourceId
    ? {
        organizationId: row.organizationId,
        provider: "coolify",
        resourceType: "deployment",
        resourceId: row.deploymentResourceId,
      }
    : row.providerResourceId
      ? {
          organizationId: row.organizationId,
          provider: "coolify",
          resourceType: "application",
          resourceId: row.providerResourceId,
        }
      : null;

  if (ref === null) {
    // No engine handle at all: the deployment never reached the engine. Nothing
    // to poll and nothing to reconcile — after the ceiling, say so honestly.
    if (ageMs(row.createdAt, now) < hardCeilingMs) return false;
    return writeSettled(deps, row, {
      status: "failed",
      url: null,
      reason: unconfirmedReason(row.status, hardCeilingMs, "no engine handle was ever recorded."),
      now,
    });
  }

  // Both ref kinds are answered through the one uniform port method � a
  // deployment ref by the engine's deployment queue, an application ref by the
  // application record. The sweep imports no adapter: `deploymentEngineFor` chose
  // the engine above, and this call is the port it returned.
  const state = await engine.getDeployment(ctx, ref);

  if (state.ok) {
    const status = state.value.status;
    // The engine still reports work in progress. Honour it until the ceiling —
    // beyond that, it is not progress, and `pending` forever is the lie.
    if (status === "pending" || status === "running") {
      if (ageMs(row.createdAt, now) < hardCeilingMs) return false;
      return writeSettled(deps, row, {
        status: "failed",
        url: null,
        reason: unconfirmedReason(
          row.status,
          hardCeilingMs,
          "the engine still reports it in flight.",
        ),
        now,
      });
    }
    // The engine's own terminal answer. `succeeded` is genuine here and only
    // here; the promotion and usage rules match the applier's exactly.
    return writeSettled(deps, row, { status, url: state.value.url, reason: null, now });
  }

  // The engine refused to answer. `not_configured` from a deployment ref means
  // the engine has no such run — the build does not exist, so the row is failed
  // with that reason rather than left to imply progress. Any other refusal is
  // transient: wait for the ceiling before giving up on it.
  if (state.status === "not_configured") {
    return writeSettled(deps, row, {
      status: "failed",
      url: null,
      reason: `The engine has no record of this build: ${state.reason}`,
      now,
    });
  }
  if (ageMs(row.createdAt, now) < hardCeilingMs) return false;
  return writeSettled(deps, row, {
    status: "failed",
    url: null,
    reason: unconfirmedReason(row.status, hardCeilingMs, state.reason),
    now,
  });
}

/**
 * Persist a settled row, mirroring the applier's promotion and usage rules.
 *
 * The job applier and this sweep must agree on what a confirmed success does, so
 * the same three writes happen in the same order: the row, the production
 * pointer (a non-staged production success only), and one unit of usage.
 */
async function writeSettled(
  deps: DeploymentReconcilerDeps,
  row: StrandedDeployment,
  settled: {
    readonly status: EngineStatus;
    readonly url: string | null;
    readonly reason: string | null;
    readonly now: Date;
  },
): Promise<boolean> {
  const finished = settled.now.toISOString();
  const terminal = settled.status !== "pending" && settled.status !== "running";

  await deps.outcome.updateDeploymentStatus({
    id: row.id,
    organizationId: row.organizationId,
    status: settled.status,
    url: settled.url,
    failureReason: settled.reason,
    providerResourceId: row.providerResourceId,
    deploymentResourceId: row.deploymentResourceId,
    startedAt: finished,
    finishedAt: terminal ? finished : null,
  });

  if (settled.status === "succeeded") {
    if (row.kind === "production" && !row.staged) {
      await deps.outcome.promoteDeployment({
        organizationId: row.organizationId,
        projectId: row.projectId,
        deploymentId: row.id,
      });
    }
    await deps.outcome.recordUsage({
      organizationId: row.organizationId,
      metric: "deployments",
      quantity: 1,
    });
  }

  return true;
}
