/**
 * @cloud-wai/worker — Idempotent queue consumers. Executes orchestration jobs through adapters and records the outcome.
 */

export const APP_NAME = "worker" as const;

export { InProcessWorker, jobStateFor } from "./processor.js";
export type { JobOutcome, JobContext, JobHandler, WorkerOptions } from "./processor.js";
export { JOB_KINDS, buildHandlers } from "./handlers.js";
export type { JobKind, WorkerEngines } from "./handlers.js";
export {
  executeDeployment,
  type DeploymentExecutionWrites,
  type DeploymentExecutionResult,
} from "./deployment-executor.js";
export {
  buildDeploymentJobHandler,
  buildDeploymentApplier,
  type DeploymentJobDeps,
  type DeploymentJobOutcomeWriter,
} from "./deployment-job.js";
export { DEPLOYMENT_JOB_KIND } from "@cloud-wai/contracts";
export { startWorker } from "./runtime.js";
export type { WorkerStartupOptions, WorkerStartupResult, RunningWorker } from "./runtime.js";

export interface AppDescriptor {
  readonly name: string;
  readonly role: string;
  /** Boundaries this app enforces; asserted by tests in tests/. */
  readonly boundaries: readonly string[];
}

export function describe(): AppDescriptor {
  return {
    name: APP_NAME,
    role: "Idempotent queue consumers. Executes orchestration jobs through adapters and records the outcome.",
    boundaries: [
      "Executes through adapters only; never talks to an engine directly.",
      "Treats a repeated job id as already-applied.",
      "Never reports success for work it did not complete.",
    ],
  };
}
