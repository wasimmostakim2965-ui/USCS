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
  EngineStatus,
  OrganizationId,
  ProjectId,
  ProviderRef,
} from "@cloud-wai/contracts";
import type { BuildPack, Engines } from "@cloud-wai/adapters";
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
>;

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

  let engineReason: string | null = null;
  let nextStatus: EngineStatus = "pending";
  let url: string | null = null;
  let providerResourceId: string | null = target?.providerResourceId ?? null;

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
