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
 * There are three levels, and a route belongs to exactly one of them:
 *   * workspace — Projects, API keys, Activity, Settings.
 *   * project   — Overview, Deployments, Domains, Database, Security, Settings.
 *   * database  — Overview, Table Editor, SQL Editor, Auth, Storage, API, Roles,
 *                 Logs, Settings. This is the third drill-in level, reached from
 *                 the project menu's Database entry.
 *
 * Domains and Database are project-scoped on purpose: a domain is attached to
 * an application, and so is a database. Security is reached under a project for
 * navigation consistency, but the policy it edits is organization-wide today —
 * `security_policies` is keyed by `organization_id`, with no `project_id` — and
 * the page says so rather than implying a per-project policy that the schema
 * cannot hold.
 */
import type { IconName } from "@cloud-wai/ui";
import {
  DATABASE_SECTIONS,
  parseRoute,
  toPath,
  type DatabaseSection,
  type Route,
} from "./routes.js";

export interface NavItem {
  readonly id: string;
  readonly label: string;
  /** A named glyph from the Cloud Wai icon set. */
  readonly icon: IconName;
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
      icon: "projects",
      description: "Applications you deploy and operate.",
      route: { name: "projects", organizationId },
    },
    {
      id: "api-keys",
      label: "API keys",
      icon: "key",
      description: "Programmatic access to this organization.",
      route: { name: "apiKeys", organizationId },
    },
    {
      id: "audit",
      label: "Activity",
      icon: "activity",
      description: "An append-only record of what changed.",
      route: { name: "audit", organizationId },
    },
    {
      id: "billing",
      label: "Billing",
      icon: "billing",
      description: "Usage recorded for this organization. Empty until a metric is recorded.",
      route: { name: "billing", organizationId },
    },
    {
      id: "settings",
      label: "Settings",
      icon: "settings",
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
      icon: "overview",
      description: "Deployment state and recent activity for this project.",
      route: { name: "project", organizationId, projectId },
    },
    {
      id: "deployments",
      label: "Deployments",
      icon: "deployments",
      description: "Build and release history.",
      route: { name: "deployments", organizationId, projectId },
    },
    {
      id: "domains",
      label: "Domains",
      icon: "domains",
      description: "Hostnames for this project.",
      route: { name: "domains", organizationId, projectId },
    },
    {
      id: "database",
      label: "Database",
      icon: "database",
      description: "Databases, tables, storage and auth for this project.",
      route: { name: "database", organizationId, projectId },
    },
    {
      id: "security",
      label: "Security",
      icon: "shield",
      description: "Protection level applied to this project.",
      route: { name: "security", organizationId, projectId },
    },
    {
      id: "settings",
      label: "Settings",
      icon: "settings",
      description: "Project profile and engine status for this project.",
      route: { name: "projectSettings", organizationId, projectId },
    },
  ];
}

/**
 * The Database sub-menu.
 *
 * This is the third drill-in level: Workspace -> Project -> Database. Like the
 * project switch, it *replaces* the sidebar rather than appending to it, and a
 * back control returns to the project menu. That is the GitLab shape, not a
 * Cloudflare-style dropdown, per the owner's instruction.
 *
 * The section list is the vocabulary of a hosted Postgres platform, because
 * that is what this section is. Every entry is a real route, so each sub-page
 * is deep-linkable, refreshable and bookmarkable on its own.
 *
 * Every section's glyph and description live in total records over
 * `DatabaseSection`, so adding a section to `DATABASE_SECTIONS` without giving
 * it a glyph and a description is a type error rather than a blank sidebar item.
 */
const DATABASE_SECTION_ICONS: Readonly<Record<DatabaseSection, IconName>> = {
  overview: "overview",
  tables: "table",
  sql: "sql",
  auth: "auth",
  storage: "storage",
  api: "api",
  roles: "roles",
  logs: "logs",
  settings: "settings",
};

const DATABASE_SECTION_DESCRIPTIONS: Readonly<Record<DatabaseSection, string>> = {
  overview: "Project status and connection details.",
  tables: "Browse and edit rows through the REST surface.",
  sql: "Run SQL against this project's database.",
  auth: "Users, sessions and auth providers.",
  storage: "Object storage buckets for this project.",
  api: "The REST endpoints this project exposes.",
  roles: "Roles, extensions and backups.",
  logs: "Recent database and API logs.",
  settings: "Database settings for this project.",
};

export function databaseNav(
  context: NavContext & { readonly projectId: string },
): readonly NavItem[] {
  const { organizationId, projectId } = context;
  return DATABASE_SECTIONS.map((section) => ({
    id: `database-${section}`,
    label: databaseSectionTitle(section),
    icon: DATABASE_SECTION_ICONS[section],
    description: DATABASE_SECTION_DESCRIPTIONS[section],
    route: { name: "database", organizationId, projectId, section } satisfies Route,
  }));
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
  /**
   * Which drill-in level is showing. The shell uses this to label the group and
   * to decide whether to offer a back control, so the two levels cannot
   * disagree about where the user is.
   */
  readonly level: "workspace" | "project" | "database";
} {
  const workspace = (activeId: string | null) => ({
    items: workspaceNav(context),
    activeId,
    projectId: null,
    level: "workspace" as const,
  });

  switch (route.name) {
    case "projects":
      return workspace("projects");
    case "apiKeys":
      return workspace("api-keys");
    case "audit":
      return workspace("audit");
    case "billing":
      return workspace("billing");
    case "settings":
      return workspace("settings");
    case "organizations":
    case "organization":
    case "not_found":
      return workspace(null);
    case "project":
    case "deployments":
    case "domains":
    case "security":
    case "projectSettings": {
      // A section URL is only valid with a project. Without one the route is a
      // workspace-level dead link, and the honest answer is the workspace menu.
      if (!route.projectId) return workspace(null);
      return {
        items: projectNav({ ...context, projectId: route.projectId }),
        activeId:
          route.name === "project"
            ? "overview"
            : route.name === "projectSettings"
              ? "settings"
              : route.name,
        projectId: route.projectId,
        level: "project",
      };
    }
    case "database": {
      if (!route.projectId) return workspace(null);
      const section = route.section ?? "overview";
      return {
        items: databaseNav({ ...context, projectId: route.projectId }),
        activeId: `database-${section}`,
        projectId: route.projectId,
        level: "database",
      };
    }
  }
}

/**
 * A human title for a database sub-section.
 *
 * Kept separate from `databaseNav` so the title and the sidebar label cannot
 * drift: both read this one function.
 */
export function databaseSectionTitle(section: DatabaseSection): string {
  switch (section) {
    case "overview":
      return "Overview";
    case "tables":
      return "Table Editor";
    case "sql":
      return "SQL Editor";
    case "auth":
      return "Authentication";
    case "storage":
      return "Storage";
    case "api":
      return "API";
    case "roles":
      return "Roles & Extensions";
    case "logs":
      return "Logs";
    case "settings":
      return "Settings";
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
    case "database":
      // The section name is the page title, so a deep link to
      // `.../database/tables` titles itself "Table Editor" rather than "Database".
      return databaseSectionTitle(route.section ?? "overview");
    case "security":
      return "Security";
    case "projectSettings":
      return "Settings";
    case "apiKeys":
      return "API keys";
    case "audit":
      return "Activity";
    case "billing":
      return "Billing";
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
    case "security":
    case "projectSettings":
      return {
        name: "project",
        organizationId: route.organizationId,
        projectId: route.projectId,
      };
    case "database":
      // A database sub-page belongs to the Database section, so back returns to
      // the Database Overview — the level the sidebar is currently showing —
      // not all the way to the project menu. Two presses get to the project.
      return route.section && route.section !== "overview"
        ? {
            name: "database",
            organizationId: route.organizationId,
            projectId: route.projectId,
          }
        : {
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
