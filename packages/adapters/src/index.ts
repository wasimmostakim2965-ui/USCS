/**
 * @cloud-wai/adapters — the ONLY place Cloud Wai touches an execution engine.
 *
 * Provider SDKs and API shapes must not leak into the UI or generic API code.
 * Every operation is idempotent, timeout-bounded, retryable with backoff and
 * auditable, and every adapter reports an honest status when the engine behind
 * it is not configured — it must never fabricate success.
 */
import type {
  AdapterResult,
  OperationRef,
  ProviderRef,
  OrganizationId,
} from "@cloud-wai/contracts";

/** Every adapter call carries the tenant it belongs to and an idempotency key. */
export interface AdapterContext {
  readonly organizationId: OrganizationId;
  /** Caller-supplied key; replaying the same key must not duplicate work. */
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

export interface DeploymentState {
  readonly ref: ProviderRef;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "degraded" | "not_configured";
  readonly url: string | null;
}

export interface LogPage {
  readonly lines: readonly string[];
  readonly cursor: string | null;
}

export interface HostingAdapter {
  createApplication(
    ctx: AdapterContext,
    input: { name: string },
  ): Promise<AdapterResult<OperationRef>>;
  deploy(
    ctx: AdapterContext,
    input: { applicationRef: ProviderRef },
  ): Promise<AdapterResult<OperationRef>>;
  getDeployment(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<DeploymentState>>;
  cancelDeployment(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  rollback(
    ctx: AdapterContext,
    input: { applicationRef: ProviderRef },
  ): Promise<AdapterResult<OperationRef>>;
  getLogs(ctx: AdapterContext, ref: ProviderRef, cursor?: string): Promise<AdapterResult<LogPage>>;
  deleteApplication(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  reconcile(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<DeploymentState>>;
}

export interface DatabaseAdapter {
  provision(ctx: AdapterContext, input: { name: string }): Promise<AdapterResult<ProviderRef>>;
  rotateCredentials(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  backup(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<ProviderRef>>;
  restore(
    ctx: AdapterContext,
    input: { backupRef: ProviderRef; targetRef: ProviderRef },
  ): Promise<AdapterResult<OperationRef>>;
  destroy(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
}

export interface StorageAdapter {
  createBucket(ctx: AdapterContext, input: { name: string }): Promise<AdapterResult<ProviderRef>>;
  deleteBucket(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
}

export interface SecurityEdgeAdapter {
  publishRoute(
    ctx: AdapterContext,
    input: { routeRef: ProviderRef },
  ): Promise<AdapterResult<OperationRef>>;
  removeRoute(ctx: AdapterContext, input: { routeRef: ProviderRef }): Promise<AdapterResult<void>>;
  applyPolicy(
    ctx: AdapterContext,
    input: { ref: ProviderRef },
  ): Promise<AdapterResult<{ version: number }>>;
  quarantine(ctx: AdapterContext, input: { ref: ProviderRef }): Promise<AdapterResult<void>>;
  inspectHealth(
    ctx: AdapterContext,
    input: { ref: ProviderRef },
  ): Promise<AdapterResult<{ healthy: boolean }>>;
}

export interface DomainResellerAdapter {
  search(ctx: AdapterContext, input: { query: string }): Promise<AdapterResult<readonly string[]>>;
  /** Registering requires credentials and legal approval; default is not_configured. */
  register(ctx: AdapterContext, input: { domain: string }): Promise<AdapterResult<OperationRef>>;
}
