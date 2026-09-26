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
  /**
   * Serverless execution engine (AWS Lambda and equivalents).
   *
   * A workload whose provider is `lambda` does not run on the container host at
   * all: the edge forwards to a serverless function, so there is no always-on
   * origin to reach. It is a distinct provider rather than a Coolify build pack
   * because it is a different execution model with its own lifecycle, not a
   * setting of the container engine.
   */
  "lambda",
  /**
   * Micro-VM execution engine (Firecracker-class, e.g. a managed microVM
   * service). Kept separate from `lambda` because the isolation boundary and the
   * API are different; an adapter for one must not silently answer for the other.
   */
  "microvm",
  /**
   * Source-to-image build engine (Railpack and equivalents).
   *
   * Its own provider because a build is neither a hosting nor a serverless
   * operation: it turns source into an artifact, and both of those engines
   * consume the result without knowing how it was produced (ADR-0018).
   */
  "railpack",
  "fake",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * How a project's workload is executed.
 *
 * A customer-facing choice, distinct from `ProviderName`: it says *which
 * execution model* runs the application, and the API and worker map it onto a
 * concrete engine. `container` is a long-lived application on the container
 * engine (Coolify). `serverless` is a function on the serverless engine
 * (Lambda), which the edge forwards to and which has no always-on origin.
 *
 * It is its own type, not a `ProviderName`, so a customer cannot name an engine
 * directly — "run serverless" is a model, and the platform decides which
 * provider satisfies it.
 */
export type ExecutionModel = "container" | "serverless";

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
