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
  loadDeploymentLogs,
  promoteDeployment,
  BUILD_PACK_OPTIONS,
  loadDomains,
  loadDataResources,
  loadDataLogs,
  loadApiKeys,
  loadProviderHealth,
  loadAudit,
  auditCsv,
  loadUsage,
  loadBudgets,
  loadRoute,
  loadSecurityRules,
  loadTrustedSources,
  addTrustedSource,
  removeTrustedSource,
  cloneUrlFor,
  loadGitDeploySource,
  deployFromLink,
  sectionFrom,
} from "./view-model.js";
export type {
  OrganizationSummary,
  ProjectSummary,
  BuildPack,
  DeploymentSummary,
  DeploymentLogsSummary,
  DeploymentRequestSummary,
  PromoteDeploymentSummary,
  DomainSummary,
  DataResourceSummary,
  DataLogSummary,
  ApiKeySummaryRow,
  ProviderHealthRow,
  AuditSummary,
  UsageTotalSummary,
  BudgetSummary,
  DashboardModel,
  SecurityRuleSummary,
  TrustedSourceSummary,
} from "./view-model.js";
export {
  backTargetFor,
  databaseNav,
  databaseSectionTitle,
  navForRoute,
  navGroups,
  projectNav,
  titleForRoute,
  workspaceNav,
} from "./navigation.js";
export type { NavContext, NavGroup, NavItem, NavLevel } from "./navigation.js";
export { DATABASE_SECTIONS, SECTION_SUBS, isSubSection, subSectionTitle } from "./routes.js";
export type { DatabaseSection } from "./routes.js";
export {
  DOC_INTRO,
  DOC_SECTIONS,
  DOC_STATUS_DESCRIPTIONS,
  DOC_STATUS_LABELS,
} from "./docs/content.js";
export type { DocDiagram, DocSection, DocStatus } from "./docs/content.js";
export { buildMenuMap, PROJECT_PLACEHOLDER } from "./docs/menu-map.js";
export type { MenuLevelId, MenuMapEntry, MenuMapLevel } from "./docs/menu-map.js";
export {
  createSessionController,
  enabledProvidersFromSettings,
  listEnabledProviders,
  sessionConfigFromEnv,
  unconfiguredSessionController,
  withDemoSession,
} from "./session.js";
export type { BrowserSession, SessionConfig, SessionController, OAuthProvider } from "./session.js";
export { OAuthProviderIds } from "./session.js";
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
