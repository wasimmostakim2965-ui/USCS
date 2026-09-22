export type DeploymentEnvironment = "production" | "preview" | "development";
export type DeploymentStatus = "pending" | "building" | "ready" | "failed" | "canceled" | "rolled_back";

export type DeploymentRequest = {
  deploymentId: string;
  projectId: string;
  environment: DeploymentEnvironment;
  sourceBranch?: string | null;
  commitSha?: string | null;
  sourceRepository?: string | null;
};

type DeploymentLog = { level: "debug" | "info" | "warn" | "error"; message: string };
export type HostingOperationResult =
  | { configured: true; providerRef: string; status: DeploymentStatus; deploymentUrl?: string | null; logs?: DeploymentLog[] }
  | { configured: false; reason: string };

export interface HostingAdapter {
  readonly name: string;
  readonly configured: boolean;
  createDeployment(request: DeploymentRequest): Promise<HostingOperationResult>;
  rollbackDeployment(deploymentId: string): Promise<HostingOperationResult>;
}

export class NotConfiguredHostingAdapter implements HostingAdapter {
  readonly name = "self-hosted-container-runtime";
  readonly configured = false;

  async createDeployment(_request: DeploymentRequest): Promise<HostingOperationResult> {
    return { configured: false, reason: "Self-hosted hosting runtime is not configured. Set COMPUTE_HOST after the compute API is provisioned." };
  }

  async rollbackDeployment(_deploymentId: string): Promise<HostingOperationResult> {
    return { configured: false, reason: "Self-hosted hosting runtime is not configured." };
  }
}

type ComputeResponse = { providerRef?: string; deploymentUrl?: string | null; status?: DeploymentStatus; version?: number; logs?: DeploymentLog[]; message?: string };

export class NixpacksHostingAdapter implements HostingAdapter {
  readonly name = "nixpacks-docker-tunnel-runtime";
  readonly configured = true;
  private readonly host = process.env.COMPUTE_HOST!.replace(/\/$/, "");
  private readonly token = process.env.COMPUTE_API_TOKEN;

  private async call(path: string, body: Record<string, unknown>): Promise<ComputeResponse> {
    if (!this.token) throw new Error("COMPUTE_API_TOKEN is required when COMPUTE_HOST is configured.");
    const response = await fetch(`${this.host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({})) as ComputeResponse;
    if (!response.ok) throw new Error(payload.message || `Compute API returned ${response.status}`);
    return payload;
  }

  async createDeployment(request: DeploymentRequest): Promise<HostingOperationResult> {
    try {
      const result = await this.call("/v1/deployments", {
        deploymentId: request.deploymentId,
        projectId: request.projectId,
        source: { repository: request.sourceRepository, branch: request.sourceBranch, commit: request.commitSha },
        builder: "nixpacks",
        runtime: "docker",
        isolation: "tenant-container",
        edge: { tunnel: "outbound", originPublicInbound: false, mtlsRequired: true },
        environment: request.environment,
      });
      if (!result.providerRef) throw new Error("Compute API did not return providerRef");
      return { configured: true, providerRef: result.providerRef, status: result.status ?? "ready", deploymentUrl: result.deploymentUrl ?? null, logs: result.logs ?? [{ level: "info", message: "Nixpacks build and Docker deployment accepted by compute plane." }] };
    } catch (error) {
      return { configured: false, reason: `Compute deployment failed: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  }

  async rollbackDeployment(deploymentId: string): Promise<HostingOperationResult> {
    try {
      const result = await this.call(`/v1/deployments/${encodeURIComponent(deploymentId)}/rollback`, { deploymentId });
      return { configured: true, providerRef: result.providerRef ?? deploymentId, status: result.status ?? "rolled_back", deploymentUrl: result.deploymentUrl ?? null, logs: result.logs ?? [{ level: "info", message: "Rollback accepted by compute plane." }] };
    } catch (error) {
      return { configured: false, reason: `Compute rollback failed: ${error instanceof Error ? error.message : "unknown error"}` };
    }
  }
}

export function getHostingAdapter(): HostingAdapter {
  return process.env.COMPUTE_HOST ? new NixpacksHostingAdapter() : new NotConfiguredHostingAdapter();
}
