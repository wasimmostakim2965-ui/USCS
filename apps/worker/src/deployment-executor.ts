/**
 * The worker's deployment execution step.
 *
 * A deploy is "create the application if the project has none, then deploy, then
 * read the engine's state back". The API's synchronous path implements the same
 * algorithm inline; the two cannot share code because apps may not import each
 * other and the queue is only wired in production, so `tests/isolation` pins the
 * synchronous behaviour and `tests/integration/durable-deploy.test.ts` pins this
 * one against the same engine results.
 *
 * It talks only through the injected `HostingAdapter` and write port, and it
 * returns the engine's own answer. It never decides success: a `succeeded` here
 * is one the adapter reported and then confirmed with `getDeployment`.
 */
import type {
  AdapterResult,
  EngineStatus,
  OrganizationId,
  ProviderRef,
} from "@cloud-wai/contracts";
import type { BuildPack, HostingAdapter } from "@cloud-wai/adapters";

export interface DeploymentTarget {
  readonly provider: string | null;
  readonly providerResourceId: string | null;
}

/**
 * The writes the executor needs.
 *
 * Narrow on purpose: it must not be able to touch an API key or a policy. The
 * service-role store implements every method; a read-only store simply does not
 * satisfy this, and the caller reports `engine_unavailable` rather than acting.
 */
export interface DeploymentExecutionWrites {
  /**
   * The project's engine-side target, scoped by organization.
   *
   * The worker has no session, so this is the service-role read whose where
   * clause carries the tenant. A member-scoped read would return null for the
   * worker and the job would report `not_configured` forever.
   */
  getProjectDeploymentTargetForService(
    organizationId: OrganizationId,
    projectId: string,
  ): Promise<DeploymentTarget | null>;
  setProjectProviderResource(input: {
    readonly organizationId: OrganizationId;
    readonly projectId: string;
    readonly provider: string;
    readonly providerResourceId: string;
  }): Promise<unknown>;
}

export interface ExecuteDeploymentInput {
  readonly organizationId: OrganizationId;
  readonly projectId: string;
  readonly projectSlug: string;
  readonly idempotencyKey: string;
  readonly action: "create" | "rollback";
  readonly gitRepository: string | null;
  readonly gitBranch: string | null;
  readonly buildPack: string | null;
  /** The git revision a rollback returns to. */
  readonly commit: string | null;
  readonly timeoutMs: number;
}

export interface DeploymentExecutionResult {
  readonly status: EngineStatus;
  readonly url: string | null;
  readonly providerResourceId: string | null;
  /**
   * The engine's *deployment* handle for this run, when the engine issued one.
   *
   * Distinct from `providerResourceId`, which is the application. Only this
   * value can address the build/deploy log, so it is persisted onto the row and
   * the logs procedure reads it from there.
   */
  readonly deploymentResourceId: string | null;
  readonly reason: string | null;
}

export interface DeploymentExecutorDeps {
  readonly hosting: HostingAdapter;
  readonly writes: DeploymentExecutionWrites;
}

/**
 * Create the application if the project has none, then deploy or roll back.
 *
 * The rollback path is separate because Coolify refuses a rollback without a
 * git ref: a rollback against a project with no application, or without a
 * commit, is `not_configured`, not a fabricated success.
 */
export async function executeDeployment(
  deps: DeploymentExecutorDeps,
  input: ExecuteDeploymentInput,
): Promise<DeploymentExecutionResult> {
  const adapterCtx = {
    organizationId: input.organizationId,
    idempotencyKey: input.idempotencyKey,
    timeoutMs: input.timeoutMs,
  };

  const target = await deps.writes.getProjectDeploymentTargetForService(
    input.organizationId,
    input.projectId,
  );
  let application: ProviderRef | null = target?.providerResourceId
    ? {
        organizationId: input.organizationId,
        provider: (target.provider ?? "coolify") as ProviderRef["provider"],
        resourceType: "application",
        resourceId: target.providerResourceId,
      }
    : null;

  if (input.action === "rollback") {
    return rollback(deps, input, adapterCtx, application);
  }

  if (!application) {
    const created = await deps.hosting.createApplication(adapterCtx, {
      name: input.projectSlug,
      ...(input.gitRepository ? { gitRepository: input.gitRepository } : {}),
      ...(input.gitBranch ? { gitBranch: input.gitBranch } : {}),
      ...(input.buildPack ? { buildPack: input.buildPack as BuildPack } : {}),
    });
    if (!created.ok) {
      return {
        status: created.status,
        url: null,
        providerResourceId: null,
        deploymentResourceId: null,
        reason: created.reason,
      };
    }
    application = created.value.providerRef;
    await deps.writes.setProjectProviderResource({
      organizationId: input.organizationId,
      projectId: input.projectId,
      provider: application.provider,
      providerResourceId: application.resourceId,
    });
  }

  const deployed = await deps.hosting.deploy(adapterCtx, { applicationRef: application });
  return confirm(deps, adapterCtx, deployed, application.resourceId);
}

async function rollback(
  deps: DeploymentExecutorDeps,
  input: ExecuteDeploymentInput,
  adapterCtx: { organizationId: OrganizationId; idempotencyKey: string; timeoutMs: number },
  application: ProviderRef | null,
): Promise<DeploymentExecutionResult> {
  if (!application || !input.commit) {
    return {
      status: "not_configured",
      url: null,
      providerResourceId: application?.resourceId ?? null,
      deploymentResourceId: null,
      reason:
        "This project has no application on the hosting engine yet, so there is nothing to roll back.",
    };
  }
  const result = await deps.hosting.rollback(adapterCtx, {
    applicationRef: application,
    commit: input.commit,
  });
  return confirm(deps, adapterCtx, result, null);
}

/**
 * Read the engine's own state back after an action.
 *
 * A deploy answers "queued", not "done". Reporting `succeeded` from the action's
 * own return would be a guess, so the state is read back and the engine's answer
 * is what the caller persists.
 */
async function confirm(
  deps: DeploymentExecutorDeps,
  adapterCtx: { organizationId: OrganizationId; idempotencyKey: string; timeoutMs: number },
  action: AdapterResult<{ providerRef: ProviderRef }>,
  providerResourceId: string | null,
): Promise<DeploymentExecutionResult> {
  if (!action.ok) {
    return {
      status: action.status,
      url: null,
      providerResourceId,
      deploymentResourceId: null,
      reason: action.reason,
    };
  }

  const resolvedId = providerResourceId ?? action.value.providerRef.resourceId;
  // A deploy answers with a *deployment* ref; a rollback with the application.
  // Only the former can address the build log, so it is recorded separately
  // rather than collapsed into the application handle.
  const deploymentResourceId =
    action.value.providerRef.resourceType === "deployment"
      ? action.value.providerRef.resourceId
      : null;
  let status: EngineStatus = action.status;
  let url: string | null = null;
  const state = await deps.hosting.getDeployment(adapterCtx, action.value.providerRef);
  if (state.ok) {
    status = state.value.status;
    url = state.value.url;
  }
  return {
    status,
    url,
    providerResourceId: resolvedId,
    deploymentResourceId,
    reason: null,
  };
}
