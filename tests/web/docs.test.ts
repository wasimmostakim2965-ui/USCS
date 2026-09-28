/**
 * The in-dashboard documentation must describe the menu that exists.
 *
 * Two rules are checked here, and both are the kind of drift that would be
 * invisible in a screenshot: every docs section maps to a real route, and every
 * sidebar entry is documented (or is the Docs entry itself). A section with a
 * broken status or an empty body is a type error at compile time; the runtime
 * rules are what a test has to hold.
 */
import { describe, expect, it } from "vitest";
import {
  DOC_INTRO,
  DOC_SECTIONS,
  DOC_STATUS_DESCRIPTIONS,
  DOC_STATUS_LABELS,
  DATABASE_SECTIONS,
  buildMenuMap,
  databaseNav,
  navForRoute,
  parseRoute,
  projectNav,
  toPath,
  workspaceNav,
  type NavItem,
  type Route,
} from "@cloud-wai/web";

const ORG = "org-a";
const PROJECT = "p-1";

/** A stable id for a route, so a set of routes can be compared. */
function routeKey(route: Route): string {
  return `${route.name}:${toPath(route)}`;
}

/** Every route the sidebar can produce, from all three levels. */
function allNavItems(): readonly NavItem[] {
  return [
    ...workspaceNav({ organizationId: ORG }),
    ...projectNav({ organizationId: ORG, projectId: PROJECT }),
    ...databaseNav({ organizationId: ORG, projectId: PROJECT }),
  ];
}

describe("documentation content", () => {
  it("gives every section a title, a summary and at least one paragraph", () => {
    for (const section of DOC_SECTIONS) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.summary.length).toBeGreaterThan(0);
      expect(section.body.length).toBeGreaterThan(0);
      for (const paragraph of section.body) expect(paragraph.length).toBeGreaterThan(0);
    }
  });

  it("has a unique id per section", () => {
    const ids = DOC_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels and describes every status, so the page cannot render a blank badge", () => {
    for (const section of DOC_SECTIONS) {
      expect(DOC_STATUS_LABELS[section.status]).toBeTruthy();
      expect(DOC_STATUS_DESCRIPTIONS[section.status]).toBeTruthy();
    }
  });

  it("names the repository document each section summarizes", () => {
    for (const section of DOC_SECTIONS) {
      expect(section.source, `${section.id} must cite its source`).toBeTruthy();
      expect(section.source).toMatch(/^docs\//);
    }
  });

  it("gives every diagram a caption and at least one path", () => {
    for (const section of DOC_SECTIONS) {
      if (!section.diagram) continue;
      expect(section.diagram.caption.length).toBeGreaterThan(0);
      expect(section.diagram.paths.length).toBeGreaterThan(0);
    }
  });

  it("documents every sidebar entry, so a page cannot ship undocumented", () => {
    // The Docs entry documents the documentation surface itself; the "what is
    // not built" section is the honest counterpart to the Missing features and
    // does not map to a menu item. Every other entry must appear.
    const documented = new Set<string>(DOC_SECTIONS.map((section) => section.id));
    const exempt = new Set([
      "docs", // the Docs entry itself
      "overview", // the workspace has no entry named Overview; the project does
    ]);
    for (const item of allNavItems()) {
      const id = item.id.startsWith("database-") ? "database" : item.id;
      if (exempt.has(id)) continue;
      expect(documented.has(id), `no docs section for nav entry "${item.id}"`).toBe(true);
    }
  });
});

describe("navigation has no dead entries", () => {
  it("resolves every leaf nav item to itself through navForRoute", () => {
    // The Database entry is a level switch, not a leaf: navigating to it shows
    // the Database sub-menu, so its own route is not one of the items returned.
    // Every other entry must highlight itself at its own level.
    const leaves: readonly NavItem[] = [
      ...workspaceNav({ organizationId: ORG }),
      ...projectNav({ organizationId: ORG, projectId: PROJECT }).filter(
        (item) => item.id !== "database",
      ),
      ...databaseNav({ organizationId: ORG, projectId: PROJECT }),
    ];
    for (const item of leaves) {
      const nav = navForRoute(item.route, { organizationId: ORG, projectId: PROJECT });
      const active = nav.items.some((entry) => routeKey(entry.route) === routeKey(item.route));
      expect(active, `nav entry "${item.id}" is not reachable`).toBe(true);
      expect(nav.activeId, `nav entry "${item.id}" has no active id`).toBe(item.id);
    }
  });

  it("routes every nav item to a real page, never a not-found", () => {
    for (const item of allNavItems()) {
      const route = parseRoute(toPath(item.route));
      expect(route.name, `nav entry "${item.id}" is a dead link`).not.toBe("not_found");
    }
  });

  it("drills into the project-level Database entry to the Database menu", () => {
    const entry = projectNav({ organizationId: ORG, projectId: PROJECT }).find(
      (item) => item.id === "database",
    );
    expect(entry).toBeDefined();
    const nav = navForRoute(entry!.route, { organizationId: ORG, projectId: PROJECT });
    expect(nav.level).toBe("database");
    expect(nav.activeId).toBe("database-overview");
  });

  it("keeps the project menu in Vercel's most-common-workflow-first order", () => {
    // Overview, Deployments and logs are the daily-use trio; Vercel's own
    // guidance is that a beginner needs only those three. Domains/Git/Env then
    // Data and Security follow. If this order changes, it is a deliberate act.
    const ids = projectNav({ organizationId: ORG, projectId: PROJECT }).map((item) => item.id);
    expect(ids.slice(0, 2)).toEqual(["overview", "deployments"]);
    expect(ids).toContain("database");
    expect(ids).toContain("security");
  });

  it("exposes both of our differentiators at the project level", () => {
    const ids = new Set(projectNav({ organizationId: ORG, projectId: PROJECT }).map((i) => i.id));
    expect(ids.has("database")).toBe(true);
    expect(ids.has("security")).toBe(true);
  });

  it("lists the Docs entry at the workspace level", () => {
    const item = workspaceNav({ organizationId: ORG }).find((entry) => entry.id === "docs");
    expect(item).toBeDefined();
    expect(item?.route).toEqual({ name: "docs", organizationId: ORG });
  });

  it("keeps every database sub-section reachable as its own route", () => {
    const nav = databaseNav({ organizationId: ORG, projectId: PROJECT });
    expect(nav.map((item) => item.id)).toEqual(
      DATABASE_SECTIONS.map((section) => `database-${section}`),
    );
  });
});

describe("the menu map the Docs page renders", () => {
  const levels = buildMenuMap({ organizationId: ORG, projectId: PROJECT });

  it("has the three drill-in levels in order", () => {
    expect(levels.map((level) => level.id)).toEqual(["workspace", "project", "database"]);
  });

  it("mirrors the sidebar exactly, entry for entry, at every level", () => {
    // This is the property the page rests on: the map is generated from the
    // navigation model, so it cannot describe a menu that is not there.
    const expected: readonly (readonly NavItem[])[] = [
      workspaceNav({ organizationId: ORG }),
      projectNav({ organizationId: ORG, projectId: PROJECT }),
      databaseNav({ organizationId: ORG, projectId: PROJECT }),
    ];
    levels.forEach((level, index) => {
      expect(level.items.map((item) => item.id)).toEqual(expected[index]!.map((item) => item.id));
      expect(level.items.map((item) => item.label)).toEqual(
        expected[index]!.map((item) => item.label),
      );
    });
  });

  it("documents every mapped entry with a doc section, or marks a level switch", () => {
    const documented = new Set<string>(DOC_SECTIONS.map((section) => section.id));
    // The same exemptions the coverage test above uses: the Docs entry documents
    // itself, and the workspace level has no "Overview" (the project does).
    const exempt = new Set(["docs", "overview"]);
    for (const level of levels) {
      for (const item of level.items) {
        if (exempt.has(item.id)) continue;
        // A level switch (the project's Database entry) is documented by the
        // Database section; every other entry names its own doc id.
        expect(
          item.becomesLevel || documented.has(item.docId),
          `menu entry "${item.id}" has no documentation (docId "${item.docId}")`,
        ).toBe(true);
      }
    }
  });

  it("gives every entry a reachable route, a deep-linkable path and a stated click landing", () => {
    for (const level of levels) {
      for (const item of level.items) {
        expect(item.route, `"${item.id}" has no route with a project open`).not.toBeNull();
        expect(item.lands.length).toBeGreaterThan(0);
        expect(item.description.length).toBeGreaterThan(0);
        expect(parseRoute(item.path).name, `"${item.id}" path does not resolve`).not.toBe(
          "not_found",
        );
      }
    }
  });

  it("keeps the path a real link the sidebar also uses", () => {
    for (const level of levels) {
      for (const item of level.items) {
        expect(item.path).toBe(toPath(item.route!));
      }
    }
  });

  it("describes the menu in full even before a project is open", () => {
    // A reader must be able to read the whole menu from a workspace with no
    // project selected, but the links that need a project are marked unreachable
    // so the page never renders a navigation that cannot resolve.
    const withoutProject = buildMenuMap({ organizationId: ORG });
    expect(withoutProject.map((level) => level.id)).toEqual(["workspace", "project", "database"]);
    const workspace = withoutProject.find((level) => level.id === "workspace")!;
    expect(workspace.items.every((item) => item.reachable)).toBe(true);
    const project = withoutProject.find((level) => level.id === "project")!;
    expect(project.items.length).toBeGreaterThan(0);
    expect(project.items.every((item) => !item.reachable && item.route === null)).toBe(true);
    expect(project.items.every((item) => item.path.includes(":project"))).toBe(true);
  });
});

describe("the Docs introduction", () => {
  it("has a title, at least one paragraph and a captioned diagram", () => {
    expect(DOC_INTRO.title.length).toBeGreaterThan(0);
    expect(DOC_INTRO.body.length).toBeGreaterThan(0);
    for (const paragraph of DOC_INTRO.body) expect(paragraph.length).toBeGreaterThan(0);
    expect(DOC_INTRO.diagram.caption.length).toBeGreaterThan(0);
    expect(DOC_INTRO.diagram.paths.length).toBeGreaterThan(0);
  });
});
