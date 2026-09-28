/**
 * The menu map for the in-dashboard documentation.
 *
 * The Docs page must be able to show every option in the menu bar, what each
 * page is, and where a click lands. That is only trustworthy if it is generated
 * from the *same* model the sidebar itself reads — otherwise the documentation
 * is a hand-written description of a menu that has since changed, which is the
 * exact drift this repository forbids.
 *
 * So this module derives the map from `workspaceNav` / `projectNav` /
 * `databaseNav` (the single source of the sidebar) and `toPath` (the single
 * source of a route's URL). A new sidebar entry appears here automatically; a
 * removed one disappears automatically; neither needs a doc edit.
 *
 * The map is three levels, matching the drill-in model exactly: workspace,
 * project, database. A project entry that *replaces* the sidebar with the
 * Database sub-menu is marked `becomesLevel`, with the sentence that says so, so
 * the "where a click lands" answer is a property of the model rather than a
 * sentence someone has to remember to update.
 *
 * When no project is open the project and database levels are still described —
 * a reader needs to know they exist — but every entry there is marked
 * `reachable: false` and rendered without a link, so the page never offers a
 * navigation that cannot resolve. The path shown instead carries a `:project`
 * placeholder.
 */
import type { IconName } from "@cloud-wai/ui";
import {
  databaseNav,
  projectNav,
  workspaceNav,
  type NavContext,
  type NavItem,
} from "../navigation.js";
import { toPath, type Route } from "../routes.js";

export type MenuLevelId = "workspace" | "project" | "database";

export interface MenuMapEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  /** What the page is for, in one line. */
  readonly description: string;
  /** The route this entry opens; null when it needs a project that is not open. */
  readonly route: Route | null;
  /** The same route as a deep-linkable path, so it can be shown and copied. */
  readonly path: string;
  /**
   * The `DOC_SECTIONS` id that documents this entry. A Database sub-entry is
   * documented by the single "database" section.
   */
  readonly docId: string;
  /** True when following this entry swaps the sidebar to another level. */
  readonly becomesLevel: boolean;
  /** Where a click lands, said in one sentence. */
  readonly lands: string;
  /** False when the entry needs a project to be open first. */
  readonly reachable: boolean;
}

export interface MenuMapLevel {
  readonly id: MenuLevelId;
  readonly label: string;
  /** One line on what this level is for and how it is reached. */
  readonly summary: string;
  readonly items: readonly MenuMapEntry[];
}

/** Shown in a path when the entry needs a project that is not open. */
export const PROJECT_PLACEHOLDER = ":project";

/** The list of Database sub-sections is documented as one page. */
function docIdFor(item: NavItem): string {
  return item.id.startsWith("database-") ? "database" : item.id;
}

/**
 * Where a click lands, derived so the answer cannot drift from the model.
 *
 * Two cases exist and the menu should not have to restate either: a normal
 * entry opens its own page, and the project's Database entry is a level switch
 * that replaces the sidebar with the Database sub-menu.
 */
function landsFor(item: NavItem): string {
  if (item.id === "database") {
    return "Opens the Database section and replaces the sidebar with its sub-menu; Back returns to the project menu.";
  }
  return `Opens ${item.label}, and the sidebar highlights it.`;
}

function toEntry(item: NavItem, reachable: boolean): MenuMapEntry {
  const route = reachable ? item.route : null;
  return {
    id: item.id,
    label: item.label,
    icon: item.icon,
    description: item.description,
    route,
    path: reachable ? toPath(item.route) : placeholderPath(item.route),
    docId: docIdFor(item),
    becomesLevel: item.id === "database",
    lands: landsFor(item),
    reachable,
  };
}

/**
 * The path shown for a level that needs a project that is not open.
 *
 * `toPath` runs every segment through `encodeURIComponent`, which would render
 * the `:project` token as `%3Aproject` — an unreadable placeholder that also
 * contradicts this module's own description. The token is repaired back to its
 * literal form so the reader sees the shape they will get once a project is
 * open.
 */
function placeholderPath(route: Route): string {
  return toPath(route).replace(encodeURIComponent(PROJECT_PLACEHOLDER), PROJECT_PLACEHOLDER);
}

/**
 * Build the whole menu map.
 *
 * All three levels are always returned, so the Docs page can describe the menu
 * in full even before a project exists. Entries at the project and database
 * levels carry `reachable: false` until a project is open, and their path is
 * shown with a `:project` placeholder rather than a link that would 404.
 */
export function buildMenuMap(context: NavContext): readonly MenuMapLevel[] {
  const hasProject = Boolean(context.projectId);
  const projectContext: NavContext = {
    ...context,
    projectId: context.projectId ?? PROJECT_PLACEHOLDER,
  };

  return [
    {
      id: "workspace",
      label: "Workspace",
      summary: "The organization-level menu, and the one a refresh or deep link lands on.",
      items: workspaceNav(context).map((item) => toEntry(item, true)),
    },
    {
      id: "project",
      label: "Project",
      summary:
        "Shown after opening a project. It replaces the workspace menu rather than adding to it.",
      items: projectNav({
        ...projectContext,
        projectId: projectContext.projectId!,
      }).map((item) => toEntry(item, hasProject)),
    },
    {
      id: "database",
      label: "Database",
      summary: "Reached from the project menu's Database entry. Every sub-page is its own URL.",
      items: databaseNav({
        ...projectContext,
        projectId: projectContext.projectId!,
      }).map((item) => toEntry(item, hasProject)),
    },
  ];
}
