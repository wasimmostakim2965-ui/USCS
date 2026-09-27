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
  /** The project's monorepo directory, or null for the repository root. */
  readonly rootDirectory: string | null;
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
  /**
   * The deployment row this job advances, read on the service role.
   *
   * A deploy the engine accepted but has not finished is requeued by the
   * processor, so a job can run more than once for one request. This is how a
   * re-execution sees that it already asked the engine to build and must poll
   * that build rather than start a second one. Service-scoped like every other
   * worker read: there is no session, so `organization_id` is the boundary.
   * Optional so a test that pins the first attempt need not model a resume; an
   * absent port means "no prior attempt is known", never a resumed success.
   */
  getDeploymentForService?(
    organizationId: OrganizationId,
    deploymentId: string,
  ): Promise<StoredDeploymentHandle | null>;
  /**
   * Persist the engine's own handle the moment `deploy` returns, before the
   * state is read back.
   *
   * The applier writes the settled outcome after the handler returns, so a
   * process that dies between `deploy` and that write would leave the row with
   * no handle — and a reap would then re-deploy, starting a *second* billed
   * build for one request. Writing the handle as soon as the engine issues it
   * closes that window: a later attempt finds the in-flight handle and polls it
   * rather than building again. The status written here is the engine's own
   * answer (`running`/`pending`), never `succeeded`; the applier still writes
   * the settled state. Optional so a test that pins one attempt need not model
   * it; an absent port means the applier's write is the only one, as before.
   */
  markDeploymentInFlight?(input: {
    readonly organizationId: OrganizationId;
    readonly deploymentId: string;
    readonly status: EngineStatus;
    readonly providerResourceId: string | null;
    readonly deploymentResourceId: string | null;
  }): Promise<unknown>;
  /**
   * The project's environments, read on the service role.
   *
   * The executor needs the environment a job belongs to in order to select which
   * variable set the build receives. A job enqueued before `0024` carries no
   * environment, so this is how such a job still resolves the project's default
   * (Production) rather than receiving no variables. Service-scoped: there is no
   * session, so `organization_id` is the boundary. Optional so a test that pins
   * deploy behaviour need not model environments; an absent port means "resolve
   * from the job payload only", never a fabricated environment.
   */
  listEnvironmentsForService?(
    organizationId: OrganizationId,
    projectId: string,
  ): Promise<readonly StoredEnvironment[]>;
}

/** The environment fields a build needs, as the worker reads them. */
export interface StoredEnvironment {
  readonly id: string;
  readonly kind: "production" | "preview" | "custom";
  readonly isDefault: boolean;
}

/**
 * The parts of a deployment row a re-execution needs.
 *
 * Deliberately narrow: the engine's own handles and the state they were last
 * written with. Nothing about the request, the tenant's name, or a URL is here,
 * because the resume path only needs to know whether a build is already running.
 */
export interface StoredDeploymentHandle {
  readonly status: EngineStatus;
  readonly providerResourceId: string | null;
  readonly deploymentResourceId: string | null;
}

export interface ExecuteDeploymentInput {
  readonly organizationId: OrganizationId;
  readonly projectId: string;
  readonly projectSlug: string;
  /** The deployment row this job advances; the resume path reads it back. */
  readonly deploymentId: string;
  readonly idempotencyKey: string;
  readonly action: "create" | "rollback";
  readonly gitRepository: string | null;
  readonly gitBranch: string | null;
  readonly buildPack: string | null;
  /**
   * The monorepo subdirectory to build from, as the deployment row recorded it.
   *
   * Null when the request had none, which is also the case for a job enqueued
   * before this field existed. The executor then falls back to the project's own
   * setting, read from the target below, so an old queued job still builds the
   * directory the project is configured for.
   */
  readonly rootDirectory: string | null;
  /** The git revision a rollback returns to. */
  readonly commit: string | null;
  readonly timeoutMs: number;
  /** `production` deploys the project application; `preview` deploys its own. */
  readonly kind: "production" | "preview";
  /** The stable preview target key, or null for a production deploy. */
  readonly previewKey: string | null;
  /**
   * The environment this build belongs to, from the job payload, or null.
   *
   * Null means the job predates `0024`; the executor then resolves the project's
   * default environment so the build still receives a variable set.
   */
  readonly environmentId: string | null;
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
    environmentId: string,
  ): Promise<void>;
}

/**
 * The project's default environment, read on the service role, or null.
 *
 * Used only for a job that carries no environment id (enqueued before `0024`).
 * A store that cannot list environments, or a project with none, yields null:
 * the sync is then skipped rather than pushing an unscoped variable set, which
 * is the honest choice — no environment means no correct set to send.
 */
async function defaultEnvironmentIdFor(
  deps: DeploymentExecutorDeps,
  organizationId: OrganizationId,
  projectId: string,
): Promise<string | null> {
  if (typeof deps.writes.listEnvironmentsForService !== "function") return null;
  const environments = await deps.writes.listEnvironmentsForService(organizationId, projectId);
  return (environments.find((environment) => environment.isDefault) ?? environments[0])?.id ?? null;
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

  // The row's recorded directory is what this build was requested with. A job
  // enqueued before the column existed carries null, so the project's own
  // setting — read from the target resolved above — is the fallback; a preview
  // uses the project's setting too, since it has no root directory of its own.
  const rootDirectory = input.rootDirectory ?? target?.rootDirectory ?? null;

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

  // A deploy the engine accepted but has not finished is requeued by the
  // processor, so one request can run this handler more than once. The first
  // attempt already asked the engine to build and stored the engine's own
  // *deployment* handle. A second `deploy` (or `rollback`) call would start a
  // second build for the same request, so a re-execution polls the build it
  // already started and reports that state instead.
  const resumed = await resumeRunningDeployment(deps, engine, input, adapterCtx, application);
  if (resumed) return resumed;

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
      rootDirectory,
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
    // The environment selects which variable set the build receives. A job that
    // carries none (enqueued before `0024`) resolves the project's default, so an
    // in-flight job still gets a coherent set rather than an empty one. A project
    // with no resolvable environment skips the sync: there is nothing to scope
    // the variables to, and pushing them all would be the wrong set.
    const environmentId =
      input.environmentId ??
      (await defaultEnvironmentIdFor(deps, input.organizationId, input.projectId));
    if (environmentId) {
      await deps.envVars.sync(adapterCtx, application, input.projectId, environmentId);
    }
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
        rootDirectory,
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
  return confirm(deps, engine, adapterCtx, deployed, application.resourceId, input);
}
/**
 * Resume a deploy the engine already accepted but has not finished.
 *
 * The processor requeues a job whose handler reported `running`, which is the
 * honest state of a build the engine is still working on. Re-running the whole
 * handler would ask the engine to build a *second* time for the same request —
 * an extra deployment per requeue, and an extra billed build. The row already
 * carries the engine's own deployment handle, so this reads that build's state
 * back and returns it without issuing another deploy.
 *
 * Returns null when there is nothing to resume, so the caller runs the ordinary
 * create/rollback path:
 *   * no stored read port (a test that pins only the first attempt),
 *   * no row, or a row with no engine deployment handle yet (the first attempt
 *     never reached `deploy`),
 *   * a row in a terminal state (a prior attempt finished; nothing is in flight).
 *
 * A *new* request is not mistaken for a resume: it is a different deployment
 * row with its own id, so this reads that row and finds no in-flight handle.
 */
async function resumeRunningDeployment(
  deps: DeploymentExecutorDeps,
  engine: DeploymentEngine,
  input: ExecuteDeploymentInput,
  adapterCtx: { organizationId: OrganizationId; idempotencyKey: string; timeoutMs: number },
  application: ProviderRef | null,
): Promise<DeploymentExecutionResult | null> {
  const read = deps.writes.getDeploymentForService;
  if (typeof read !== "function") return null;

  const stored = await read(input.organizationId, input.deploymentId);
  if (!stored) return null;
  // The engine's handle for a *deployment* is what addresses an in-flight
  // build. A row without one never got past `ensureTarget`, so there is no
  // build to poll and the ordinary path must run.
  const handle = stored.deploymentResourceId;
  if (handle === null) return null;
  // A terminal row is finished; a requeued job for one is a stale redelivery
  // and must not re-deploy. Any *non-terminal* row with a handle is in flight:
  // the engine issued the handle but has not settled it, so a re-execution must
  // poll that build rather than start a second one. (The handle is written the
  // instant `deploy` returns, so this holds even if the process died before the
  // applier ran.)
  if (stored.status !== "running" && stored.status !== "pending") return null;

  const ref: ProviderRef = {
    organizationId: input.organizationId,
    provider: (application?.provider ?? "coolify") as ProviderRef["provider"],
    resourceType: "deployment",
    resourceId: handle,
  };
  const state = await engine.getDeployment(adapterCtx, ref);
  if (!state.ok) {
    // The engine could not be asked. Report its own reason rather than a
    // fabricated state; the processor decides whether to retry.
    return {
      status: state.status,
      url: null,
      providerResourceId: stored.providerResourceId,
      deploymentResourceId: handle,
      reason: state.reason,
    };
  }
  // The engine's answer is the truth: it may now be finished, still running, or
  // failed. Reporting its status is what lets the processor complete the job
  // when the build finally succeeds, and requeue it again while it still runs.
  return {
    status: state.value.status,
    url: state.value.url,
    providerResourceId: stored.providerResourceId,
    deploymentResourceId: handle,
    reason: null,
  };
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
  return confirm(deps, engine, adapterCtx, result, null, input);
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
  input: ExecuteDeploymentInput,
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

  // Persist the handle before reading the state back. The applier writes the
  // settled outcome only after this handler returns, so a crash in between would
  // leave the row with no handle — and a reap would re-deploy, a second billed
  // build for one request. The status here is the engine's own answer, never
  // `succeeded`; the read below and the applier still write the settled state.
  if (deploymentResourceId !== null && typeof deps.writes.markDeploymentInFlight === "function") {
    await deps.writes.markDeploymentInFlight({
      organizationId: input.organizationId,
      deploymentId: input.deploymentId,
      status: action.status,
      providerResourceId: resolvedId,
      deploymentResourceId,
    });
  }

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
