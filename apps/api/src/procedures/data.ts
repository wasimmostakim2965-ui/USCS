/**
 * Data procedures: provision a resource and take a backup.
 *
 * ADR-0006 phase 3 requires deploy, backup and policy to run end to end against
 * the adapters. This module is the backup half, and it follows the deployment
 * write path exactly: the row exists before the engine is called, and the state
 * the caller sees is the engine's answer, never the request.
 *
 * Two rules are load-bearing:
 *
 *   * A resource's `state` and the engine's own identifier are written only from
 *     the adapter's result. There is no procedure that accepts a state from the
 *     browser, and the guard trigger refuses a client write even through PostgREST.
 *   * A backup is recorded only after the adapter returns a real backup
 *     reference. A `not_configured` engine leaves the backup honestly
 *     non-successful rather than looking like a completed one.
 */
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import type { Engines } from "@cloud-wai/adapters";
import type { ControlPlaneWrites, DataBackup, DataResource, DataStore } from "@cloud-wai/database";
import type { DataResourceId, OrganizationId, ProjectId, ProviderRef } from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";

type DataWrites = Pick<
  ControlPlaneWrites,
  | "createDataResource"
  | "getDataResource"
  | "setDataResourceState"
  | "createDataBackup"
  | "updateDataBackupStatus"
  | "listDataBackups"
>;

const REQUIRED_WRITES = [
  "createDataResource",
  "getDataResource",
  "setDataResourceState",
  "createDataBackup",
  "updateDataBackupStatus",
  "listDataBackups",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

export interface DataDeps {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  readonly engines: Engines;
  readonly newId: () => string;
  readonly now?: () => Date;
}

const ADAPTER_TIMEOUT_MS = 20_000;

/** The write half of the store, or an honest refusal to pretend. */
function writesFor(deps: DataDeps): DataWrites {
  const store = deps.store;
  const missing = REQUIRED_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as DataWrites;
}

export const DATA_RESOURCE_KINDS = ["postgres", "object_storage"] as const;
export type DataResourceKind = (typeof DATA_RESOURCE_KINDS)[number];

export interface ProvisionDataInput {
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly kind: DataResourceKind;
  readonly projectId?: ProjectId | undefined;
}

export interface ProvisionDataResult {
  readonly resource: DataResource;
  /** The engine's own words when it could not act, for an honest UI. */
  readonly engineReason: string | null;
}

/**
 * Provision a tenant database or bucket through the adapter.
 *
 * The resource row is created `provisioning` before the engine is called, so a
 * request that dies mid-flight leaves a record rather than an invisible
 * half-resource. The engine's answer — including `not_configured` — decides the
 * state the row ends in.
 */
export async function provisionDataResource(
  ctx: RequestContext,
  deps: DataDeps,
  input: ProvisionDataInput,
): Promise<ProvisionDataResult> {
  requireCapability(ctx, input.organizationId, "data:create");

  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    throw new ApiError("invalid_input", "A resource name must be 1-120 characters.");
  }
  if (!DATA_RESOURCE_KINDS.includes(input.kind)) {
    throw new ApiError("invalid_input", "Unknown data resource kind.");
  }

  // A project, when named, must be in the same organization: the resource would
  // otherwise read as belonging to an organization the caller did not choose.
  if (input.projectId) {
    const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
    if (!project || project.organizationId !== input.organizationId) {
      throw new ApiError("not_found", "Project not found.");
    }
  }

  const writes = writesFor(deps);
  const id = deps.newId() as DataResourceId;

  // Created before the engine call, and never with an engine-observed value: the
  // insert names only the caller's own input.
  let resource = await writes.createDataResource({
    id,
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    kind: input.kind,
    name,
    state: "provisioning",
    provider: null,
    providerResourceId: null,
  });

  const adapterCtx = {
    organizationId: input.organizationId,
    idempotencyKey: `provision-${id}`,
    timeoutMs: ADAPTER_TIMEOUT_MS,
  };

  const provisioned =
    input.kind === "postgres"
      ? await deps.engines.database.provision(adapterCtx, { name })
      : await deps.engines.storage.createBucket(adapterCtx, { name });

  let engineReason: string | null = null;
  let state: DataResource["state"] = "not_configured";
  let provider: string | null = null;
  let providerResourceId: string | null = null;

  if (!provisioned.ok) {
    engineReason = provisioned.reason;
    state = provisioned.status === "not_configured" ? "not_configured" : "failed";
  } else {
    const ref = provisioned.value;
    state = "ready";
    provider = ref.provider;
    providerResourceId = ref.resourceId;
  }

  const transitioned = await writes.setDataResourceState({
    id,
    organizationId: input.organizationId,
    state,
    provider,
    providerResourceId,
  });
  if (transitioned) resource = transitioned;

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: state === "ready" ? "data.ready" : "data.provision_failed",
    targetType: "data_resource",
    targetId: id,
    metadata: { kind: input.kind, state },
  });

  return { resource, engineReason };
}

export interface BackupDataInput {
  readonly organizationId: OrganizationId;
  readonly resourceId: DataResourceId;
}

export interface BackupDataResult {
  readonly backup: DataBackup;
  readonly engineReason: string | null;
}

/**
 * Take a backup of a provisioned resource.
 *
 * A resource with no engine handle cannot be backed up: asking anyway would
 * record a backup that names no artifact. The backup row is created `pending`
 * before the engine is called and its status is the adapter's answer.
 */
export async function backupDataResource(
  ctx: RequestContext,
  deps: DataDeps,
  input: BackupDataInput,
): Promise<BackupDataResult> {
  requireCapability(ctx, input.organizationId, "data:backup");

  const writes = writesFor(deps);
  const resource = await writes.getDataResource(ctx.principal.userId, input.resourceId);
  if (!resource || resource.organizationId !== input.organizationId) {
    throw new ApiError("not_found", "Data resource not found.");
  }
  if (!resource.providerResourceId) {
    // No engine handle means the engine never provisioned it — it may even be a
    // resource whose provisioning was refused. A backup record would be a fiction.
    throw new ApiError(
      "conflict",
      "This resource has no engine handle yet, so it cannot be backed up.",
    );
  }

  const id = deps.newId();
  const ref: ProviderRef = {
    organizationId: resource.organizationId,
    provider: (resource.provider ?? "postgres") as ProviderRef["provider"],
    resourceType: "database",
    resourceId: resource.providerResourceId,
  };

  // Created before the engine call, so a requested backup is visible even if the
  // request dies mid-flight.
  let backup = await writes.createDataBackup({
    id,
    organizationId: resource.organizationId,
    dataResourceId: resource.id,
    provider: ref.provider,
    status: "pending",
  });

  const adapterCtx = {
    organizationId: resource.organizationId,
    idempotencyKey: `backup-${id}`,
    timeoutMs: ADAPTER_TIMEOUT_MS,
  };

  // Only the database adapter backs up: bucket backup goes through the storage
  // engine's own mechanism, which this build does not expose a procedure for.
  const taken = await deps.engines.database.backup(adapterCtx, ref);

  let engineReason: string | null = null;
  let status: DataBackup["status"] = taken.ok ? "succeeded" : taken.status;
  let providerResourceId: string | null = null;

  if (taken.ok) {
    providerResourceId = taken.value.resourceId;
  } else {
    engineReason = taken.reason;
  }

  const updated = await writes.updateDataBackupStatus({
    id,
    organizationId: resource.organizationId,
    status,
    providerResourceId,
    finishedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  if (updated) backup = updated;

  await deps.store.recordAuditEvent({
    organizationId: resource.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: status === "succeeded" ? "data.backup_completed" : "data.backup_failed",
    targetType: "data_backup",
    targetId: id,
    metadata: { dataResourceId: resource.id, status },
  });

  return { backup, engineReason };
}

export interface ListBackupsInput {
  readonly organizationId: OrganizationId;
  readonly resourceId: DataResourceId;
}

/** List a resource's backups, membership-scoped. */
export async function listDataBackups(
  ctx: RequestContext,
  deps: DataDeps,
  input: ListBackupsInput,
): Promise<readonly DataBackup[]> {
  requireCapability(ctx, input.organizationId, "data:read");
  const writes = writesFor(deps);
  // The named organization must be the resource's own. A caller who is a member
  // of two organizations could otherwise pass one organization's id with the
  // other's resource id and read backups the named organization does not own.
  const resource = await writes.getDataResource(ctx.principal.userId, input.resourceId);
  if (!resource || resource.organizationId !== input.organizationId) {
    throw new ApiError("not_found", "Data resource not found.");
  }
  return writes.listDataBackups(ctx.principal.userId, input.resourceId);
}
