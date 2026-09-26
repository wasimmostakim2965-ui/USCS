/**
 * The worker's deployment execution step.
 *
 * A deploy is "create the target if the project has none, then deploy, then read
 * the engine's state back". Which engine runs it is decided by the project's
 * execution model, through the shared execution router (`deploymentEngineFor`) —
 * never by the caller and never by a direct adapter import. The API's synchronous
 * path uses the identical router, so the two paths cannot diverge on which engine
 * a project's model maps to.
 *
 * The queue is only wired in production, so `tests/isolation` pins the
 * synchronous behaviour and `tests/integration/durable-deploy.test.ts` pins this
 * one against the same engine results.
 *
 * It talks only through the injected engine port and write port, and it returns
 * the engine's own answer. It never decides success: a `succeeded` here is one
 * the adapter reported and then confirmed with `getDeployment`.
 */
import type {
  AdapterResult,
  EngineStatus,
  ExecutionModel,
  OrganizationId,
  ProviderRef,
} from "@cloud-wai/contracts";
import type { Engines } from "@cloud-wai/adapters";
import { deploymentEngineFor, runBuildStep, type DeploymentEngine } from "@cloud-wai/adapters";
import type { ServerlessArtifact } from "@cloud-wai/adapters";

export interface DeploymentTarget {
  readonly provider: string | null;
  readonly providerResourceId: string | null;
  readonly executionModel: ExecutionModel;
}

/**
 * A preview's engine handle.
 *
 * A preview is always a container build, so it carries no execution model: there
 * is no serverless preview to route to, and pretending there could be one would
 * be a field that is always `container`.
 */
export interface PreviewTarget {
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
  /**
   * The engine target for a preview key, or null.
   *
   * A preview deploy must resolve *its own* application, never the project's
   * production one: reusing it would ship the branch to production, which is
   * exactly what a preview exists to prevent.
   */
  getPreviewTargetForService(
    organizationId: OrganizationId,
    projectId: string,
    previewKey: string,
  ): Promise<PreviewTarget | null>;
  setPreviewTargetProvider(input: {
    readonly organizationId: OrganizationId;
    readonly projectId: string;
    readonly previewKey: string;
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
  /** `production` deploys the project application; `preview` deploys its own. */
  readonly kind: "production" | "preview";
  /** The stable preview target key, or null for a production deploy. */
  readonly previewKey: string | null;
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
  /**
   * The engines the router chooses between.
   *
   * The executor no longer holds a single hosting adapter: which engine runs a
   * project is the project's execution model, resolved through the router, so it
   * needs the whole bag rather than one pre-chosen adapter.
   */
  readonly engines: Engines;
  readonly writes: DeploymentExecutionWrites;
  /**
   * Push a project's stored environment variables onto the application before
   * it deploys, or null when env vars are not configured.
   *
   * A variable can be stored before the project has an application — a customer
   * configures the project before its first deploy. This reconciles the engine
   * with what is stored at the moment the application first exists, so a
   * pre-deploy variable is not silently absent from the build. It is optional
   * because a test that pins deploy behaviour need not model configuration, and
   * an absent port means "nothing to reconcile", never a fabricated success.
   */
  readonly envVars?: EnvVarSync | null;
}

/** Reconcile the engine's environment with what the control plane stores. */
export interface EnvVarSync {
  sync(
    ctx: { organizationId: OrganizationId; idempotencyKey: string; timeoutMs: number },
    applicationRef: ProviderRef,
    projectId: string,
  ): Promise<void>;
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
  const isPreview = input.kind === "preview" && input.previewKey !== null;

  // A preview is a container concept: a branch build of a long-lived
  // application. It is container even for a serverless project, and a preview
  // must never be routed to the serverless engine, which has no preview.
  let executionModel: ExecutionModel = "container";

  // A preview resolves its own application; a production deploy resolves the
  // project's. They are separate handles by design, so a branch build can never
  // be written to the production URL.
  let application: ProviderRef | null = null;
  if (isPreview) {
    const previewTarget = await deps.writes.getPreviewTargetForService(
      input.organizationId,
      input.projectId,
      input.previewKey!,
    );
    application = previewTarget?.providerResourceId
      ? {
          organizationId: input.organizationId,
          provider: (previewTarget.provider ?? "coolify") as ProviderRef["provider"],
          resourceType: "application",
          resourceId: previewTarget.providerResourceId,
        }
      : null;
  } else {
    executionModel = target?.executionModel ?? "container";
    application = target?.providerResourceId
      ? {
          organizationId: input.organizationId,
          provider: (target.provider ?? "coolify") as ProviderRef["provider"],
          resourceType: "application",
          resourceId: target.providerResourceId,
        }
      : null;
  }

  // The engine is chosen once, by execution model, through the shared router.
  const engine = deploymentEngineFor(deps.engines, executionModel);

  if (input.action === "rollback") {
    return rollback(deps, engine, input, adapterCtx, application);
  }

  const applicationName = isPreview
    ? `${input.projectSlug}-${input.previewKey}`
    : input.projectSlug;

  if (!application) {
    const created = await engine.ensureTarget(adapterCtx, {
      name: applicationName,
      gitRepository: input.gitRepository,
      gitBranch: input.gitBranch,
      buildPack: input.buildPack,
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
    if (isPreview) {
      await deps.writes.setPreviewTargetProvider({
        organizationId: input.organizationId,
        projectId: input.projectId,
        previewKey: input.previewKey!,
        provider: application.provider,
        providerResourceId: application.resourceId,
      });
    } else {
      await deps.writes.setProjectProviderResource({
        organizationId: input.organizationId,
        projectId: input.projectId,
        provider: application.provider,
        providerResourceId: application.resourceId,
      });
    }
  }

  // Reconcile the engine's environment before the build, so a variable stored
  // before the application existed is present in this build rather than absent
  // until someone re-saves it. A reconciliation failure does not fail the
  // deployment: the same rule the applier uses for a promotion — a build that
  // genuinely built is worth shipping, and an env sync that could not run is
  // reported by the env page's own state, not by discarding a good build.
  //
  // Environment variables are pushed through the container adapter's API, so
  // this step runs only for a container deploy. A serverless project's env is
  // configured on the function by its own engine; pushing Coolify variables onto
  // a Lambda function's ref would be the wrong engine entirely.
  if (deps.envVars && engine.model === "container") {
    await deps.envVars.sync(adapterCtx, application, input.projectId);
  }

  // A serverless deploy needs a built artifact; the container engine builds for
  // itself from the git repository, so the step runs only where it is required.
  // This is what stops a serverless deploy from reporting a missing build it can
  // now actually perform (ADR-0018).
  let artifact: ServerlessArtifact | undefined;
  if (engine.model === "serverless") {
    const built = await runBuildStep(
      { build: deps.engines.build },
      {
        organizationId: input.organizationId,
        idempotencyKey: `${input.idempotencyKey}:build`,
        timeoutMs: input.timeoutMs,
        repository: input.gitRepository,
        branch: input.gitBranch,
        buildPack: input.buildPack,
      },
    );
    if (!built.ok) {
      return {
        status: "failed",
        url: null,
        providerResourceId: application?.resourceId ?? null,
        deploymentResourceId: null,
        reason: built.reason,
      };
    }
    artifact = built.artifact;
  }

  const deployed = await engine.deploy(adapterCtx, application, artifact);
  return confirm(deps, engine, adapterCtx, deployed, application.resourceId);
}
async function rollback(
  deps: DeploymentExecutorDeps,
  engine: DeploymentEngine,
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
  const result = await engine.rollback(adapterCtx, { ref: application, commit: input.commit });
  return confirm(deps, engine, adapterCtx, result, null);
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
  engine: DeploymentEngine,
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
  const state = await engine.getDeployment(adapterCtx, action.value.providerRef);
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
