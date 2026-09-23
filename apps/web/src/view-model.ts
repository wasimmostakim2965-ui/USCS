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

    case "audit":
      return { title: "Activity", sections: [await loadAudit(client, route.organizationId)] };

    case "settings":
      return {
        title: "Settings",
        sections: [loading("Engine status")],
      };

    case "not_found":
      return {
        title: "Not found",
        sections: [errored("Page", `No route matches ${route.path}.`)],
      };
  }
}
