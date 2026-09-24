/**
 * Durable command kinds the API enqueues.
 *
 * A payload lives in `contracts` because both the API (which writes it) and the
 * worker (which reads it) depend on this package, and neither app may import the
 * other. Payloads are plain data: no adapter type, no engine SDK handle. Where a
 * job needs an engine-side reference (the deployment's application, the backup's
 * database), the worker resolves it from the row it was given rather than
 * trusting an id baked into a payload that may have gone stale.
 */
import type { OrganizationId, ProjectId } from "./ids.js";

export const DEPLOYMENT_JOB_KIND = "deployments.execute";

export interface DeploymentJobPayload {
  /** The deployment row this job advances. The API wrote it before enqueuing. */
  readonly deploymentId: string;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly action: "create" | "rollback";
  /** The project slug, used as the application name on first create. */
  readonly projectSlug: string;
  readonly gitRepository: string | null;
  readonly gitBranch: string | null;
  /** A `BuildPack` value, kept as a string so contracts stays adapter-free. */
  readonly buildPack: string | null;
  /** The git revision a rollback returns to. */
  readonly commit: string | null;
}

export const BACKUP_JOB_KIND = "data.backup.execute";

/** A backup requested against a provisioned data resource. */
export interface BackupJobPayload {
  readonly backupId: string;
  readonly organizationId: OrganizationId;
  readonly dataResourceId: string;
  /** The engine handle recorded at provisioning, so the job can address it. */
  readonly providerResourceId: string;
  readonly provider: string;
}

export const POLICY_JOB_KIND = "policy.distribute.execute";

/** A distribution of the stored policy to the security edge. */
export interface PolicyJobPayload {
  readonly organizationId: OrganizationId;
  readonly policyId: string;
  /** The version the API saw. The worker re-reads before applying. */
  readonly version: number;
}
