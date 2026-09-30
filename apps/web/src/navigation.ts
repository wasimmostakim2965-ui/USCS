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
 * The workspace and project menus mirror Vercel's dashboard, which the owner
 * supplied as a written list and as 23 screenshots. The screenshots are the
 * authority: this order, these names and the flat (ungrouped) shape are read
 * off them, not remembered.
 *
 * There are three levels, and a route belongs to exactly one of them:
 *   * workspace — Projects, Deployments, Logs, Analytics, Speed Insights,
 *                 Observability, Firewall, CDN, Environment Variables, Domains,
 *                 Connect, Integrations, Storage, Database, Flags, Agent, AI
 *                 Gateway, Sandboxes, Workflows, Images, Usage, Support,
 *                 Settings.
 *   * project   — the same sections again, scoped to one project and ending in
 *                 Domains, Environment Variables, Database and Settings, opened
 *                 from Projects.
 *   * database  — Overview, Table Editor, SQL Editor, Auth, Storage, API, Roles,
 *                 Logs, Settings. The third drill-in level, reached from the
 *                 project menu's Database entry.
 *
 * Domains and Database are project-scoped on purpose: a domain is attached to
 * an application, and so is a database. Security is organization-wide today —
 * `security_policies` is keyed by `organization_id`, with no `project_id` — and
 * the page says so rather than implying a per-project policy the schema cannot
 * hold. Security is deliberately absent from both menus: the reference does not
 * list it, so it stays reachable by URL rather than sitting in the sidebar.
 */
import type { IconName } from "@cloud-wai/ui";
import {
  DATABASE_SECTIONS,
  parseRoute,
  subSectionTitle,
  subSections,
  toPath,
  WORKSPACE_SECTIONS,
  PROJECT_SECTIONS,
  type DatabaseSection,
  type ProjectSection,
  type Route,
  type WorkspaceSection,
} from "./routes.js";

export interface NavItem {
  readonly id: string;
  readonly label: string;
  /** A named glyph from the Cloud Wai icon set. */
  readonly icon: IconName;
  readonly description: string;
  readonly route: Route;
  /**
   * Whether the reference draws this entry with a sub-menu of its own.
   *
   * A section with sub-items (Firewall, CDN, Storage, …) opens a *replaced*
   * sidebar when you enter it — the same drill-in the project and database
   * levels use — and its row carries a chevron. The sub-items themselves come
   * from `sectionSubNav`, so the chevron, the sub-menu and the page's own tabs
   * read one list and cannot disagree. Absent for the plain sections.
   */
  readonly hasSubMenu?: boolean | undefined;
}

export interface NavContext {
  readonly organizationId: string;
  readonly organizationName?: string | undefined;
  readonly projectId?: string | undefined;
  readonly projectName?: string | undefined;
}

/**
 * A run of sidebar entries.
 *
 * Vercel's sidebar is one flat list with no headings, so the workspace and
 * project runs carry an empty label and the shell renders the items with no
 * divider. The type is kept because the Database level still wants the notion
 * of a labelled run, and because dropping it would mean rewriting every call
 * site for no gain.
 */
export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

/**
 * Which drill-in level a menu is showing: Workspace -> Project -> Database, and
 * a section's own sub-menu (Workspace -> Section). The shell reads this to
 * label the back control and to pick the group spec, so the two can never
 * disagree about where the user is.
 */
export type NavLevel = "workspace" | "project" | "database" | "sub";

/** Which ids belong to which run, in the order they appear. */
interface GroupSpec {
  readonly label: string;
  readonly ids: readonly string[];
}

// The workspace and project menus are flat: one unlabelled run, exactly like the
// reference. Only the Database level still groups its items.
const FLAT: readonly GroupSpec[] = [{ label: "", ids: [] }];

const DATABASE_GROUPS: readonly GroupSpec[] = [
  { label: "Database", ids: ["database-overview", "database-tables", "database-sql"] },
  { label: "Platform", ids: ["database-auth", "database-storage", "database-api"] },
  { label: "Administration", ids: ["database-roles", "database-logs", "database-settings"] },
];

/** A glyph and a one-line description for each workspace section. */
const WORKSPACE_SECTION_ICONS: Readonly<Record<WorkspaceSection, IconName>> = {
  logs: "logs",
  analytics: "chart",
  "speed-insights": "pulse",
  firewall: "shield",
  cdn: "pulse",
  env: "env",
  domains: "domains",
  connect: "connect",
  integrations: "integrations",
  storage: "storage",
  database: "database",
  flags: "flag",
  agent: "agent",
  "ai-gateway": "gateway",
  sandboxes: "sandbox",
  workflows: "workflow",
  images: "images",
  usage: "chart",
  support: "support",
};

const WORKSPACE_SECTION_LABELS: Readonly<Record<WorkspaceSection, string>> = {
  logs: "Logs",
  analytics: "Analytics",
  "speed-insights": "Speed Insights",
  firewall: "Firewall",
  cdn: "CDN",
  env: "Environment Variables",
  domains: "Domains",
  connect: "Connect",
  integrations: "Integrations",
  storage: "Storage",
  database: "Database",
  flags: "Flags",
  agent: "Agent",
  "ai-gateway": "AI Gateway",
  sandboxes: "Sandboxes",
  workflows: "Workflows",
  images: "Images",
  usage: "Usage",
  support: "Support",
};

const WORKSPACE_SECTION_DESCRIPTIONS: Readonly<Record<WorkspaceSection, string>> = {
  logs: "Runtime logs across this organization, newest first.",
  analytics: "Traffic and visitor counts across this organization.",
  "speed-insights": "Real-user performance: the Core Web Vitals across this organization.",
  firewall: "Traffic, rules and the audit log for this organization's edge.",
  cdn: "Cached delivery: requests, cache hit rate and transfer.",
  env: "Variables available to this organization's projects.",
  domains: "Every hostname this organization serves.",
  connect: "Connectors and the tokens they issue.",
  integrations: "Third-party services wired into this organization.",
  storage: "Object storage buckets for this organization.",
  database: "Databases, tables, storage and auth.",
  flags: "Feature flags and who they are rolled out to.",
  agent: "The assistant's tasks and what it has done.",
  "ai-gateway": "Models, API keys and spend for the managed AI gateway.",
  sandboxes: "Isolated machines for agent and one-off workloads.",
  workflows: "Durable multi-step runs and their steps.",
  images: "Image transformations served from this organization.",
  usage: "Metered usage against each resource's cap.",
  support: "Open a case and read what has been filed.",
};

/** A glyph and a one-line description for each project section. */
const PROJECT_SECTION_ICONS: Readonly<Record<ProjectSection, IconName>> = {
  "speed-insights": "pulse",
  observability: "pulse",
  firewall: "shield",
  cdn: "pulse",
  connect: "connect",
  integrations: "integrations",
  storage: "storage",
  flags: "flag",
  agent: "agent",
  "ai-gateway": "gateway",
  sandboxes: "sandbox",
  workflows: "workflow",
  images: "images",
  usage: "chart",
  support: "support",
};

const PROJECT_SECTION_LABELS: Readonly<Record<ProjectSection, string>> = {
  "speed-insights": "Speed Insights",
  observability: "Observability",
  firewall: "Firewall",
  cdn: "CDN",
  connect: "Connect",
  integrations: "Integrations",
  storage: "Storage",
  flags: "Flags",
  agent: "Agent",
  "ai-gateway": "AI Gateway",
  sandboxes: "Sandboxes",
  workflows: "Workflows",
  images: "Images",
  usage: "Usage",
  support: "Support",
};

const PROJECT_SECTION_DESCRIPTIONS: Readonly<Record<ProjectSection, string>> = {
  "speed-insights": "Real-user performance: the Core Web Vitals for this project.",
  observability: "Requests, traces and errors for this project.",
  firewall: "Traffic, rules and the audit log for this project's edge.",
  cdn: "Cached delivery for this project.",
  connect: "Connectors this project uses.",
  integrations: "Third-party services wired into this project.",
  storage: "Object storage buckets for this project.",
  flags: "Feature flags for this project.",
  agent: "The assistant's tasks for this project.",
  "ai-gateway": "Model routing and spend for this project.",
  sandboxes: "Isolated machines for this project's agent workloads.",
  workflows: "Durable runs for this project.",
  images: "Image transformations served for this project.",
  usage: "Metered usage for this project.",
  support: "Support cases for this project.",
};

/**
 * The workspace menu, in the reference's order.
 *
 * A project is opened from Projects. Everything below it is a workspace-wide
 * view of the same idea the project menu shows per project.
 */
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
      id: "org-deployments",
      label: "Deployments",
      icon: "deployments",
      description: "Every deployment across this organization's projects, newest first.",
      route: { name: "orgDeployments", organizationId },
    },
    {
      id: "logs",
      label: "Logs",
      icon: "logs",
      description: WORKSPACE_SECTION_DESCRIPTIONS.logs,
      route: { name: "workspaceSection", organizationId, section: "logs" },
    },
    {
      id: "analytics",
      label: "Analytics",
      icon: "chart",
      description: WORKSPACE_SECTION_DESCRIPTIONS.analytics,
      route: { name: "workspaceSection", organizationId, section: "analytics" },
    },
    {
      id: "speed-insights",
      label: "Speed Insights",
      icon: "pulse",
      description: WORKSPACE_SECTION_DESCRIPTIONS["speed-insights"],
      route: { name: "workspaceSection", organizationId, section: "speed-insights" },
    },
    {
      id: "observability",
      label: "Observability",
      icon: "pulse",
      description: "Job throughput, failures and latency across this organization.",
      route: { name: "observability", organizationId },
    },
    ...WORKSPACE_SECTIONS.filter(
      // The three above have a bespoke entry so Observability can sit between
      // them in the reference's order; everything else is generated.
      (section) => section !== "logs" && section !== "analytics" && section !== "speed-insights",
    ).map((section) => {
      const hasSubMenu = subSections(section).length > 0;
      return {
        id: section,
        label: WORKSPACE_SECTION_LABELS[section],
        icon: WORKSPACE_SECTION_ICONS[section],
        description: WORKSPACE_SECTION_DESCRIPTIONS[section],
        route: { name: "workspaceSection", organizationId, section } satisfies Route,
        ...(hasSubMenu ? { hasSubMenu: true } : {}),
      };
    }),
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
 * project's own sections are the only thing in view. The order is the
 * reference's project sidebar, which is the workspace menu with the project's
 * own pages folded in.
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
      id: "logs",
      label: "Logs",
      icon: "logs",
      description: "Runtime logs for this project's deployments.",
      route: { name: "projectLogs", organizationId, projectId },
    },
    {
      id: "analytics",
      label: "Analytics",
      icon: "chart",
      description: "Deployment and job activity over time.",
      route: { name: "projectAnalytics", organizationId, projectId },
    },
    ...PROJECT_SECTIONS.map((section) => {
      const hasSubMenu = subSections(section).length > 0;
      return {
        id: section,
        label: PROJECT_SECTION_LABELS[section],
        icon: PROJECT_SECTION_ICONS[section],
        description: PROJECT_SECTION_DESCRIPTIONS[section],
        route: { name: "projectSection", organizationId, projectId, section } satisfies Route,
        ...(hasSubMenu ? { hasSubMenu: true } : {}),
      };
    }),
    // Domains, Environment Variables and Database have pages of their own
    // rather than the generic section page, so they carry their own routes and
    // sit here, after the shared sections and before Settings.
    {
      id: "domains",
      label: "Domains",
      icon: "domains",
      description: "Hostnames for this project.",
      route: { name: "domains", organizationId, projectId },
    },
    {
      id: "env",
      label: "Environment Variables",
      icon: "env",
      description: "Variables injected into this project's builds and runtime.",
      route: { name: "env", organizationId, projectId },
    },
    {
      id: "database",
      label: "Database",
      icon: "database",
      description: "Databases, tables, storage and auth for this project.",
      route: { name: "database", organizationId, projectId },
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
 * back control returns to the project menu.
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
 * The sub-menu of a section the reference drills into, as sidebar rows.
 *
 * Empty when the section is a single page. Like `databaseNav`, this *replaces*
 * the sidebar rather than appending to it, and each row is the same
 * `workspaceSection`/`projectSection` route the page's own tabs link to, so the
 * sub-menu and the tabs read one list (`SECTION_SUBS`) and cannot disagree.
 */
function sectionSubNav(
  section: string,
  description: string,
  makeRoute: (sub: string) => Route,
): readonly NavItem[] {
  return subSections(section).map((sub) => ({
    id: `${section}-${sub}`,
    label: subSectionTitle(sub),
    icon: SUB_SECTION_ICONS[sub] ?? "overview",
    description,
    route: makeRoute(sub),
  }));
}

export function workspaceSubNav(
  organizationId: string,
  section: WorkspaceSection,
): readonly NavItem[] {
  return sectionSubNav(section, WORKSPACE_SECTION_DESCRIPTIONS[section], (sub) => ({
    name: "workspaceSection",
    organizationId,
    section,
    sub,
  }));
}

export function projectSubNav(
  organizationId: string,
  projectId: string,
  section: ProjectSection,
): readonly NavItem[] {
  return sectionSubNav(section, PROJECT_SECTION_DESCRIPTIONS[section], (sub) => ({
    name: "projectSection",
    organizationId,
    projectId,
    section,
    sub,
  }));
}

/**
 * The glyph each sub-item carries.
 *
 * The reference gives every sub-item its own glyph — Overview, Traffic, Rules
 * and Audit Log each draw a different icon — so a sub-menu is not four copies of
 * the section's glyph. Keyed by the sub-item id, which is shared across
 * sections, so `overview` reads the same under Firewall and under CDN.
 */
const SUB_SECTION_ICONS: Readonly<Record<string, IconName>> = {
  overview: "overview",
  traffic: "activity",
  rules: "shield",
  "audit-log": "logs",
  caches: "pulse",
  entities: "table",
  "sdk-keys": "key",
  buckets: "storage",
  "api-keys": "key",
  models: "sql",
  playground: "workflow",
};

/**
 * Group a menu's items into the runs the sidebar renders.
 *
 * A flat run keeps the order the menu function returned. Any id a labelled spec
 * does not claim is appended in a final unlabelled run rather than dropped, so a
 * section added to a menu and forgotten here still appears — the menu can never
 * lose an entry to a bookkeeping mistake.
 */
export function groupNavItems(
  items: readonly NavItem[],
  specs: readonly GroupSpec[],
): readonly NavGroup[] {
  const claimed = new Set(specs.flatMap((spec) => spec.ids));
  const groups: NavGroup[] = [];
  for (const spec of specs) {
    // A spec with no ids is the flat run: every item, in menu order.
    const members =
      spec.ids.length === 0
        ? items
        : spec.ids
            .map((id) => items.find((item) => item.id === id))
            .filter((item): item is NavItem => item !== undefined);
    if (members.length > 0) groups.push({ label: spec.label, items: members });
  }
  const claimedNow = new Set(groups.flatMap((group) => group.items.map((item) => item.id)));
  const rest = items.filter((item) => !claimedNow.has(item.id));
  if (rest.length > 0) groups.push({ label: "", items: rest });
  return groups;
}

const GROUPS_BY_LEVEL: Readonly<Record<NavLevel, readonly GroupSpec[]>> = {
  workspace: FLAT,
  project: FLAT,
  database: DATABASE_GROUPS,
  sub: FLAT,
};

/** The runs for a menu level. The shell renders one block per run. */
export function navGroups(level: NavLevel, items: readonly NavItem[]): readonly NavGroup[] {
  return groupNavItems(items, GROUPS_BY_LEVEL[level]);
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
  /**
   * The sub-item the route is showing, when it is a sub-item URL; null
   * otherwise. The sidebar highlights the matching sub-item row.
   */
  readonly activeSubId: string | null;
  readonly projectId: string | null;
  /**
   * Which drill-in level is showing. The shell uses this to label the group and
   * to decide whether to offer a back control, so the two levels cannot
   * disagree about where the user is.
   */
  readonly level: NavLevel;
} {
  const workspace = (activeId: string | null, activeSubId: string | null = null) => ({
    items: workspaceNav(context),
    activeId,
    activeSubId,
    projectId: null,
    level: "workspace" as const,
  });

  const project = (
    projectId: string,
    activeId: string | null,
    activeSubId: string | null = null,
  ) => ({
    items: projectNav({ ...context, projectId }),
    activeId,
    activeSubId,
    projectId,
    level: "project" as const,
  });

  switch (route.name) {
    case "projects":
      return workspace("projects");
    case "orgDeployments":
      return workspace("org-deployments");
    case "observability":
      return workspace("observability");
    case "settings":
      return workspace("settings");
    case "workspaceSection":
      return workspace(route.section, route.sub ?? null);
    case "security": {
      // Security is one route with two homes. Opened from a project it renders
      // the same organization-wide policy with the project menu around it;
      // opened without a project it renders with the workspace menu. Neither
      // menu lists it, so nothing is highlighted either way — the page is
      // reachable by URL, which is where the reference leaves it.
      if (!route.projectId) return workspace(null);
      return project(route.projectId, null);
    }
    case "organizations":
    case "organization":
    case "auth_callback":
    case "not_found":
    case "landing":
      // The landing page is not part of the dashboard, so no sidebar item owns
      // it and the shell renders with no sidebar at all.
      return workspace(null);
    case "apiKeys":
    case "audit":
    case "members":
    case "billing":
    case "docs":
      // These pages still exist and still render, but the reference's menu does
      // not list them, so no sidebar entry owns the route and nothing is
      // highlighted. Reachable by URL, absent from the menu — not deleted.
      return workspace(null);
    case "projectSection":
      if (!route.projectId) return workspace(null);
      return project(route.projectId, route.section, route.sub ?? null);
    case "project":
    case "deployments":
    case "domains":
    case "git":
    case "env":
    case "projectLogs":
    case "projectAnalytics":
    case "setup":
    case "projectSettings": {
      // A section URL is only valid with a project. Without one the route is a
      // workspace-level dead link, and the honest answer is the workspace menu.
      if (!route.projectId) return workspace(null);
      const activeId =
        route.name === "project"
          ? "overview"
          : route.name === "projectSettings"
            ? "settings"
            : route.name === "projectLogs"
              ? "logs"
              : route.name === "projectAnalytics"
                ? "analytics"
                : route.name === "setup"
                  ? "overview"
                  : route.name;
      return project(route.projectId, activeId);
    }
    case "database": {
      if (!route.projectId) return workspace(null);
      const section = route.section ?? "overview";
      return {
        items: databaseNav({ ...context, projectId: route.projectId }),
        activeId: `database-${section}`,
        activeSubId: null,
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
    case "landing":
      return "Cloud Wai";
    case "auth_callback":
      return "Signing in";
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
    case "setup":
      return "Setup";
    case "git":
      return "Git";
    case "env":
      return "Environment Variables";
    case "projectLogs":
      return "Logs";
    case "projectAnalytics":
      return "Analytics";
    case "projectSettings":
      return "Settings";
    case "apiKeys":
      return "API keys";
    case "audit":
      return "Activity";
    case "observability":
      return "Observability";
    case "orgDeployments":
      return "Deployments";
    case "members":
      return "Members";
    case "billing":
      return "Usage";
    case "docs":
      return "Docs";
    case "settings":
      return "Settings";
    case "workspaceSection":
      return withSub(WORKSPACE_SECTION_LABELS[route.section], route.sub);
    case "projectSection":
      return withSub(PROJECT_SECTION_LABELS[route.section], route.sub);
    case "not_found":
      return "Not found";
  }
}

function withSub(sectionLabel: string, sub: string | undefined): string {
  // A section's sub-item is its own page, so the title names both: a deep link
  // to `.../firewall/rules` titles itself "Firewall · Rules".
  return sub ? `${sectionLabel} · ${subSectionTitle(sub)}` : sectionLabel;
}

/** Where "back" goes from a project section. */
export function backTargetFor(route: Route): Route | null {
  switch (route.name) {
    case "project":
      return { name: "projects", organizationId: route.organizationId };
    case "projectSection":
      // A project sub-section page belongs to the project, so Back steps out of
      // the section to the project menu, not to the section's landing page.
      // The sub-menu is a level of its own; Back is the one control that leaves
      // it, which is what the reference's Back does.
      return {
        name: "project",
        organizationId: route.organizationId,
        projectId: route.projectId,
      };
    case "workspaceSection":
      // The workspace-level equivalent. Back returns to the workspace's front
      // page (Projects), the level the section list lives at.
      return { name: "projects", organizationId: route.organizationId };
    case "deployments":
    case "domains":
    case "git":
    case "env":
    case "projectLogs":
    case "projectAnalytics":
    case "setup":
    case "projectSettings":
      return {
        name: "project",
        organizationId: route.organizationId,
        projectId: route.projectId,
      };
    case "security":
      // The project shortcut steps back to the project it was opened from; the
      // workspace entry has no project, so Back is the workspace front page.
      return route.projectId
        ? { name: "project", organizationId: route.organizationId, projectId: route.projectId }
        : { name: "projects", organizationId: route.organizationId };
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
