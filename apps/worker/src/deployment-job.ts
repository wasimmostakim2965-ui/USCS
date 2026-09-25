/**
 * The worker's deployment job: run the shared executor, then mirror the result.
 *
 * This is the production half of ADR-0006 phase 3's "deploy is recorded in
 * `orchestration_jobs`": the API enqueues `deployments.execute`, and this runs
 * it off the request path. The handler does the engine work; the applier writes
 * the deployment row. They are split so the processor can guarantee the job's own
 * state is persisted before the customer-facing row is touched.
 */
import type { AdapterResult, EngineStatus, DeploymentJobPayload } from "@cloud-wai/contracts";
import { err, ok, DEPLOYMENT_JOB_KIND } from "@cloud-wai/contracts";
import type { Job } from "@cloud-wai/adapters";
import type { JobHandler } from "./processor.js";
import {
  executeDeployment,
  type DeploymentExecutionResult,
  type DeploymentExecutorDeps,
} from "./deployment-executor.js";

export interface DeploymentJobOutcomeWriter {
  /**
   * Advance the deployment row from the executor's honest result.
   *
   * Scoped by organization: the write runs on the service role, so the tenant in
   * the where clause is what keeps it from crossing a boundary.
   */
  updateDeploymentStatus(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly status: EngineStatus;
    readonly url: string | null;
    readonly failureReason: string | null;
    readonly providerResourceId: string | null;
    /** The engine's deployment handle, persisted so its build log is addressable. */
    readonly deploymentResourceId?: string | null;
    readonly startedAt: string;
    readonly finishedAt: string | null;
  }): Promise<unknown>;
}

export interface DeploymentJobDeps extends DeploymentExecutorDeps {
  readonly outcome: DeploymentJobOutcomeWriter;
  readonly now?: () => Date;
}

/**
 * Build the handler for `deployments.execute`.
 *
 * A success carries the executor's result as `value`, so the applier can persist
 * the engine's own url and provider reference rather than re-deriving them. A
 * non-success is an `err` carrying the engine's own reason. Note that a
 * deploy the engine reports as still `running` is not a success: the processor
 * requeues it, which is the honest state of work not yet finished.
 */
export function buildDeploymentJobHandler(deps: DeploymentJobDeps): JobHandler {
  return async (payload, ctx) => {
    const input = payload as DeploymentJobPayload;
    const result = await executeDeployment(
      { hosting: deps.hosting, writes: deps.writes },
      {
        organizationId: input.organizationId,
        projectId: input.projectId,
        projectSlug: input.projectSlug,
        idempotencyKey: ctx.idempotencyKey,
        action: input.action,
        gitRepository: input.gitRepository,
        gitBranch: input.gitBranch,
        buildPack: input.buildPack,
        commit: input.commit,
        timeoutMs: ctx.timeoutMs,
        // An older job row (enqueued before previews existed) has neither field;
        // it is a production deploy, which is what the defaults say.
        kind: input.kind ?? "production",
        previewKey: input.previewKey ?? null,
      },
    );

    if (result.status === "succeeded" && result.reason === null) {
      return ok<DeploymentExecutionResult>(result.status, result);
    }
    return err(result.status, result.reason ?? `Deployment ended ${result.status}.`);
  };
}

/**
 * The applier the processor calls after a job settles.
 *
 * Every branch writes a row, including the failure branches: a deployment that
 * did not happen still has to say so, or the customer sees `pending` forever.
 */
export function buildDeploymentApplier(
  deps: DeploymentJobDeps,
): (job: Job, result: AdapterResult<unknown>) => Promise<void> {
  const clock = deps.now ?? (() => new Date());
  return async (job, result) => {
    if (job.kind !== DEPLOYMENT_JOB_KIND) return;
    const payload = job.payload as DeploymentJobPayload;
    const finished = clock().toISOString();

    if (result.ok) {
      const value = result.value as DeploymentExecutionResult | undefined;
      await deps.outcome.updateDeploymentStatus({
        id: payload.deploymentId,
        organizationId: payload.organizationId,
        status: value?.status ?? result.status,
        url: value?.url ?? null,
        failureReason: null,
        providerResourceId: value?.providerResourceId ?? null,
        deploymentResourceId: value?.deploymentResourceId ?? null,
        startedAt: finished,
        finishedAt: isTerminal(value?.status ?? result.status) ? finished : null,
      });
      return;
    }

    await deps.outcome.updateDeploymentStatus({
      id: payload.deploymentId,
      organizationId: payload.organizationId,
      status: result.status,
      url: null,
      failureReason: result.reason,
      providerResourceId: null,
      startedAt: finished,
      finishedAt: isTerminal(result.status) ? finished : null,
    });
  };
}

function isTerminal(status: EngineStatus): boolean {
  return status !== "pending" && status !== "running";
}
