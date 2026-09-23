/**
 * The navigation model.
 *
 * This is the single source the sidebar, the command palette, the breadcrumb
 * and the page titles all read from. Before this file each of those would have
 * had its own list, and a new section would appear in one and not the others.
 *
 * Every entry carries a `parseRoute`-compatible path, so navigation is a link:
 * a refresh, a bookmark or a deep link lands in the same place.
 *
 * There are two levels, and a route belongs to exactly one of them:
 *   * workspace — Projects, API keys, Activity, Settings.
 *   * project   — Overview, Deployments, Domains, Data, Security, Settings.
 *
 * Security, Domains and Data are project-scoped on purpose. A policy is applied
 * to an application, not to a company, and a route that named an organization
 * but no project would render a section with nothing to act on.
 */
import { parseRoute, toPath, type Route } from "./routes.js";

export interface NavItem {
  readonly id: string;
  readonly label: string;
  /** One glyph, chosen to be readable in the mono stack. */
  readonly glyph: string;
  readonly description: string;
  readonly route: Route;
}

export interface NavContext {
  readonly organizationId: string;
  readonly organizationName?: string | undefined;
  readonly projectId?: string | undefined;
  readonly projectName?: string | undefined;
}

/** Workspace-level sections. A project is opened from Projects. */
export function workspaceNav(context: NavContext): readonly NavItem[] {
  const organizationId = context.organizationId;
  return [
    {
      id: "projects",
      label: "Projects",
      glyph: "▦",
      description: "Applications you deploy and operate.",
      route: { name: "projects", organizationId },
    },
    {
      id: "api-keys",
      label: "API keys",
      glyph: "⌘",
      description: "Programmatic access to this organization.",
      route: { name: "apiKeys", organizationId },
    },
    {
      id: "audit",
      label: "Activity",
      glyph: "≡",
      description: "An append-only record of what changed.",
      route: { name: "audit", organizationId },
    },
    {
      id: "settings",
      label: "Settings",
      glyph: "⚙",
      description: "Organization profile and engine status.",
      route: { name: "settings", organizationId },
    },
  ];
}

/**
 * The menu shown once a project is open.
 *
 * This is the drill-in switch: the sidebar is replaced, not appended to, so the
 * project's own sections are the only thing in view.
 */
export function projectNav(
  context: NavContext & { readonly projectId: string },
): readonly NavItem[] {
  const { organizationId, projectId } = context;
  return [
    {
      id: "overview",
      label: "Overview",
      glyph: "◇",
      description: "Deployment state and recent activity for this project.",
      route: { name: "project", organizationId, projectId },
    },
    {
      id: "deployments",
      label: "Deployments",
      glyph: "▲",
      description: "Build and release history.",
      route: { name: "deployments", organizationId, projectId },
    },
    {
      id: "domains",
      label: "Domains",
      glyph: "◎",
      description: "Hostnames for this project.",
      route: { name: "domains", organizationId, projectId },
    },
    {
      id: "data",
      label: "Data",
      glyph: "◫",
      description: "Databases and storage attached to this project.",
      route: { name: "data", organizationId, projectId },
    },
    {
      id: "security",
      label: "Security",
      glyph: "⛨",
      description: "Protection level applied to this project.",
      route: { name: "security", organizationId, projectId },
    },
    {
      id: "settings",
      label: "Settings",
      glyph: "⚙",
      description: "Project settings and engine status.",
      route: { name: "settings", organizationId },
    },
  ];
}

/**
 * The items relevant to a route, and which one is active.
 *
 * A project route yields the project menu; every other route yields the
 * workspace menu. `activeId` is what the sidebar highlights; it is null when no
 * item owns the route, which is how "Organizations" ends up unhighlighted.
 */
export function navForRoute(
  route: Route,
  context: NavContext,
): {
  readonly items: readonly NavItem[];
  readonly activeId: string | null;
  readonly projectId: string | null;
} {
  const workspace = (activeId: string | null) => ({
    items: workspaceNav(context),
    activeId,
    projectId: null,
  });

  switch (route.name) {
    case "projects":
      return workspace("projects");
    case "apiKeys":
      return workspace("api-keys");
    case "audit":
      return workspace("audit");
    case "settings":
      return workspace("settings");
    case "organizations":
    case "organization":
    case "not_found":
      return workspace(null);
    case "project":
    case "deployments":
    case "domains":
    case "data":
    case "security": {
      // A section URL is only valid with a project. Without one the route is a
      // workspace-level dead link, and the honest answer is the workspace menu.
      if (!route.projectId) return workspace(null);
      return {
        items: projectNav({ ...context, projectId: route.projectId }),
        activeId: route.name === "project" ? "overview" : route.name,
        projectId: route.projectId,
      };
    }
  }
}

/** A human title for a route, used for the document title and the breadcrumb. */
export function titleForRoute(route: Route): string {
  switch (route.name) {
    case "organizations":
      return "Organizations";
    case "organization":
      return "Organization";
    case "projects":
      return "Projects";
    case "project":
      return "Overview";
    case "deployments":
      return "Deployments";
    case "domains":
      return "Domains";
    case "data":
      return "Data";
    case "security":
      return "Security";
    case "apiKeys":
      return "API keys";
    case "audit":
      return "Activity";
    case "settings":
      return "Settings";
    case "not_found":
      return "Not found";
  }
}

/** Where "back" goes from a project section. */
export function backTargetFor(route: Route): Route | null {
  switch (route.name) {
    case "project":
      return { name: "projects", organizationId: route.organizationId };
    case "deployments":
    case "domains":
    case "data":
    case "security":
      return {
        name: "project",
        organizationId: route.organizationId,
        projectId: route.projectId,
      };
    default:
      return null;
  }
}

export { parseRoute, toPath };
export type { Route };
