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
  | { readonly name: "organizations" }
  | { readonly name: "organization"; readonly organizationId: string }
  | { readonly name: "projects"; readonly organizationId: string }
  | { readonly name: "project"; readonly organizationId: string; readonly projectId: string }
  | { readonly name: "deployments"; readonly organizationId: string; readonly projectId: string }
  | { readonly name: "audit"; readonly organizationId: string }
  | { readonly name: "settings"; readonly organizationId: string }
  | { readonly name: "not_found"; readonly path: string };

export function parseRoute(path: string): Route {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/") return { name: "organizations" };

  const segments = clean.split("/").filter(Boolean).map(decodeURIComponent);

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
  if (segments[0] === "orgs" && segments[2] === "audit" && segments.length === 3) {
    return { name: "audit", organizationId: segments[1]! };
  }
  if (segments[0] === "orgs" && segments[2] === "settings" && segments.length === 3) {
    return { name: "settings", organizationId: segments[1]! };
  }

  return { name: "not_found", path: clean };
}

export function toPath(route: Route): string {
  switch (route.name) {
    case "organizations":
      return "/";
    case "organization":
      return `/orgs/${encodeURIComponent(route.organizationId)}`;
    case "projects":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects`;
    case "project":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}`;
    case "deployments":
      return `/orgs/${encodeURIComponent(route.organizationId)}/projects/${encodeURIComponent(route.projectId)}/deployments`;
    case "audit":
      return `/orgs/${encodeURIComponent(route.organizationId)}/audit`;
    case "settings":
      return `/orgs/${encodeURIComponent(route.organizationId)}/settings`;
    case "not_found":
      return route.path;
  }
}
