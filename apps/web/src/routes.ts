/**
 * Routes.
 *
 * URLs are the source of truth for navigation, so a view is always derivable
 * from a link and a refresh lands where the user was. The organization id is
 * present in the path for readability, but it is never what authorizes a
 * request: the server resolves scope from the session regardless of what the
 * URL says.
 */
export type Route =
  | { readonly name: "landing" }
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
      /** Which Supabase-style sub-section is open. Absent means Overview. */
      readonly section?: DatabaseSection | undefined;
    }
  | { readonly name: "security"; readonly organizationId: string; readonly projectId: string }
  | { readonly name: "git"; readonly organizationId: string; readonly projectId: string }
  | { readonly name: "env"; readonly organizationId: string; readonly projectId: string }
  | {
      readonly name: "projectSettings";
      readonly organizationId: string;
      readonly projectId: string;
    }
  | { readonly name: "audit"; readonly organizationId: string }
  | { readonly name: "observability"; readonly organizationId: string }
  | { readonly name: "billing"; readonly organizationId: string }
  | { readonly name: "settings"; readonly organizationId: string }
  | { readonly name: "apiKeys"; readonly organizationId: string }
  | { readonly name: "not_found"; readonly path: string };

/**
 * The Database section's sub-pages.
 *
 * These mirror the shape Supabase's own project view exposes, because that is
 * the mental model the owner asked for. They are our routes and our UI; the
 * engine is reached only through the adapter.
 */
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
  // The root is the public landing page, not the dashboard. The dashboard lives
  // at `/orgs`, so an unauthenticated visitor never lands on a shell that needs
  // a session to say anything.
  if (clean === "/") return { name: "landing" };

  const segments = clean.split("/").filter(Boolean).map(decodeURIComponent);

  if (segments[0] === "orgs" && segments.length === 1) {
    return { name: "organizations" };
  }
  if (segments[0] === "orgs" && segments.length === 2) {
    return { name: "organization", organizationId: segments[1]! };
  }
  if (segments[0] === "orgs" && segments[2] === "projects" && segments.length === 3) {
    return { name: "projects", organizationId: segments[1]! };
  }
  if (segments[0] === "orgs" && segments[2] === "projects" && segments.length === 4) {
    return { name: "project", organizationId: segments[1]!, projectId: segments[3]! };
  }
  if (
    segments[0] === "orgs" &&
    segments[2] === "projects" &&
    segments[4] === "deployments" &&
    segments.length === 5
  ) {
    return { name: "deployments", organizationId: segments[1]!, projectId: segments[3]! };
  }
  if (segments[0] === "orgs" && segments[2] === "projects" && segments.length === 5) {
    const section = segments[4];
    if (section === "domains" || section === "security" || section === "git" || section === "env") {
      return {
        name: section,
        organizationId: segments[1]!,
        projectId: segments[3]!,
      };
    }
    if (section === "settings") {
      return {
        name: "projectSettings",
        organizationId: segments[1]!,
        projectId: segments[3]!,
      };
    }
    if (section === "database" || section === "data") {
      // `data` is the old path. It still resolves, to the section that replaced
      // it, so an existing bookmark does not 404.
      return {
        name: "database",
        organizationId: segments[1]!,
        projectId: segments[3]!,
      };
    }
  }
  if (
    segments[0] === "orgs" &&
    segments[2] === "projects" &&
    segments[4] === "database" &&
    segments.length === 6
  ) {
    const sub = segments[5]!;
    if (!isDatabaseSection(sub)) return { name: "not_found", path: clean };
    return {
      name: "database",
      organizationId: segments[1]!,
      projectId: segments[3]!,
      section: sub,
    };
  }
  if (
    segments[0] === "orgs" &&
    segments[2] === "settings" &&
    segments[3] === "api-keys" &&
    segments.length === 4
  ) {
    return { name: "apiKeys", organizationId: segments[1]! };
  }
  if (segments[0] === "orgs" && segments[2] === "audit" && segments.length === 3) {
    return { name: "audit", organizationId: segments[1]! };
  }
  if (segments[0] === "orgs" && segments[2] === "observability" && segments.length === 3) {
    return { name: "observability", organizationId: segments[1]! };
  }
  if (segments[0] === "orgs" && segments[2] === "billing" && segments.length === 3) {
    return { name: "billing", organizationId: segments[1]! };
  }
  if (segments[0] === "orgs" && segments[2] === "settings" && segments.length === 3) {
    return { name: "settings", organizationId: segments[1]! };
  }

  return { name: "not_found", path: clean };
}

export function toPath(route: Route): string {
  switch (route.name) {
    case "landing":
      return "/";
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
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/database${
        route.section ? `/${encodeURIComponent(route.section)}` : ""
      }`;
    case "security":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/security`;
    case "git":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/git`;
    case "env":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/env`;
    case "projectSettings":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/settings`;
    case "apiKeys":
      return `/orgs/${encodeURIComponent(route.organizationId)}/settings/api-keys`;
    case "audit":
      return `/orgs/${encodeURIComponent(route.organizationId)}/audit`;
    case "observability":
      return `/orgs/${encodeURIComponent(route.organizationId)}/observability`;
    case "billing":
      return `/orgs/${encodeURIComponent(route.organizationId)}/billing`;
    case "settings":
      return `/orgs/${encodeURIComponent(route.organizationId)}/settings`;
    case "not_found":
      return route.path;
  }
}
