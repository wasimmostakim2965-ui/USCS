/**
 * View models.
 *
 * Each loader turns an API response into a `Section`. The mapping is the only
 * place a response becomes something a component renders, and it follows one
 * rule: a failure and an unconfigured engine both produce a section with no
 * data. There is no code path that yields `ready` items from a non-ok response.
 */
import { errored, loading, ready, type Section } from "@cloud-wai/ui";
import type { ApiClient, ApiResponse } from "./api-client.js";
import type { Route } from "./routes.js";
import { databaseSectionTitle } from "./navigation.js";

export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface ProjectSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
}

export interface DeploymentSummary {
  readonly id: string;
  readonly projectId: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "degraded" | "not_configured";
  readonly url: string | null;
  readonly failureReason: string | null;
}

/**
 * The answer to a deployment request.
 *
 * `replayed` says the idempotency key matched an earlier deployment, so nothing
 * new was queued. `engineReason` is the engine's own words when it could not
 * act — shown as "not configured" rather than as a failure the operator caused.
 */
export interface DeploymentRequestSummary {
  readonly deployment: DeploymentSummary;
  readonly replayed: boolean;
  readonly engineReason: string | null;
}

export interface AuditSummary {
  readonly id: string;
  readonly event: string;
  readonly actorEmail: string;
  readonly createdAt: string;
}

/**
 * Convert a response to a section.
 *
 * `notConfigured` is checked before `ok`: the server may answer successfully
 * with an explicit "this deployment cannot do that" marker, and that must render
 * as degraded rather than as an empty list.
 */
export function sectionFrom<T>(title: string, response: ApiResponse<readonly T[]>): Section<T> {
  if (response.notConfigured) {
    return {
      title,
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored(title, response.error?.message ?? "Request failed.");
  }
  return ready(title, response.data ?? []);
}

/** Load the organization list. */
export async function loadOrganizations(client: ApiClient): Promise<Section<OrganizationSummary>> {
  const response = await client.call<readonly OrganizationSummary[]>("organizations.list");
  return sectionFrom("Organizations", response);
}

/** Load the projects of one organization. */
export async function loadProjects(
  client: ApiClient,
  organizationId: string,
): Promise<Section<ProjectSummary>> {
  const response = await client.call<readonly ProjectSummary[]>("projects.list", {
    organizationId,
  });
  return sectionFrom("Projects", response);
}

/** Load the deployments of one project. */
export async function loadDeployments(
  client: ApiClient,
  projectId: string,
): Promise<Section<DeploymentSummary>> {
  const response = await client.call<readonly DeploymentSummary[]>("deployments.list", {
    projectId,
  });
  return sectionFrom("Deployments", response);
}

export interface DeploymentLogsSummary {
  readonly lines: readonly string[];
  readonly cursor: string | null;
  /** `deployment` = this run's build/deploy log; `application` = runtime tail. */
  readonly source: "deployment" | "application" | null;
  /** The engine's own words when it could not serve logs. */
  readonly engineReason: string | null;
}

/**
 * Load a deployment's engine logs.
 *
 * The lines are the engine's own output. A not-configured engine, or a project
 * that was never deployed, answers with an honest reason and no lines; there is
 * no path here that invents log output.
 */
export async function loadDeploymentLogs(
  client: ApiClient,
  projectId: string,
  deploymentId: string,
): Promise<DeploymentLogsSummary> {
  const response = await client.call<DeploymentLogsSummary>("deployments.logs", {
    projectId,
    deploymentId,
  });
  if (response.notConfigured) {
    return {
      lines: [],
      cursor: null,
      source: null,
      engineReason: response.error?.message ?? "The hosting engine is not configured.",
    };
  }
  if (!response.ok || !response.data) {
    return {
      lines: [],
      cursor: null,
      source: null,
      engineReason: response.error?.message ?? "The logs could not be loaded.",
    };
  }
  return response.data;
}

/**
 * Convert a single-object response to a section.
 *
 * Same rule as `sectionFrom`: a missing row, a failure and an unconfigured
 * engine all produce a section that carries no item, so a detail page cannot
 * render a blank object as if it had loaded.
 */
export function itemFrom<T>(
  title: string,
  response: ApiResponse<T | null | undefined>,
  missingMessage = "Not found.",
): Section<T> {
  if (response.notConfigured) {
    return {
      title,
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored(title, response.error?.message ?? "Request failed.");
  }
  if (response.data === null || response.data === undefined) {
    return errored(title, missingMessage);
  }
  return ready(title, [response.data]);
}

/** Load one project by id. */
export async function loadProject(
  client: ApiClient,
  projectId: string,
): Promise<Section<ProjectSummary>> {
  const response = await client.call<ProjectSummary>("projects.get", { projectId });
  return itemFrom("Project", response, "This project does not exist, or you are not a member.");
}

/** Load one organization by id. */
export async function loadOrganization(
  client: ApiClient,
  organizationId: string,
): Promise<Section<OrganizationSummary>> {
  const response = await client.call<OrganizationSummary>("organizations.get", {
    organizationId,
  });
  return itemFrom(
    "Organization",
    response,
    "This organization does not exist, or you are not a member.",
  );
}

export interface DomainSummary {
  readonly id: string;
  readonly hostname: string;
  readonly verified: boolean;
  readonly verifiedAt: string | null;
}

/**
 * The answer to a domain request.
 *
 * `recordName` and `recordValue` are the DNS challenge the customer must
 * publish. It is a public value, so showing it is correct — unlike a key secret.
 */
export interface DomainChallengeSummary {
  readonly domain: DomainSummary;
  readonly recordName: string;
  readonly recordValue: string;
  readonly recordType: string;
}

export interface DomainVerificationSummary {
  readonly domain: DomainSummary;
  readonly detail: string;
}

export interface DataResourceSummary {
  readonly id: string;
  readonly kind: "postgres" | "object_storage";
  readonly name: string;
  /** The project this resource belongs to, or null when it is organization-wide. */
  readonly projectId?: string | null;
  /** Mirrors the `data_resource_state` enum. The server, never the client, writes it. */
  readonly state: "provisioning" | "ready" | "restoring" | "failed" | "not_configured";
}

/** A provision or backup answer, with the engine's own words when it refused. */
export interface ProvisionDataSummary {
  readonly resource: DataResourceSummary;
  readonly engineReason: string | null;
}

export interface BackupDataSummary {
  readonly backup: DataBackupSummary;
  readonly engineReason: string | null;
}

/** One backup attempt, with the engine's own status. */
export interface DataBackupSummary {
  readonly id: string;
  readonly dataResourceId: string;
  readonly status: "pending" | "running" | "succeeded" | "failed" | "not_configured";
  readonly providerResourceId: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface SecurityPolicySummary {
  readonly id: string;
  readonly name: string;
  readonly riskLevel: "low" | "medium" | "high" | "critical";
  readonly action: "allow" | "log" | "challenge" | "block" | "quarantine";
  readonly state: "draft" | "compiled" | "distributed" | "active" | "rejected" | "degraded";
  readonly version: number;
  readonly updatedAt: string;
}

export interface SecurityPolicyReadSummary {
  readonly policy: SecurityPolicySummary | null;
  readonly events: readonly SecurityPolicyEventSummary[];
}

/** One transition in a policy's lifecycle, as the server recorded it. */
export interface SecurityPolicyEventSummary {
  readonly id: string;
  readonly toState: string;
  readonly fromState: string | null;
  readonly version: number;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface DistributePolicySummary {
  readonly policy: SecurityPolicySummary;
  readonly distributed: boolean;
  readonly engineReason: string | null;
}

export interface ApiKeySummaryRow {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: readonly string[];
  readonly revokedAt: string | null;
}

/** The secret exists on the create response and nowhere else. */
export interface IssuedApiKey {
  readonly key: ApiKeySummaryRow;
  readonly secret: string;
}

/**
 * The scopes a key can be granted, offered in the create form.
 *
 * These mirror the server's capability list. The server narrows whatever is
 * requested to the caller's own role before it stores the key, so offering one
 * a member cannot hold is harmless: the request succeeds and the granted scopes
 * come back narrower than asked for.
 */
export const API_KEY_SCOPES: readonly string[] = [
  "org:read",
  "project:read",
  "project:create",
  "deployment:read",
  "deployment:create",
  "data:read",
  "domain:read",
  "security:read",
  "apikey:read",
  "audit:read",
];

/** An engine the dashboard shows, with the honest reason for its state. */
export interface ProviderHealthRow {
  readonly provider: string;
  readonly state: "ready" | "not_configured";
  readonly detail: string;
}

/** Load an organization's domains. */
export async function loadDomains(
  client: ApiClient,
  organizationId: string,
): Promise<Section<DomainSummary>> {
  const response = await client.call<readonly DomainSummary[]>("domains.list", { organizationId });
  return sectionFrom("Domains", response);
}

/** Load an organization's data resources. */
export async function loadDataResources(
  client: ApiClient,
  organizationId: string,
): Promise<Section<DataResourceSummary>> {
  const response = await client.call<readonly DataResourceSummary[]>("data.list", {
    organizationId,
  });
  return sectionFrom("Databases and storage", response);
}

/**
 * Load a resource's backups.
 *
 * The server records every attempt with the engine's own status. Reading them
 * back is what makes a backup auditable: a `failed` or `not_configured` attempt
 * is visible as such rather than lost once the dialog closes.
 */
export async function loadDataBackups(
  client: ApiClient,
  organizationId: string,
  resourceId: string,
): Promise<Section<DataBackupSummary>> {
  const response = await client.call<readonly DataBackupSummary[]>("data.backups.list", {
    organizationId,
    resourceId,
  });
  return sectionFrom("Backups", response);
}

/** Load an organization's API keys. The secret is never in this list. */
export async function loadApiKeys(
  client: ApiClient,
  organizationId: string,
): Promise<Section<ApiKeySummaryRow>> {
  const response = await client.call<readonly ApiKeySummaryRow[]>("apiKeys.list", {
    organizationId,
  });
  return sectionFrom("API keys", response);
}

/** Load provider health. A not-configured engine renders as degraded, not ready. */
export async function loadProviderHealth(
  client: ApiClient,
  organizationId: string,
): Promise<Section<ProviderHealthRow>> {
  const response = await client.call<readonly ProviderHealthRow[]>("providers.health", {
    organizationId,
  });
  return sectionFrom("Engine status", response);
}

/**
 * Load the organization's security policy.
 *
 * A missing policy is not an error: it renders as an empty list under the same
 * rule as every other section, so "no policy yet" and "the load failed" stay
 * distinguishable. The policy state is the server's, never inferred here.
 */
export async function loadSecurityPolicy(
  client: ApiClient,
  organizationId: string,
): Promise<Section<SecurityPolicySummary>> {
  const response = await client.call<SecurityPolicyReadSummary>("security.policy.get", {
    organizationId,
  });
  if (response.notConfigured) {
    return {
      title: "Security policy",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Security policy", response.error?.message ?? "Request failed.");
  }
  const policy = response.data?.policy;
  return ready("Security policy", policy ? [policy] : []);
}

/**
 * Load a policy's transition history.
 *
 * The server records every move between states — a save to `draft`, a
 * distribution that became `active`, one the edge rejected. Dropping it would
 * leave an operator unable to see *why* a policy is not active, so it is
 * surfaced rather than discarded.
 */
export async function loadSecurityPolicyEvents(
  client: ApiClient,
  organizationId: string,
): Promise<Section<SecurityPolicyEventSummary>> {
  const response = await client.call<SecurityPolicyReadSummary>("security.policy.get", {
    organizationId,
  });
  if (response.notConfigured) {
    return {
      title: "Policy history",
      state: { kind: "degraded", reason: response.error?.message ?? "Not configured." },
    };
  }
  if (!response.ok) {
    return errored("Policy history", response.error?.message ?? "Request failed.");
  }
  return ready("Policy history", response.data?.events ?? []);
}

/** Load the audit log of one organization. */
export async function loadAudit(
  client: ApiClient,
  organizationId: string,
): Promise<Section<AuditSummary>> {
  const response = await client.call<readonly AuditSummary[]>("audit.list", { organizationId });
  return sectionFrom("Recent activity", response);
}

export interface DashboardModel {
  readonly title: string;
  readonly sections: readonly Section<unknown>[];
}

/**
 * Build the model for a route.
 *
 * Sections that are not relevant to the route are simply absent, so a view
 * cannot accidentally render data it was not meant to load.
 */
export async function loadRoute(client: ApiClient, route: Route): Promise<DashboardModel> {
  switch (route.name) {
    case "organizations":
      return { title: "Organizations", sections: [await loadOrganizations(client)] };

    case "organization":
      return {
        title: "Organization",
        sections: [loading("Projects"), await loadAudit(client, route.organizationId)],
      };

    case "projects":
      return { title: "Projects", sections: [await loadProjects(client, route.organizationId)] };

    case "project":
    case "deployments":
      return { title: "Deployments", sections: [await loadDeployments(client, route.projectId)] };

    case "domains":
      return { title: "Domains", sections: [await loadDomains(client, route.organizationId)] };

    case "database":
      return {
        title: databaseSectionTitle(route.section ?? "overview"),
        sections: [await loadDataResources(client, route.organizationId)],
      };

    case "security":
      // Security shows policy and incident state through the same
      // not-configured-or-ready lens as every other engine-backed view.
      return {
        title: "Security",
        sections: [await loadProviderHealth(client, route.organizationId)],
      };

    case "audit":
      return { title: "Activity", sections: [await loadAudit(client, route.organizationId)] };

    case "settings":
      return {
        title: "Settings",
        sections: [await loadProviderHealth(client, route.organizationId)],
      };

    case "apiKeys":
      return { title: "API keys", sections: [await loadApiKeys(client, route.organizationId)] };

    case "not_found":
      return {
        title: "Not found",
        sections: [errored("Page", `No route matches ${route.path}.`)],
      };
  }
}
