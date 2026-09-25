/**
 * The worker's restore job: run the engine's restore, then mirror the result.
 *
 * Same discipline as `backup-job.ts`: both the resource and the backup are
 * re-read on the service role and their engine handles come from those rows,
 * never from the payload, so a job cannot overwrite a database the tenant does
 * not own or read a backup that is not theirs. A resource with no handle, a
 * non-Postgres resource, or a backup that names no artifact is refused with the
 * engine's own vocabulary rather than recorded as a restore that did nothing.
 */
import type { AdapterResult, EngineStatus, ProviderRef } from "@cloud-wai/contracts";
import { err, ok, RESTORE_JOB_KIND, type RestoreJobPayload } from "@cloud-wai/contracts";
import type { DatabaseAdapter, Job } from "@cloud-wai/adapters";
import type { DataBackup, DataResource, DataRestore } from "@cloud-wai/database";
import type { JobHandler } from "./processor.js";

export interface RestoreExecutionWrites {
  /** The resource, scoped by organization, for a caller with no session. */
  getDataResourceForService(
    organizationId: string,
    resourceId: string,
  ): Promise<DataResource | null>;
  /** The backup, scoped by organization, for a caller with no session. */
  getDataBackupForService(organizationId: string, backupId: string): Promise<DataBackup | null>;
  updateDataRestoreStatus(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly status: EngineStatus;
    readonly providerResourceId: string | null;
    readonly finishedAt: string | null;
  }): Promise<DataRestore | null>;
  recordAuditEvent(input: {
    readonly organizationId: string;
    readonly actorId: string | null;
    readonly actorEmail: string | null;
    readonly event: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface RestoreJobDeps {
  readonly database: DatabaseAdapter;
  readonly writes: RestoreExecutionWrites;
  readonly now?: () => Date;
}

export interface RestoreExecutionResult {
  readonly status: EngineStatus;
  readonly providerResourceId: string | null;
  readonly reason: string | null;
}

/** The handler for `data.restore.execute`. */
export function buildRestoreJobHandler(deps: RestoreJobDeps): JobHandler {
  return async (payload, ctx) => {
    const input = payload as RestoreJobPayload;
    const resource = await deps.writes.getDataResourceForService(
      input.organizationId,
      input.dataResourceId,
    );
    if (!resource || resource.organizationId !== input.organizationId) {
      return err("failed", "The data resource this restore names no longer exists.");
    }
    if (resource.kind !== "postgres") {
      return err(
        "not_configured",
        "Restoring an object-storage bucket is not available in this build yet.",
      );
    }
    if (!resource.providerResourceId) {
      return err("not_configured", "This resource has no engine handle, so it cannot be restored.");
    }

    const backup = await deps.writes.getDataBackupForService(input.organizationId, input.backupId);
    if (!backup || backup.dataResourceId !== resource.id) {
      return err("failed", "The backup this restore names no longer exists for this resource.");
    }
    if (backup.status !== "succeeded" || !backup.providerResourceId) {
      return err("failed", "That backup did not complete, so there is nothing to restore from it.");
    }

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

    const performed = await deps.database.restore(
      { ...ctx, organizationId: resource.organizationId },
      { backupRef, targetRef },
    );
    if (performed.ok) {
      return ok<RestoreExecutionResult>(performed.status, {
        status: performed.status,
        providerResourceId: performed.value.jobId,
        reason: null,
      });
    }
    return err(performed.status, performed.reason);
  };
}

/** The applier: write the engine's own status onto the restore row. */
export function buildRestoreApplier(
  deps: RestoreJobDeps,
): (job: Job, result: AdapterResult<unknown>) => Promise<void> {
  const clock = deps.now ?? (() => new Date());
  return async (job, result) => {
    if (job.kind !== RESTORE_JOB_KIND) return;
    const payload = job.payload as RestoreJobPayload;
    const finished = clock().toISOString();
    const value = result.ok ? (result.value as RestoreExecutionResult | undefined) : undefined;
    const status = value?.status ?? result.status;
    await deps.writes.updateDataRestoreStatus({
      id: payload.restoreId,
      organizationId: payload.organizationId,
      status,
      providerResourceId: value?.providerResourceId ?? null,
      finishedAt: finished,
    });
    await deps.writes.recordAuditEvent({
      organizationId: payload.organizationId,
      actorId: payload.actorId,
      actorEmail: payload.actorEmail,
      event: status === "succeeded" ? "data.restore_completed" : "data.restore_failed",
      targetType: "data_restore",
      targetId: payload.restoreId,
      metadata: { dataResourceId: payload.dataResourceId, backupId: payload.backupId, status },
    });
  };
}
