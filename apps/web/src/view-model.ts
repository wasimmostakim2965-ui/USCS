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
}

export interface DataResourceSummary {
  readonly id: string;
  readonly kind: "postgres" | "object_storage";
  readonly name: string;
  readonly state: "provisioning" | "ready" | "degraded" | "failed" | "destroying";
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

    case "data":
      return { title: "Data", sections: [await loadDataResources(client, route.organizationId)] };

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
