/**
 * Routes. URLs are the source of truth for navigation.
 */
export type Route =
  | { readonly name: "landing" }
  | { readonly name: "auth_callback" }
  | { readonly name: "organizations" }
  | { readonly name: "organization"; readonly organizationId: string }
  | { readonly name: "projects"; readonly organizationId: string }
  | { readonly name: "project"; readonly organizationId: string; readonly projectId: string }
  | { readonly name: "deployments"; readonly organizationId: string; readonly projectId: string }
  | { readonly name: "domains"; readonly organizationId: string; readonly projectId: string }
  | {
      readonly name: "database";
      readonly organizationId: string;
      readonly projectId: string;
      readonly section?: DatabaseSection | undefined;
    }
  | { readonly name: "security"; readonly organizationId: string; readonly projectId: string }
  | { readonly name: "git"; readonly organizationId: string; readonly projectId: string }
  | { readonly name: "env"; readonly organizationId: string; readonly projectId: string }
  | { readonly name: "projectLogs"; readonly organizationId: string; readonly projectId: string }
  | {
      readonly name: "projectAnalytics";
      readonly organizationId: string;
      readonly projectId: string;
    }
  | {
      readonly name: "projectSettings";
      readonly organizationId: string;
      readonly projectId: string;
    }
  | { readonly name: "audit"; readonly organizationId: string }
  | { readonly name: "observability"; readonly organizationId: string }
  | { readonly name: "billing"; readonly organizationId: string }
  | { readonly name: "orgDeployments"; readonly organizationId: string }
  | { readonly name: "members"; readonly organizationId: string }
  | { readonly name: "settings"; readonly organizationId: string }
  | { readonly name: "apiKeys"; readonly organizationId: string }
  | { readonly name: "docs"; readonly organizationId: string }
  | { readonly name: "not_found"; readonly path: string };

export const DATABASE_SECTIONS = [
  "overview",
  "tables",
  "sql",
  "auth",
  "storage",
  "api",
  "roles",
  "logs",
  "settings",
] as const;
export type DatabaseSection = (typeof DATABASE_SECTIONS)[number];
function isDatabaseSection(value: string): value is DatabaseSection {
  return (DATABASE_SECTIONS as readonly string[]).includes(value);
}

export function parseRoute(path: string): Route {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/") return { name: "landing" };
  if (clean === "/auth/callback") return { name: "auth_callback" };
  const segments = clean.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments[0] === "orgs" && segments.length === 1) return { name: "organizations" };
  if (segments[0] === "orgs" && segments.length === 2)
    return { name: "organization", organizationId: segments[1]! };
  if (segments[0] === "orgs" && segments[2] === "projects" && segments.length === 3)
    return { name: "projects", organizationId: segments[1]! };
  if (segments[0] === "orgs" && segments[2] === "projects" && segments.length === 4)
    return { name: "project", organizationId: segments[1]!, projectId: segments[3]! };
  if (
    segments[0] === "orgs" &&
    segments[2] === "projects" &&
    segments[4] === "deployments" &&
    segments.length === 5
  )
    return { name: "deployments", organizationId: segments[1]!, projectId: segments[3]! };
  if (segments[0] === "orgs" && segments[2] === "projects" && segments.length === 5) {
    const section = segments[4];
    if (section === "domains" || section === "security" || section === "git" || section === "env")
      return { name: section, organizationId: segments[1]!, projectId: segments[3]! };
    if (section === "logs")
      return { name: "projectLogs", organizationId: segments[1]!, projectId: segments[3]! };
    if (section === "analytics")
      return { name: "projectAnalytics", organizationId: segments[1]!, projectId: segments[3]! };
    if (section === "settings")
      return { name: "projectSettings", organizationId: segments[1]!, projectId: segments[3]! };
    if (section === "database" || section === "data")
      return { name: "database", organizationId: segments[1]!, projectId: segments[3]! };
  }
  if (
    segments[0] === "orgs" &&
    segments[2] === "projects" &&
    segments[4] === "database" &&
    segments.length === 6
  ) {
    const section = segments[5]!;
    if (!isDatabaseSection(section)) return { name: "not_found", path: clean };
    return { name: "database", organizationId: segments[1]!, projectId: segments[3]!, section };
  }
  if (
    segments[0] === "orgs" &&
    segments[2] === "settings" &&
    segments[3] === "api-keys" &&
    segments.length === 4
  )
    return { name: "apiKeys", organizationId: segments[1]! };
  if (segments[0] === "orgs" && segments[2] === "audit" && segments.length === 3)
    return { name: "audit", organizationId: segments[1]! };
  if (segments[0] === "orgs" && segments[2] === "observability" && segments.length === 3)
    return { name: "observability", organizationId: segments[1]! };
  if (segments[0] === "orgs" && segments[2] === "deployments" && segments.length === 3)
    return { name: "orgDeployments", organizationId: segments[1]! };
  if (segments[0] === "orgs" && segments[2] === "members" && segments.length === 3)
    return { name: "members", organizationId: segments[1]! };
  if (segments[0] === "orgs" && segments[2] === "billing" && segments.length === 3)
    return { name: "billing", organizationId: segments[1]! };
  if (segments[0] === "orgs" && segments[2] === "docs" && segments.length === 3)
    return { name: "docs", organizationId: segments[1]! };
  if (segments[0] === "orgs" && segments[2] === "settings" && segments.length === 3)
    return { name: "settings", organizationId: segments[1]! };
  return { name: "not_found", path: clean };
}

export function toPath(route: Route): string {
  switch (route.name) {
    case "landing":
      return "/";
    case "auth_callback":
      return "/auth/callback";
    case "organizations":
      return "/orgs";
    case "organization":
      return `/orgs/${encodeURIComponent(route.organizationId)}`;
    case "projects":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects`;
    case "project":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}`;
    case "deployments":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/deployments`;
    case "domains":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/domains`;
    case "database":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/database${route.section ? `/${encodeURIComponent(route.section)}` : ""}`;
    case "security":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/security`;
    case "git":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/git`;
    case "env":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/env`;
    case "projectLogs":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/logs`;
    case "projectAnalytics":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/analytics`;
    case "projectSettings":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/settings`;
    case "apiKeys":
      return `/orgs/${encodeURIComponent(route.organizationId)}/settings/api-keys`;
    case "audit":
      return `/orgs/${encodeURIComponent(route.organizationId)}/audit`;
    case "observability":
      return `/orgs/${encodeURIComponent(route.organizationId)}/observability`;
    case "orgDeployments":
      return `/orgs/${encodeURIComponent(route.organizationId)}/deployments`;
    case "members":
      return `/orgs/${encodeURIComponent(route.organizationId)}/members`;
    case "billing":
      return `/orgs/${encodeURIComponent(route.organizationId)}/billing`;
    case "docs":
      return `/orgs/${encodeURIComponent(route.organizationId)}/docs`;
    case "settings":
      return `/orgs/${encodeURIComponent(route.organizationId)}/settings`;
    case "not_found":
      return route.path;
  }
}
