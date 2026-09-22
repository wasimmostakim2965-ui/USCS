export type AdapterStatus = "ready" | "not_configured" | "error";
export type AdapterResult<T> = { status: AdapterStatus; data: T | null; message: string };
export type ProjectRef = { organizationId: string; projectId: string };
export type DeploymentRequest = ProjectRef & { sourceRef: string; environment: "preview" | "production" };
export type DatabaseRequest = ProjectRef & { name: string; engine: "postgres" };
export type StorageRequest = ProjectRef & { name: string; visibility: "private" | "public" };
export type SecurityEdgeConfig = ProjectRef & { desiredConfig: Record<string, unknown> };
export type SecurityEdgeArtifactSet = Record<string, string>;

export interface HostingAdapter { deploy(input: DeploymentRequest): Promise<AdapterResult<{ deploymentId: string }>>; rollback(input: ProjectRef & { deploymentId: string }): Promise<AdapterResult<{ deploymentId: string }>>; }
export interface DatabaseAdapter { provision(input: DatabaseRequest): Promise<AdapterResult<{ instanceId: string; endpoint: string }>>; }
export interface StorageAdapter { provision(input: StorageRequest): Promise<AdapterResult<{ bucketId: string }>>; }
export interface DnsAdapter { listRecords(input: { domainId: string }): Promise<AdapterResult<Array<{ type: string; name: string; value: string }>>>; applyRecords(input: { domainId: string; records: Array<{ type: string; name: string; value: string; ttl?: number }> }): Promise<AdapterResult<{ applied: number }>>; }
export interface EmailAdapter { send(input: { to: string; subject: string; text: string }): Promise<AdapterResult<{ messageId: string }>>; }
export interface SecurityEdgeAdapter { render(input: SecurityEdgeConfig): Promise<AdapterResult<SecurityEdgeArtifactSet>>; preview(input: SecurityEdgeConfig): Promise<AdapterResult<{ diff: Array<{ path: string; before: unknown; after: unknown }>; artifacts?: SecurityEdgeArtifactSet }>>; apply(input: SecurityEdgeConfig): Promise<AdapterResult<{ appliedAt: string; version: number }>>; }

class NotConfiguredBase {
  constructor(public readonly name: string) {}
  protected notConfigured<T>(message: string): AdapterResult<T> { return { status: "not_configured", data: null, message }; }
}
export class NotConfiguredHostingAdapter extends NotConfiguredBase implements HostingAdapter {
  async deploy(_input: DeploymentRequest) { return this.notConfigured<{ deploymentId: string }>("Hosting runtime is not configured."); }
  async rollback(_input: ProjectRef & { deploymentId: string }) { return this.notConfigured<{ deploymentId: string }>("Hosting runtime is not configured."); }
}
export class NotConfiguredDatabaseAdapter extends NotConfiguredBase implements DatabaseAdapter {
  async provision(_input: DatabaseRequest) { return this.notConfigured<{ instanceId: string; endpoint: string }>("Self-hosted Postgres data plane is not configured."); }
}
export class NotConfiguredStorageAdapter extends NotConfiguredBase implements StorageAdapter {
  async provision(_input: StorageRequest) { return this.notConfigured<{ bucketId: string }>("Self-hosted MinIO storage plane is not configured."); }
}
export class NotConfiguredDnsAdapter extends NotConfiguredBase implements DnsAdapter {
  async listRecords(_input: { domainId: string }) { return this.notConfigured<Array<{ type: string; name: string; value: string }>>("DNS adapter is not configured."); }
  async applyRecords(_input: { domainId: string; records: Array<{ type: string; name: string; value: string; ttl?: number }> }) { return this.notConfigured<{ applied: number }>("DNS adapter is not configured."); }
}
export class NotConfiguredEmailAdapter extends NotConfiguredBase implements EmailAdapter {
  async send(_input: { to: string; subject: string; text: string }) { return this.notConfigured<{ messageId: string }>("Self-hosted email engine is not configured."); }
}
export class NotConfiguredSecurityEdgeAdapter extends NotConfiguredBase implements SecurityEdgeAdapter {
  async render(_input: SecurityEdgeConfig) { return this.notConfigured<SecurityEdgeArtifactSet>("Self-hosted security edge is not configured."); }
  async preview(_input: SecurityEdgeConfig) { return this.notConfigured<{ diff: Array<{ path: string; before: unknown; after: unknown }> }>("Self-hosted security edge is not configured."); }
  async apply(_input: SecurityEdgeConfig) { return this.notConfigured<{ appliedAt: string; version: number }>("Self-hosted security edge is not configured."); }
}

export function getPlatformAdapters() {
  return {
    hosting: new NotConfiguredHostingAdapter("self-hosted-hosting"),
    database: new NotConfiguredDatabaseAdapter("self-hosted-postgres"),
    storage: new NotConfiguredStorageAdapter("self-hosted-minio"),
    dns: new NotConfiguredDnsAdapter("self-hosted-dns"),
    email: new NotConfiguredEmailAdapter("self-hosted-email"),
    securityEdge: new NotConfiguredSecurityEdgeAdapter("self-hosted-security-edge"),
  };
}
