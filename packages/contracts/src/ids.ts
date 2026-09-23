/**
 * Core Cloud Wai domain identifiers.
 *
 * Every externally visible record is identified by a Cloud Wai-owned UUID.
 * Provider (engine) identifiers are stored separately as references and are
 * never used as the tenant boundary — see `ProviderRef`.
 */

export type Uuid = string;

/** Organization = the tenant boundary. */
export type OrganizationId = Uuid;
export type UserId = Uuid;
export type ProjectId = Uuid;
export type EnvironmentId = Uuid;
export type DeploymentId = Uuid;
export type DataResourceId = Uuid;
export type DomainId = Uuid;
export type SecurityPolicyId = Uuid;
export type ApiKeyId = Uuid;
export type OrchestrationJobId = Uuid;
export type AuditEventId = Uuid;

/**
 * A reference to an object owned by an execution engine.
 *
 * `organizationId` is recorded alongside every provider reference so that an
 * engine response can never be mistaken for a tenant boundary on its own.
 */
export interface ProviderRef {
  readonly organizationId: OrganizationId;
  readonly provider: ProviderName;
  readonly resourceType: string;
  readonly resourceId: string;
}

export const PROVIDER_NAMES = [
  "coolify",
  "postgres",
  "minio",
  "envoy",
  "haproxy",
  "coraza",
  "crowdsec",
  "nftables",
  "domain-reseller",
  "fake",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** A principal resolved from the authenticated Supabase session. */
export interface Principal {
  readonly userId: UserId;
  readonly email: string;
  readonly displayName: string | null;
}

/**
 * Lifecycle of an orchestration job.
 *
 * Distinct from `EngineStatus`: a job is a unit of Cloud Wai work, and it
 * finishes as `succeeded` only when the engine actually succeeded.
 */
export const JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export type JobState = (typeof JOB_STATES)[number];

export function isJobTerminal(state: JobState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}
