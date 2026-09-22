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

export type HostingOperationResult =
  | { configured: true; providerRef: string; status: DeploymentStatus; deploymentUrl?: string | null }
  | { configured: false; reason: string };

export interface HostingAdapter {
  readonly name: string;
  readonly configured: boolean;
  createDeployment(request: DeploymentRequest): Promise<HostingOperationResult>;
  rollbackDeployment(deploymentId: string): Promise<HostingOperationResult>;
}

/**
 * The control plane must never claim a deployment ran when the self-operated
 * hosting plane has not been provisioned. Phase 4 supplies the concrete
 * container/runtime implementation behind this interface.
 */
export class NotConfiguredHostingAdapter implements HostingAdapter {
  readonly name = "self-hosted-container-runtime";
  readonly configured = false;

  async createDeployment(_request: DeploymentRequest): Promise<HostingOperationResult> {
    return { configured: false, reason: "Self-hosted hosting runtime is not configured." };
  }

  async rollbackDeployment(_deploymentId: string): Promise<HostingOperationResult> {
    return { configured: false, reason: "Self-hosted hosting runtime is not configured." };
  }
}

export function getHostingAdapter(): HostingAdapter {
  // Do not infer readiness from an arbitrary environment variable. The
  // concrete adapter is enabled only when Phase 4 provisions and registers it.
  return new NotConfiguredHostingAdapter();
}
