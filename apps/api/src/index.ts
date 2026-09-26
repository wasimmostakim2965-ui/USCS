/**
 * @cloud-wai/api — Cloud Wai API/BFF. Every procedure resolves a principal, enforces organization scope server-side, and never trusts a client-supplied organization id.
 */

export const APP_NAME = "api" as const;

export { ApiError, isApiError } from "./errors.js";
export { buildContext } from "./context.js";
export type { RequestContext, AuthenticatedRequest, ContextDeps } from "./context.js";
export { allowed, requireCapability, roleFor } from "./guard.js";
export { buildRouter } from "./router.js";
export type { RouterDeps, RpcRequest, RpcResponse } from "./router.js";
export { createHttpServer, listen } from "./server.js";
export type { ServerDeps, HttpServer } from "./server.js";
export { createDeployment, start, allowedOriginsFromEnv } from "./bootstrap.js";
export type { Deployment, ApiDeploymentDeps, StartupOptions, StartupResult } from "./bootstrap.js";
export {
  listOrganizations,
  createOrganization,
  getOrganization,
  listProjects,
  getProject,
  createProject,
  mayReadProject,
} from "./procedures/organizations.js";
export type { OrgDeps } from "./procedures/organizations.js";
export {
  deploymentsLogs,
  requestDeployment,
  listAuditEvents,
  listDeployments,
  rollbackDeployment,
  redeployDeployment,
  DEPLOYMENT_PROCEDURE_STATES,
} from "./procedures/deployments.js";
export type {
  CreateDeploymentInput,
  DeploymentDeps,
  DeploymentLogsInput,
  DeploymentLogsResult,
  DeploymentRequestResult,
  RedeployDeploymentInput,
  RollbackDeploymentInput,
} from "./procedures/deployments.js";
export { buildProcedures, procedureNames, ROUTE_SHAPES } from "./procedures/index.js";
export {
  backupDataResource,
  listDataBackups,
  provisionDataResource,
  DATA_RESOURCE_KINDS,
} from "./procedures/data.js";
export type {
  BackupDataInput,
  BackupDataResult,
  DataDeps,
  DataResourceKind,
  ListBackupsInput,
  ProvisionDataInput,
  ProvisionDataResult,
} from "./procedures/data.js";
export {
  distributeSecurityPolicy,
  readSecurityPolicy,
  saveSecurityPolicy,
} from "./procedures/security.js";
export type {
  DistributePolicyInput,
  DistributePolicyResult,
  SavePolicyInput,
  SecurityDeps,
} from "./procedures/security.js";
export {
  connectGitLink,
  disconnectGitLink,
  listGitLinks,
  verifyGitDelivery,
  gitLinkForService,
  GIT_PROVIDERS,
  defaultWebhookSecret,
  cloneUrlFor,
  deploymentSourceForProject,
  deployFromLink,
} from "./procedures/git-links.js";
export type {
  ConnectGitLinkInput,
  ConnectedGitLink,
  DisconnectGitLinkInput,
  GitDeliveryVerification,
  GitLinkDeps,
  GitProvider,
  ListGitLinksInput,
  VerifyGitDeliveryInput,
  DeployFromLink,
  DeployNowInput,
} from "./procedures/git-links.js";
export { receiveGitDelivery, deployFromDelivery, parseGitDelivery } from "./git-hook.js";
export type { GitHookDeps, GitHookOutcome, ParsedGitDelivery } from "./git-hook.js";

export interface AppDescriptor {
  readonly name: string;
  readonly role: string;
  /** Boundaries this app enforces; asserted by tests in tests/. */
  readonly boundaries: readonly string[];
}

export function describe(): AppDescriptor {
  return {
    name: APP_NAME,
    role: "Cloud Wai API/BFF. Every procedure resolves a principal, enforces organization scope server-side, and never trusts a client-supplied organization id.",
    boundaries: [
      "Resolves the principal from the Supabase session on every request.",
      "Resolves organization membership server-side; never trusts client org ids.",
      "Enqueues commands instead of calling engines directly.",
      "Returns honest not_configured/degraded states instead of faking success.",
    ],
  };
}
