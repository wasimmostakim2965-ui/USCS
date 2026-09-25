/**
 * The worker's backup job: take the backup, then mirror the result.
 *
 * The resource is re-read on the service role and the engine handle comes from
 * that row, never from the payload, so a job cannot address an engine artifact
 * the tenant does not own. A resource with no handle, or a bucket with no backup
 * path in this build, is refused with the engine's own vocabulary rather than
 * recorded as a backup that names nothing.
 */
import type { AdapterResult, EngineStatus, ProviderRef } from "@cloud-wai/contracts";
import { err, ok, BACKUP_JOB_KIND, type BackupJobPayload } from "@cloud-wai/contracts";
import type { DatabaseAdapter, Job } from "@cloud-wai/adapters";
import type { DataBackup, DataResource } from "@cloud-wai/database";
import type { JobHandler } from "./processor.js";

export interface BackupExecutionWrites {
  /** The resource, scoped by organization, for a caller with no session. */
  getDataResourceForService(
    organizationId: string,
    resourceId: string,
  ): Promise<DataResource | null>;
  updateDataBackupStatus(input: {
    readonly id: string;
    readonly organizationId: string;
    readonly status: EngineStatus;
    readonly providerResourceId: string | null;
    readonly finishedAt: string | null;
  }): Promise<DataBackup | null>;
  /** Record the outcome. The worker is the actor here; the payload names the member. */
  recordAuditEvent(input: {
    readonly organizationId: string;
    readonly actorId: string | null;
    readonly actorEmail: string | null;
    readonly event: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<unknown>;
  /**
   * Record one unit of usage when the engine confirmed the work.
   *
   * Only a `succeeded` backup is recorded: a metric counts work that happened,
   * and a `not_configured` or `failed` run is not a unit the customer used.
   */
  recordUsage(input: {
    readonly organizationId: string;
    readonly metric: string;
    readonly quantity: number;
  }): Promise<unknown>;
}

export interface BackupJobDeps {
  readonly database: DatabaseAdapter;
  readonly writes: BackupExecutionWrites;
  readonly now?: () => Date;
}

export interface BackupExecutionResult {
  readonly status: EngineStatus;
  readonly providerResourceId: string | null;
  readonly reason: string | null;
}

/** The handler for `data.backup.execute`. */
export function buildBackupJobHandler(deps: BackupJobDeps): JobHandler {
  return async (payload, ctx) => {
    const input = payload as BackupJobPayload;
    const resource = await deps.writes.getDataResourceForService(
      input.organizationId,
      input.dataResourceId,
    );
    if (!resource || resource.organizationId !== input.organizationId) {
      return err("failed", "The data resource this backup names no longer exists.");
    }
    if (!resource.providerResourceId) {
      return err(
        "not_configured",
        "This resource has no engine handle, so it cannot be backed up.",
      );
    }
    if (resource.kind !== "postgres") {
      return err(
        "not_configured",
        "Backing up an object-storage bucket is not available in this build yet.",
      );
    }

    const ref: ProviderRef = {
      organizationId: resource.organizationId,
      provider: (resource.provider ?? "postgres") as ProviderRef["provider"],
      resourceType: "database",
      resourceId: resource.providerResourceId,
    };
    const taken = await deps.database.backup(
      { ...ctx, organizationId: resource.organizationId },
      ref,
    );
    if (taken.ok) {
      return ok<BackupExecutionResult>(taken.status, {
        status: taken.status,
        providerResourceId: taken.value.resourceId,
        reason: null,
      });
    }
    return err(taken.status, taken.reason);
  };
}

/** The applier: write the engine's own status onto the backup row. */
export function buildBackupApplier(
  deps: BackupJobDeps,
): (job: Job, result: AdapterResult<unknown>) => Promise<void> {
  const clock = deps.now ?? (() => new Date());
  return async (job, result) => {
    if (job.kind !== BACKUP_JOB_KIND) return;
    const payload = job.payload as BackupJobPayload;
    const finished = clock().toISOString();
    const value = result.ok ? (result.value as BackupExecutionResult | undefined) : undefined;
    const status = value?.status ?? result.status;
    await deps.writes.updateDataBackupStatus({
      id: payload.backupId,
      organizationId: payload.organizationId,
      status,
      providerResourceId: value?.providerResourceId ?? null,
      finishedAt: finished,
    });
    await deps.writes.recordAuditEvent({
      organizationId: payload.organizationId,
      actorId: payload.actorId,
      actorEmail: payload.actorEmail,
      event: status === "succeeded" ? "data.backup_completed" : "data.backup_failed",
      targetType: "data_backup",
      targetId: payload.backupId,
      metadata: { dataResourceId: payload.dataResourceId, status },
    });
    // Usage is a count of work the engine confirmed. A failed or unconfigured
    // backup is recorded above as a fact about the attempt, but it is not a unit
    // the organization consumed, so no usage row is written for it.
    if (status === "succeeded") {
      await deps.writes.recordUsage({
        organizationId: payload.organizationId,
        metric: "backups",
        quantity: 1,
      });
    }
  };
}
