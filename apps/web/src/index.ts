/**
 * @cloud-wai/web — Cloud Wai dashboard (React, URL-driven routes). Talks only to the Cloud Wai API.
 */

export const APP_NAME = "web" as const;

export { parseRoute, toPath } from "./routes.js";
export type { Route } from "./routes.js";
export { ApiClient } from "./api-client.js";
export type { ApiClientOptions, ApiResponse } from "./api-client.js";
export {
  itemFrom,
  loadOrganizations,
  loadOrganization,
  loadProjects,
  loadProject,
  loadDeployments,
  loadDomains,
  loadDataResources,
  loadApiKeys,
  loadProviderHealth,
  loadAudit,
  loadRoute,
  sectionFrom,
} from "./view-model.js";
export type {
  OrganizationSummary,
  ProjectSummary,
  DeploymentSummary,
  DeploymentRequestSummary,
  DomainSummary,
  DataResourceSummary,
  ApiKeySummaryRow,
  ProviderHealthRow,
  AuditSummary,
  DashboardModel,
} from "./view-model.js";
export {
  backTargetFor,
  databaseNav,
  databaseSectionTitle,
  navForRoute,
  projectNav,
  titleForRoute,
  workspaceNav,
} from "./navigation.js";
export type { NavContext, NavItem } from "./navigation.js";
export { DATABASE_SECTIONS } from "./routes.js";
export type { DatabaseSection } from "./routes.js";
export {
  createSessionController,
  sessionConfigFromEnv,
  unconfiguredSessionController,
} from "./session.js";
export type { BrowserSession, SessionConfig, SessionController } from "./session.js";
export { App } from "./App.js";
export type { AppProps } from "./App.js";

export interface AppDescriptor {
  readonly name: string;
  readonly role: string;
  /** Boundaries this app enforces; asserted by tests in tests/. */
  readonly boundaries: readonly string[];
}

export function describe(): AppDescriptor {
  return {
    name: APP_NAME,
    role: "Cloud Wai dashboard (React, URL-driven routes). Talks only to the Cloud Wai API.",
    boundaries: [
      "Calls only the Cloud Wai API, never an engine, database or admin port.",
      "Renders loading/empty/success/degraded/error and no fabricated success.",
    ],
  };
}
