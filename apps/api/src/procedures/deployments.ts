/**
 * Deployment and audit procedures.
 *
 * A client can request a deployment and read its state; it can never set the
 * state. The status column is written with the service-role connection the
 * browser does not have, and the only `succeeded` a procedure writes is one the
 * hosting adapter itself reported. An engine this deployment has no credentials
 * for leaves the row `not_configured` with the engine's own reason — a fact
 * about the deployment, not a customer error.
 *
 * Two rules keep a request from inventing work:
 *   * the row is written before the engine is called, so a request that dies
 *     mid-flight leaves a record rather than an invisible half-deployment;
 *   * a repeated idempotency key returns the original row and does not call the
 *     engine again, so a retried request cannot create a second deployment.
 */
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import type {
  AdapterResult,
  DeploymentId,
  EngineStatus,
  OrganizationId,
  ProjectId,
  ProviderRef,
} from "@cloud-wai/contracts";
import type { BuildPack, Engines, JobQueue } from "@cloud-wai/adapters";
import { DEPLOYMENT_JOB_KIND, type DeploymentJobPayload } from "@cloud-wai/contracts";
import type { AuditEvent, ControlPlaneWrites, DataStore, Deployment } from "@cloud-wai/database";
import type { RequestContext } from "../context.js";

/** A hosting operation is bounded; a hung engine must not hang a request. */
const ADAPTER_TIMEOUT_MS = 30_000;

/** The hosting engine this build wires (ADR-0002: Coolify behind HostingAdapter). */
const HOSTING_PROVIDER = "coolify";

/** A git branch, tag or commit: enough to name a revision, not a shell string. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** A clone URL. Only the schemes Coolify accepts; never free text. */
const REPO_PATTERN = /^(https:\/\/|http:\/\/|git@)[^\s]{3,297}$/;

type DeploymentWrites = Pick<
  ControlPlaneWrites,
  | "createDeployment"
  | "updateDeploymentStatus"
  | "findDeploymentByIdempotencyKey"
  | "getProjectDeploymentTarget"
  | "setProjectProviderResource"
> &
  Pick<ControlPlaneWrites, "getDeployment">;

const REQUIRED_WRITES = [
  "createDeployment",
  "updateDeploymentStatus",
  "findDeploymentByIdempotencyKey",
  "getProjectDeploymentTarget",
  "setProjectProviderResource",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

export interface DeploymentDeps {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  readonly engines: Engines;
  /** Injected so a deployment id is a Cloud Wai UUID, not a provider artifact. */
  readonly newId: () => string;
  readonly now?: () => Date;
  /**
   * When present, a deploy or rollback is recorded as a durable job and the
   * engine work is enqueued for the worker rather than performed on the request
   * path. When absent (a test double, a first deployment) the procedure runs the
   * engine synchronously, which is the behaviour the deployment tests pin.
   *
   * The row is always written first and always on the request path — the queue
   * only decides who *executes* it, never whether it is recorded.
   */
  readonly queue?: JobQueue;
}

/**
 * The write half of the store, or an honest refusal.
 *
 * A store that can only read (a report, a first deployment) must not answer `ok`
 * for a deployment it never recorded, so the missing capability is reported as
 * `engine_unavailable` rather than swallowed into an empty success.
 */
function writesFor(deps: DeploymentDeps): DeploymentWrites {
  const store = deps.store;
  const missing = REQUIRED_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as DeploymentWrites;
}

function normaliseIdempotencyKey(value: string | undefined, newId: () => string): string {
  const key = value?.trim();
  if (!key) return newId();
  if (key.length > 200) throw new ApiError("invalid_input", "The idempotency key is too long.");
  return key;
}

/** An optional git ref: absent stays absent, present must be a real ref. */
function optionalRef(value: string | undefined, label: string): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  if (!REF_PATTERN.test(trimmed)) {
    throw new ApiError("invalid_input", `${label} is not a valid git reference.`);
  }
  return trimmed;
}

function optionalRepository(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  if (!REPO_PATTERN.test(trimmed)) {
    throw new ApiError("invalid_input", "Repository must be an https://, http:// or git@ URL.");
  }
  return trimmed;
}

export async function listDeployments(
  ctx: RequestContext,
  deps: DeploymentDeps,
  projectId: ProjectId,
): Promise<readonly Deployment[]> {
  const project = await deps.store.getProject(ctx.principal.userId, projectId);
  if (!project) {
    throw new ApiError("not_found", "Project not found.");
  }
  requireCapability(ctx, project.organizationId, "deployment:read");
  return deps.store.listDeployments(ctx.principal.userId, projectId);
}

export async function listAuditEvents(
  ctx: RequestContext,
  deps: DeploymentDeps,
  organizationId: OrganizationId,
): Promise<readonly AuditEvent[]> {
  requireCapability(ctx, organizationId, "audit:read");
  return deps.store.listAuditEvents(ctx.principal.userId, organizationId);
}

export interface CreateDeploymentInput {
  readonly projectId: ProjectId;
  /** Client-supplied; replaying it returns the original deployment. */
  readonly idempotencyKey?: string | undefined;
  readonly gitRepository?: string | undefined;
  readonly gitBranch?: string | undefined;
  readonly commit?: string | undefined;
  readonly buildPack?: BuildPack | undefined;
}

export interface RollbackDeploymentInput {
  readonly projectId: ProjectId;
  /** Coolify refuses a rollback without the git ref to return to. */
  readonly commit?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface DeploymentLogsInput {
  readonly projectId: ProjectId;
  readonly deploymentId: string;
}

export interface CancelDeploymentInput {
  readonly projectId: ProjectId;
  readonly deploymentId: string;
}

export interface CancelDeploymentResult {
  readonly deployment: Deployment;
  /** The engine's own words when it could not act, for an honest UI. */
  readonly engineReason: string | null;
}

/**
 * Cancel an in-flight deployment.
 *
 * The row is the precondition: a terminal deployment has nothing left to cancel,
 * so the request is refused rather than sent to an engine that would no-op. The
 * cancel is addressed by the row's *deployment* handle — Coolify cancels a
 * deployment by uuid — so a run that never reached the engine reports honestly
 * instead of cancelling an unrelated build.
 *
 * Cloud Wai has no `canceled` engine status; a cancelled run is written `failed`
 * with the reason, which is what it is: the work did not complete.
 */
export async function cancelDeployment(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: CancelDeploymentInput,
): Promise<CancelDeploymentResult> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:cancel");

  const store = writesFor(deps);
  if (typeof store.getDeployment !== "function") {
    throw new ApiError("engine_unavailable", "This deployment cannot read a deployment yet.");
  }

  const deployment = await store.getDeployment(
    ctx.principal.userId,
    input.deploymentId as DeploymentId,
  );
  // A deployment outside the tenant, or one that does not exist, is the same
  // answer: `not_found`, never a hint that another tenant's id is real.
  if (!deployment || deployment.projectId !== project.id) {
    throw new ApiError("not_found", "Deployment not found.");
  }

  if (deployment.status !== "pending" && deployment.status !== "running") {
    throw new ApiError(
      "conflict",
      `Only a pending or running deployment can be cancelled; this one is ${deployment.status}.`,
    );
  }

  const clock = deps.now ?? (() => new Date());
  const adapterCtx = {
    organizationId: project.organizationId,
    idempotencyKey: `cancel-${deployment.id}`,
    timeoutMs: ADAPTER_TIMEOUT_MS,
  };

  let engineReason: string | null = null;

  if (!deployment.deploymentResourceId) {
    // Nothing was sent to the engine, so there is no build to stop. The row is
    // still closed out honestly: a pending row that never reached the engine
    // must not sit `pending` forever.
    engineReason =
      "This deployment never reached the hosting engine, so there was no build to cancel.";
  } else {
    const ref: ProviderRef = {
      organizationId: project.organizationId,
      provider: HOSTING_PROVIDER as ProviderRef["provider"],
      resourceType: "deployment",
      resourceId: deployment.deploymentResourceId,
    };
    const result = await deps.engines.hosting.cancelDeployment(adapterCtx, ref);
    if (!result.ok) {
      // The engine refused or is unconfigured: keep the row where it is and
      // report why, rather than claiming a cancellation that did not happen.
      const unchanged = await store.updateDeploymentStatus({
        id: deployment.id,
        organizationId: project.organizationId,
        status: deployment.status,
        url: deployment.url,
        failureReason: result.reason,
        providerResourceId: deployment.providerResourceId,
        deploymentResourceId: deployment.deploymentResourceId,
        startedAt: clock().toISOString(),
        finishedAt: null,
      });
      return { deployment: unchanged ?? deployment, engineReason: result.reason };
    }
    engineReason = "Cancelled by the customer.";
  }

  // A cancelled run did not complete, so `failed` — never `succeeded`.
  const updated = await store.updateDeploymentStatus({
    id: deployment.id,
    organizationId: project.organizationId,
    status: "failed",
    url: deployment.url,
    failureReason: engineReason,
    providerResourceId: deployment.providerResourceId,
    deploymentResourceId: deployment.deploymentResourceId,
    startedAt: clock().toISOString(),
    finishedAt: clock().toISOString(),
  });

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "deployment.cancelled",
    targetType: "deployment",
    targetId: deployment.id,
    metadata: { projectId: project.id, status: updated?.status ?? "failed" },
  });

  return { deployment: updated ?? deployment, engineReason };
}

export interface DeploymentLogsResult {
  /** The engine's own log lines, verbatim — either a build log or a runtime tail. */
  readonly lines: readonly string[];
  /** The engine's cursor, or null when it has none (Coolify has none). */
  readonly cursor: string | null;
  /**
   * Which engine log this is. `deployment` is the build/deploy log for the
   * specific run (where a failed build is explained); `application` is the
   * running container's output; null when neither was resolvable.
   */
  readonly source: "deployment" | "application" | null;
  /** The engine's own words when it could not serve logs. */
  readonly engineReason: string | null;
}

/**
 * Read a deployment's engine logs.
 *
 * Logs live at the hosting engine, so this resolves the project's engine-side
 * application and asks the adapter. An engine this deployment has no credentials
 * for, or a project that was never deployed, returns an honest reason with no
 * lines — never fabricated output. The lines are the customer's own application
 * logs; they are returned verbatim, exactly as the engine reports them.
 */
export async function deploymentsLogs(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: DeploymentLogsInput,
): Promise<DeploymentLogsResult> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:read");

  // Prefer the engine's *deployment* handle recorded on the row: only it
  // addresses the build/deploy log, which is what a failed build writes to.
  // `getDeployment` is a member-scoped read, so asking for another tenant's
  // deployment id returns null rather than its logs.
  const writes = writesFor(deps);
  const deployment =
    typeof writes.getDeployment === "function"
      ? await writes.getDeployment(ctx.principal.userId, input.deploymentId as DeploymentId)
      : null;

  const applicationTarget = await writes.getProjectDeploymentTarget(
    ctx.principal.userId,
    project.id,
  );

  let ref: ProviderRef | null = null;
  let source: "deployment" | "application" | null = null;
  if (deployment?.deploymentResourceId) {
    ref = {
      organizationId: project.organizationId,
      provider: HOSTING_PROVIDER as ProviderRef["provider"],
      resourceType: "deployment",
      resourceId: deployment.deploymentResourceId,
    };
    source = "deployment";
  } else if (applicationTarget?.providerResourceId) {
    ref = {
      organizationId: project.organizationId,
      provider: (applicationTarget.provider ?? HOSTING_PROVIDER) as ProviderRef["provider"],
      resourceType: "application",
      resourceId: applicationTarget.providerResourceId,
    };
    source = "application";
  }

  if (!ref || !source) {
    return {
      lines: [],
      cursor: null,
      source: null,
      engineReason: "This project has no application on the hosting engine yet, so it has no logs.",
    };
  }

  const result = await deps.engines.hosting.getLogs(
    {
      organizationId: project.organizationId,
      idempotencyKey: `logs-${input.deploymentId}`,
      timeoutMs: ADAPTER_TIMEOUT_MS,
    },
    ref,
  );

  if (!result.ok) {
    return { lines: [], cursor: null, source, engineReason: result.reason };
  }
  return { lines: result.value.lines, cursor: result.value.cursor, source, engineReason: null };
}

export interface DeploymentRequestResult {
  readonly deployment: Deployment;
  /** True when this call replayed an existing idempotency key. */
  readonly replayed: boolean;
  /** The engine's own words when it could not act, for an honest UI. */
  readonly engineReason: string | null;
}

/**
 * Request a deployment.
 *
 * The engine-side application is created on the first deployment and its
 * reference is remembered on the project, so a second deployment does not create
 * a second application. Whatever the adapter reports becomes the row's status —
 * including `not_configured`, which is the honest state of a deployment with no
 * hosting credentials.
 */
export async function requestDeployment(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: CreateDeploymentInput,
): Promise<DeploymentRequestResult> {
  const clock = deps.now ?? (() => new Date());

  // Authorization first. A stranger must get `not_found`, never a hint about
  // whether this deployment can write.
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:create");

  const store = writesFor(deps);

  const gitBranch = optionalRef(input.gitBranch, "Branch");
  const commit = optionalRef(input.commit, "Commit");
  const gitRepository = optionalRepository(input.gitRepository);

  const idempotencyKey = normaliseIdempotencyKey(input.idempotencyKey, deps.newId);
  const existing = await store.findDeploymentByIdempotencyKey(
    ctx.principal.userId,
    project.organizationId,
    idempotencyKey,
  );
  if (existing) {
    // A key names one request. If it was first used for another project, the
    // stored row is not this caller's operation: returning it would answer a
    // deploy of project B with a deployment of project A and skip B entirely.
    // The unique key is per organization, so the collision is real and refused.
    if (existing.projectId !== project.id) {
      throw new ApiError(
        "conflict",
        "This idempotency key was already used for a deployment in another project.",
      );
    }
    return { deployment: existing, replayed: true, engineReason: existing.failureReason };
  }

  // The row exists before the engine is called: a request that dies mid-flight
  // leaves a record, not an invisible half-deployment.
  let deployment = await store.createDeployment({
    organizationId: project.organizationId,
    projectId: project.id,
    idempotencyKey,
    requestedBy: ctx.principal.userId,
    status: "pending",
    provider: HOSTING_PROVIDER,
    providerResourceId: null,
    url: null,
    failureReason: null,
  });

  // Durable path: record the command as a job and let the worker execute it.
  // The deployment stays `pending` — that is its honest state until the engine
  // answers. The idempotency key is shared, so a retried request replays the row
  // above and never enqueues a second job.
  if (deps.queue) {
    const payload: DeploymentJobPayload = {
      deploymentId: deployment.id,
      organizationId: project.organizationId,
      projectId: project.id,
      action: "create",
      projectSlug: project.slug,
      gitRepository,
      gitBranch,
      buildPack: input.buildPack ?? null,
      commit,
    };
    await deps.queue.enqueue({
      organizationId: project.organizationId,
      kind: DEPLOYMENT_JOB_KIND,
      payload,
      idempotencyKey,
    });
    await deps.store.recordAuditEvent({
      organizationId: project.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "deployment.enqueued",
      targetType: "deployment",
      targetId: deployment.id,
      metadata: {
        projectId: project.id,
        idempotencyKey,
        ...(gitBranch ? { branch: gitBranch } : {}),
        ...(commit ? { commit } : {}),
      },
    });
    return { deployment, replayed: false, engineReason: null };
  }

  const adapterCtx = {
    organizationId: project.organizationId,
    idempotencyKey,
    timeoutMs: ADAPTER_TIMEOUT_MS,
  };

  const target = await store.getProjectDeploymentTarget(ctx.principal.userId, project.id);
  let application: ProviderRef | null = target?.providerResourceId
    ? {
        organizationId: project.organizationId,
        provider: (target.provider ?? HOSTING_PROVIDER) as ProviderRef["provider"],
        resourceType: "application",
        resourceId: target.providerResourceId,
      }
    : null;

  let engineReason: string | null = null;
  let nextStatus: EngineStatus = "pending";
  let url: string | null = null;
  let deploymentResourceId: string | null = null;

  if (!application) {
    const created = await deps.engines.hosting.createApplication(adapterCtx, {
      name: project.slug,
      ...(gitRepository ? { gitRepository } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(input.buildPack ? { buildPack: input.buildPack } : {}),
    });
    if (!created.ok) {
      engineReason = created.reason;
      nextStatus = created.status;
    } else {
      application = created.value.providerRef;
      await store.setProjectProviderResource({
        organizationId: project.organizationId,
        projectId: project.id,
        provider: application.provider,
        providerResourceId: application.resourceId,
      });
    }
  }

  if (application) {
    const deployed = await deps.engines.hosting.deploy(adapterCtx, { applicationRef: application });
    if (!deployed.ok) {
      engineReason = deployed.reason;
      nextStatus = deployed.status;
    } else {
      // A queued deployment is `running`, never `succeeded`: the engine has not
      // finished when it answers. Read the state back so the row reflects the
      // engine rather than the request.
      nextStatus = deployed.status;
      // The engine returns a *deployment* ref here; its uuid is what addresses
      // the build/deploy log, so it is recorded for the logs procedure.
      deploymentResourceId = deployed.value.providerRef.resourceId;
      const state = await deps.engines.hosting.getDeployment(
        adapterCtx,
        deployed.value.providerRef,
      );
      if (state.ok) {
        nextStatus = state.value.status;
        url = state.value.url;
      }
    }
  }

  deployment = await persistTransition(store, clock, deployment, {
    organizationId: project.organizationId,
    status: nextStatus,
    url,
    failureReason: engineReason,
    providerResourceId: application?.resourceId ?? null,
    deploymentResourceId,
  });

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "deployment.created",
    targetType: "deployment",
    targetId: deployment.id,
    // Branch and commit only. The repository URL can carry credentials in its
    // userinfo, so it never reaches an audit row.
    metadata: {
      projectId: project.id,
      status: nextStatus,
      idempotencyKey,
      ...(gitBranch ? { branch: gitBranch } : {}),
      ...(commit ? { commit } : {}),
    },
  });

  return { deployment, replayed: false, engineReason };
}

/**
 * Roll a project back to a git revision.
 *
 * The rollback is recorded as its own deployment row, so the history shows the
 * rollback rather than silently rewriting the deployment it undid. An engine
 * that refuses (or is unconfigured) leaves the row honestly non-successful.
 */
export async function rollbackDeployment(
  ctx: RequestContext,
  deps: DeploymentDeps,
  input: RollbackDeploymentInput,
): Promise<DeploymentRequestResult> {
  const clock = deps.now ?? (() => new Date());

  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "deployment:rollback");

  const store = writesFor(deps);

  const commit = input.commit?.trim() ?? "";
  if (!REF_PATTERN.test(commit)) {
    throw new ApiError("invalid_input", "A rollback needs the commit to return to.");
  }

  const idempotencyKey = normaliseIdempotencyKey(input.idempotencyKey, deps.newId);
  const existing = await store.findDeploymentByIdempotencyKey(
    ctx.principal.userId,
    project.organizationId,
    idempotencyKey,
  );
  if (existing) {
    // Same rule as a deploy: a key reused across projects must not answer a
    // rollback of project B with an operation from project A.
    if (existing.projectId !== project.id) {
      throw new ApiError(
        "conflict",
        "This idempotency key was already used for a deployment in another project.",
      );
    }
    return { deployment: existing, replayed: true, engineReason: existing.failureReason };
  }

  let deployment = await store.createDeployment({
    organizationId: project.organizationId,
    projectId: project.id,
    idempotencyKey,
    requestedBy: ctx.principal.userId,
    status: "pending",
    provider: HOSTING_PROVIDER,
    providerResourceId: null,
    url: null,
    failureReason: null,
  });

  const adapterCtx = {
    organizationId: project.organizationId,
    idempotencyKey,
    timeoutMs: ADAPTER_TIMEOUT_MS,
  };

  const target = await store.getProjectDeploymentTarget(ctx.principal.userId, project.id);

  // Durable path: same shape as a deploy. A rollback is recorded as a job and
  // executed by the worker; the row stays `pending` until the engine answers.
  if (deps.queue) {
    const payload: DeploymentJobPayload = {
      deploymentId: deployment.id,
      organizationId: project.organizationId,
      projectId: project.id,
      action: "rollback",
      projectSlug: project.slug,
      gitRepository: null,
      gitBranch: null,
      buildPack: null,
      commit,
    };
    await deps.queue.enqueue({
      organizationId: project.organizationId,
      kind: DEPLOYMENT_JOB_KIND,
      payload,
      idempotencyKey,
    });
    await deps.store.recordAuditEvent({
      organizationId: project.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "deployment.rollback_enqueued",
      targetType: "deployment",
      targetId: deployment.id,
      metadata: { projectId: project.id, commit, idempotencyKey },
    });
    return { deployment, replayed: false, engineReason: null };
  }

  let engineReason: string | null = null;
  let nextStatus: EngineStatus = "pending";
  let url: string | null = null;
  let providerResourceId: string | null = target?.providerResourceId ?? null;
  let deploymentResourceId: string | null = null;

  if (!target?.providerResourceId) {
    engineReason =
      "This project has no application on the hosting engine yet, so there is nothing to roll back.";
    nextStatus = "not_configured";
  } else {
    const applicationRef: ProviderRef = {
      organizationId: project.organizationId,
      provider: (target.provider ?? HOSTING_PROVIDER) as ProviderRef["provider"],
      resourceType: "application",
      resourceId: target.providerResourceId,
    };
    const result = await deps.engines.hosting.rollback(adapterCtx, { applicationRef, commit });
    if (!result.ok) {
      engineReason = result.reason;
      nextStatus = result.status;
    } else {
      nextStatus = result.status;
      providerResourceId = result.value.providerRef.resourceId;
      if (result.value.providerRef.resourceType === "deployment") {
        deploymentResourceId = result.value.providerRef.resourceId;
      }
      const state = await deps.engines.hosting.getDeployment(adapterCtx, result.value.providerRef);
      if (state.ok) {
        nextStatus = state.value.status;
        url = state.value.url;
      }
    }
  }

  deployment = await persistTransition(store, clock, deployment, {
    organizationId: project.organizationId,
    status: nextStatus,
    url,
    failureReason: engineReason,
    providerResourceId,
    deploymentResourceId,
  });

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "deployment.rolled_back",
    targetType: "deployment",
    targetId: deployment.id,
    metadata: { projectId: project.id, status: nextStatus, commit, idempotencyKey },
  });

  return { deployment, replayed: false, engineReason };
}

/**
 * Write a state transition, keeping the row if the write is refused.
 *
 * A store that declines the update (a row outside the tenant, a race) must not
 * turn into a thrown 500 after the engine was already asked to act: the
 * deployment that exists is the more useful answer, and its status is still the
 * honest one from the engine.
 */
async function persistTransition(
  store: DeploymentWrites,
  clock: () => Date,
  current: Deployment,
  input: {
    readonly organizationId: OrganizationId;
    readonly status: EngineStatus;
    readonly url: string | null;
    readonly failureReason: string | null;
    readonly providerResourceId: string | null;
    readonly deploymentResourceId?: string | null;
  },
): Promise<Deployment> {
  const startedAt = clock().toISOString();
  const terminal = input.status !== "pending" && input.status !== "running";
  const updated = await store.updateDeploymentStatus({
    id: current.id,
    organizationId: input.organizationId,
    status: input.status,
    url: input.url,
    failureReason: input.failureReason,
    providerResourceId: input.providerResourceId,
    deploymentResourceId: input.deploymentResourceId ?? null,
    startedAt,
    finishedAt: terminal ? startedAt : null,
  });
  return updated ?? current;
}

/** Exported for the boundary test: the deployment states a procedure may write. */
export const DEPLOYMENT_PROCEDURE_STATES: readonly EngineStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "degraded",
  "not_configured",
];

export type { AdapterResult };
