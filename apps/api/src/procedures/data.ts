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
import type { Engines, JobQueue } from "@cloud-wai/adapters";
import type {
  ControlPlaneWrites,
  DataBackup,
  DataResource,
  DataRestore,
  DataStore,
} from "@cloud-wai/database";
import type { DataResourceId, OrganizationId, ProjectId, ProviderRef } from "@cloud-wai/contracts";
import {
  BACKUP_JOB_KIND,
  RESTORE_JOB_KIND,
  type BackupJobPayload,
  type RestoreJobPayload,
} from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";

type DataWrites = Pick<
  ControlPlaneWrites,
  | "createDataResource"
  | "getDataResource"
  | "setDataResourceState"
  | "createDataBackup"
  | "updateDataBackupStatus"
  | "listDataBackups"
  | "getDataBackupForService"
  | "createDataRestore"
  | "updateDataRestoreStatus"
  | "listDataRestores"
>;

const REQUIRED_WRITES = [
  "createDataResource",
  "getDataResource",
  "setDataResourceState",
  "createDataBackup",
  "updateDataBackupStatus",
  "listDataBackups",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

/**
 * The writes a restore additionally needs.
 *
 * Kept separate from `REQUIRED_WRITES` so a deployment (or a test double) that
 * can back up but has no restore record does not have the whole data module
 * refuse — only the restore path reports its own honest `engine_unavailable`.
 */
const REQUIRED_RESTORE_WRITES = [
  "getDataBackupForService",
  "createDataRestore",
  "updateDataRestoreStatus",
  "listDataRestores",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

export interface DataDeps {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  readonly engines: Engines;
  readonly newId: () => string;
  readonly now?: () => Date;
  /**
   * When wired, a backup becomes a durable job the worker executes instead of
   * engine work on the request path. Omitted in tests that pin the synchronous
   * behaviour.
   */
  readonly queue?: JobQueue;
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

/**
 * The write half a restore additionally needs.
 *
 * A restore is destructive, so a deployment that can back up but not *record* a
 * restore must refuse the restore rather than perform it silently: the history
 * row is what makes the operation auditable.
 */
function restoreWritesFor(deps: DataDeps): DataWrites {
  const store = deps.store;
  const missing = REQUIRED_RESTORE_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record a restore (${missing.join(", ")}) yet.`,
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

  // Only the database adapter has a `backup` at all: a bucket's backup goes
  // through the storage engine's own mechanism, which this build does not
  // expose. Routing a bucket here would send a MinIO bucket name to the database
  // engine as though it were a database id and record a backup that names no
  // artifact — so it is refused rather than faked.
  if (resource.kind !== "postgres") {
    throw new ApiError(
      "engine_unavailable",
      "Backing up an object-storage bucket is not available in this build yet.",
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

  // Durable path: record the command as a job and let the worker take the
  // backup. The row stays `pending` — its honest state until the engine answers.
  if (deps.queue) {
    const payload: BackupJobPayload = {
      backupId: id,
      organizationId: resource.organizationId,
      dataResourceId: resource.id,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
    };
    await deps.queue.enqueue({
      organizationId: resource.organizationId,
      kind: BACKUP_JOB_KIND,
      payload,
      // The backup id is the idempotency key, so a retried request replays the
      // row above and never enqueues a second backup of the same attempt.
      idempotencyKey: `backup-${id}`,
    });
    await deps.store.recordAuditEvent({
      organizationId: resource.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "data.backup_enqueued",
      targetType: "data_backup",
      targetId: id,
      metadata: { dataResourceId: resource.id },
    });
    return { backup, engineReason: null };
  }

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

export interface RestoreDataInput {
  readonly organizationId: OrganizationId;
  readonly resourceId: DataResourceId;
  readonly backupId: string;
  /**
   * The resource's own name, echoed back by the operator.
   *
   * A restore overwrites the target's current contents, so it must not be one
   * click away from a list. Requiring the name — computed by the server and
   * typed by the caller — is what makes the confirmation a deliberate act rather
   * than a mis-tap on the row below the one intended.
   */
  readonly confirmName: string;
}

export interface RestoreDataResult {
  readonly restore: DataRestore;
  readonly engineReason: string | null;
}

/**
 * Restore a database from one of its own backups.
 *
 * The write path mirrors `backupDataResource` exactly: the restore row exists
 * `pending` before the engine is called, and only the adapter's answer moves it
 * off that state. A restore is destructive, so three refusals come first:
 *
 *   * the resource and the backup must both belong to the named organization —
 *     a backup of another tenant's database is not a restore source;
 *   * the backup must name a real engine artifact, or the restore would run
 *     against nothing;
 *   * the operator must echo the resource's name, or the refusal is explicit.
 */
export async function restoreDataResource(
  ctx: RequestContext,
  deps: DataDeps,
  input: RestoreDataInput,
): Promise<RestoreDataResult> {
  requireCapability(ctx, input.organizationId, "data:restore");

  const writes = restoreWritesFor(deps);
  const resource = await writes.getDataResource(ctx.principal.userId, input.resourceId);
  if (!resource || resource.organizationId !== input.organizationId) {
    throw new ApiError("not_found", "Data resource not found.");
  }
  // A bucket has no restore path in this build, for the same reason it has no
  // backup path: routing it here would send a bucket name to the database engine.
  if (resource.kind !== "postgres") {
    throw new ApiError(
      "engine_unavailable",
      "Restoring an object-storage bucket is not available in this build yet.",
    );
  }
  if (!resource.providerResourceId) {
    throw new ApiError(
      "conflict",
      "This resource has no engine handle yet, so it cannot be restored.",
    );
  }

  if (input.confirmName.trim() !== resource.name) {
    throw new ApiError(
      "invalid_input",
      `Type the database name (${resource.name}) to confirm the restore.`,
    );
  }

  // The backup must be this organization's, and it must name an engine artifact.
  const backup = await writes.getDataBackupForService(input.organizationId, input.backupId);
  if (!backup || backup.dataResourceId !== resource.id) {
    throw new ApiError("not_found", "Backup not found for this resource.");
  }
  if (backup.status !== "succeeded" || !backup.providerResourceId) {
    throw new ApiError(
      "conflict",
      "That backup did not complete, so there is nothing to restore from it.",
    );
  }

  const id = deps.newId();
  const targetRef: ProviderRef = {
    organizationId: resource.organizationId,
    provider: (resource.provider ?? "postgres") as ProviderRef["provider"],
    resourceType: "database",
    resourceId: resource.providerResourceId,
  };
  const backupRef: ProviderRef = {
    organizationId: resource.organizationId,
    provider: (backup.provider ?? "postgres") as ProviderRef["provider"],
    resourceType: "backup",
    resourceId: backup.providerResourceId,
  };

  // Created before the engine call, so a requested restore is visible even if
  // the request dies mid-flight.
  let restore = await writes.createDataRestore({
    id,
    organizationId: resource.organizationId,
    backupId: backup.id,
    dataResourceId: resource.id,
    provider: targetRef.provider,
    status: "pending",
  });

  // Durable path: record the command as a job and let the worker run it. The row
  // stays `pending` — its honest state until the engine answers.
  if (deps.queue) {
    const payload: RestoreJobPayload = {
      restoreId: id,
      organizationId: resource.organizationId,
      backupId: backup.id,
      dataResourceId: resource.id,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
    };
    await deps.queue.enqueue({
      organizationId: resource.organizationId,
      kind: RESTORE_JOB_KIND,
      payload,
      // The restore id is the idempotency key, so a retried request replays the
      // row above and never enqueues a second restore of the same attempt.
      idempotencyKey: `restore-${id}`,
    });
    await deps.store.recordAuditEvent({
      organizationId: resource.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "data.restore_enqueued",
      targetType: "data_restore",
      targetId: id,
      metadata: { dataResourceId: resource.id, backupId: backup.id },
    });
    return { restore, engineReason: null };
  }

  const adapterCtx = {
    organizationId: resource.organizationId,
    idempotencyKey: `restore-${id}`,
    timeoutMs: ADAPTER_TIMEOUT_MS,
  };

  const performed = await deps.engines.database.restore(adapterCtx, {
    backupRef,
    targetRef,
  });

  let engineReason: string | null = null;
  const status: DataRestore["status"] = performed.ok ? "succeeded" : performed.status;

  if (!performed.ok) engineReason = performed.reason;

  const updated = await writes.updateDataRestoreStatus({
    id,
    organizationId: resource.organizationId,
    status,
    providerResourceId: performed.ok ? performed.value.jobId : null,
    finishedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  if (updated) restore = updated;

  await deps.store.recordAuditEvent({
    organizationId: resource.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: status === "succeeded" ? "data.restore_completed" : "data.restore_failed",
    targetType: "data_restore",
    targetId: id,
    metadata: { dataResourceId: resource.id, backupId: backup.id, status },
  });

  return { restore, engineReason };
}

export interface ListRestoresInput {
  readonly organizationId: OrganizationId;
  readonly resourceId: DataResourceId;
}

/** List a resource's restores, membership-scoped. */
export async function listDataRestores(
  ctx: RequestContext,
  deps: DataDeps,
  input: ListRestoresInput,
): Promise<readonly DataRestore[]> {
  requireCapability(ctx, input.organizationId, "data:read");
  const writes = restoreWritesFor(deps);
  const resource = await writes.getDataResource(ctx.principal.userId, input.resourceId);
  if (!resource || resource.organizationId !== input.organizationId) {
    throw new ApiError("not_found", "Data resource not found.");
  }
  return writes.listDataRestores(ctx.principal.userId, input.resourceId);
}

export interface RotateCredentialsInput {
  readonly organizationId: OrganizationId;
  readonly resourceId: DataResourceId;
  /** The operator must echo the resource's own name, as for a restore. */
  readonly confirmName: string;
}

export interface RotateCredentialsResult {
  readonly resource: DataResource;
  /**
   * The engine's own words when it could not act, and — deliberately — never the
   * new credential. The engine writes the new password into its own store and
   * the control plane keeps no copy, so there is nothing here to leak.
   */
  readonly engineReason: string | null;
}

/**
 * Rotate a database's credentials.
 *
 * Rotation is destructive in a way the engine's success does not reveal: every
 * client using the old password is about to break. It is therefore guarded like
 * a restore — membership, the resource must belong to the named organization, it
 * must have an engine handle, it must be a database (a bucket's credentials are
 * the storage engine's, not this adapter's), and the operator must echo the
 * resource's name.
 *
 * The new credential is deliberately not returned: the engine holds it, the
 * control plane does not. A caller that needs it reads it from the engine.
 */
export async function rotateDataCredentials(
  ctx: RequestContext,
  deps: DataDeps,
  input: RotateCredentialsInput,
): Promise<RotateCredentialsResult> {
  requireCapability(ctx, input.organizationId, "data:rotate");

  const writes = writesFor(deps);
  const resource = await writes.getDataResource(ctx.principal.userId, input.resourceId);
  if (!resource || resource.organizationId !== input.organizationId) {
    throw new ApiError("not_found", "Data resource not found.");
  }
  if (!resource.providerResourceId) {
    throw new ApiError(
      "conflict",
      "This resource has no engine handle yet, so its credentials cannot be rotated.",
    );
  }
  if (resource.kind !== "postgres") {
    throw new ApiError(
      "engine_unavailable",
      "Rotating the credentials of an object-storage bucket is not available in this build.",
    );
  }
  if (input.confirmName.trim() !== resource.name) {
    throw new ApiError("invalid_input", "Type the resource's name to confirm the rotation.");
  }

  const ref: ProviderRef = {
    organizationId: resource.organizationId,
    provider: (resource.provider ?? "postgres") as ProviderRef["provider"],
    resourceType: "database",
    resourceId: resource.providerResourceId,
  };

  const rotated = await deps.engines.database.rotateCredentials(
    {
      organizationId: resource.organizationId,
      idempotencyKey: `rotate-${resource.id}`,
      timeoutMs: ADAPTER_TIMEOUT_MS,
    },
    ref,
  );

  const engineReason = rotated.ok ? null : rotated.reason;

  await deps.store.recordAuditEvent({
    organizationId: resource.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: rotated.ok ? "data.credentials_rotated" : "data.credentials_rotation_failed",
    targetType: "data_resource",
    targetId: resource.id,
    metadata: { dataResourceId: resource.id, status: rotated.ok ? "succeeded" : rotated.status },
  });

  return { resource, engineReason };
}
