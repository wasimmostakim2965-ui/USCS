/**
 * The worker's production wiring: read config, build the queue and handlers,
 * and run the loop.
 *
 * This is the process a deployment runs. It is the only place that drains the
 * durable queue, and it is deliberately separate from the API so that an API
 * process that is busy or restarting never stops a deployment from making
 * progress. It fails closed the same way the API does: with no control-plane
 * database there is no queue to drain, so it refuses to start rather than
 * looping over nothing and looking healthy.
 */
import {
  controlPlaneConfig,
  createPostgrestClient,
  createSupabaseControlPlaneStore,
  SqlJobQueue,
} from "@cloud-wai/database";
import { buildEngines, engineConfigFromEnv } from "@cloud-wai/adapters";
import { randomUUID } from "node:crypto";
import {
  InProcessWorker,
  buildDeploymentApplier,
  buildDeploymentJobHandler,
  DEPLOYMENT_JOB_KIND,
  type DeploymentExecutionWrites,
  type JobHandler,
} from "./index.js";

export interface WorkerStartupOptions {
  readonly env?: Record<string, string | undefined>;
  readonly newId?: () => string;
  /** Overridable so tests can drive the loop deterministically. */
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  readonly signal?: AbortSignal;
  readonly onCycle?: (outcomes: number) => void;
}

export interface RunningWorker {
  readonly stop: () => Promise<void>;
}

export type WorkerStartupResult = RunningWorker | { readonly reason: string };

/**
 * The handler table the worker drains with.
 *
 * `deployments.execute` is the durable command the API enqueues. The other job
 * kinds in `buildHandlers` are adapter-shaped and are wired by a deployment that
 * uses them; this entry point registers the one the API writes today, and a job
 * of any other kind is failed honestly by the processor's no-handler branch.
 */
function handlersFor(
  hosting: ReturnType<typeof buildEngines>["hosting"],
  writes: DeploymentExecutionWrites,
  outcome: Parameters<typeof buildDeploymentApplier>[0]["outcome"],
): Record<string, JobHandler> {
  return {
    [DEPLOYMENT_JOB_KIND]: buildDeploymentJobHandler({ hosting, writes, outcome }),
  };
}

/**
 * Start the worker, or explain why it cannot start.
 *
 * The queue is drained in a loop with a reaper: a claim whose lease expired is
 * returned to the queue before the next claim, so a worker that dies mid-job
 * does not wedge that job forever.
 */
export async function startWorker(
  options: WorkerStartupOptions = {},
): Promise<WorkerStartupResult> {
  const env = options.env ?? process.env;

  const database = controlPlaneConfig(env);
  if (!database) {
    return {
      reason:
        "Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY so the worker can drain the control-plane queue.",
    };
  }

  const client = createPostgrestClient({
    url: database.url,
    serviceRoleKey: database.serviceRoleKey,
  });
  const store = createSupabaseControlPlaneStore({
    client,
    newId: options.newId ?? (() => randomUUID()),
  });
  const engines = buildEngines(engineConfigFromEnv(env));
  const queue = new SqlJobQueue(client);

  // The worker writes the deployment row with the same service-role client that
  // drains the queue: it has no session, so organization_id in each write is the
  // tenant boundary.
  const outcome = {
    updateDeploymentStatus: (input: {
      id: string;
      organizationId: string;
      status: Parameters<typeof store.updateDeploymentStatus>[0]["status"];
      url: string | null;
      failureReason: string | null;
      providerResourceId: string | null;
      startedAt: string;
      finishedAt: string | null;
    }) => store.updateDeploymentStatus(input),
  };

  const writes: DeploymentExecutionWrites = {
    getProjectDeploymentTargetForService: (organizationId, projectId) =>
      store.getProjectDeploymentTargetForService(organizationId, projectId),
    setProjectProviderResource: (input) => store.setProjectProviderResource(input),
  };

  const applier = buildDeploymentApplier({
    hosting: engines.hosting,
    writes,
    outcome,
  });

  const worker = new InProcessWorker({
    queue,
    handlers: handlersFor(engines.hosting, writes, outcome),
    logger: consoleLogger(),
    workerId: `worker-${process.pid}`,
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    apply: applier,
  });

  const intervalMs = options.pollIntervalMs ?? 2_000;
  const signal = options.signal ?? new AbortController().signal;
  let stopped = false;

  const loop = async () => {
    while (!stopped && !signal.aborted) {
      try {
        // Return any expired lease to the queue before claiming, so a job from a
        // crashed worker is retried rather than stuck in `running` forever.
        const reaped = await queue.reapExpired();
        const outcomes = await worker.drain(50);
        options.onCycle?.(outcomes.length + reaped);
        if (outcomes.length === 0 && reaped === 0) {
          await delay(intervalMs, signal);
        }
      } catch (error) {
        process.stderr.write(
          `Cloud Wai worker cycle failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        await delay(intervalMs, signal);
      }
    }
  };

  void loop();

  return {
    stop: async () => {
      stopped = true;
    },
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function consoleLogger() {
  return {
    debug: () => {},
    info: (message: string, fields?: Record<string, unknown>) =>
      process.stdout.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
    warn: (message: string, fields?: Record<string, unknown>) =>
      process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
    error: (message: string, fields?: Record<string, unknown>) =>
      process.stderr.write(`${message} ${JSON.stringify(fields ?? {})}\n`),
  };
}
