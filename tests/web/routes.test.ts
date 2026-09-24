/**
 * Routing: a route must round-trip through a URL, and an unknown path must be a
 * not-found rather than a silent fallback to the dashboard.
 */
import { describe, expect, it } from "vitest";
import { DATABASE_SECTIONS, parseRoute, toPath, type Route } from "@cloud-wai/web";

describe("route parsing", () => {
  it("maps the root to the organization list", () => {
    expect(parseRoute("/")).toEqual({ name: "organizations" });
    expect(parseRoute("")).toEqual({ name: "organizations" });
  });

  it("parses the organization routes", () => {
    expect(parseRoute("/orgs/org-a")).toEqual({ name: "organization", organizationId: "org-a" });
    expect(parseRoute("/orgs/org-a/projects")).toEqual({
      name: "projects",
      organizationId: "org-a",
    });
    expect(parseRoute("/orgs/org-a/projects/p-1")).toEqual({
      name: "project",
      organizationId: "org-a",
      projectId: "p-1",
    });
    expect(parseRoute("/orgs/org-a/projects/p-1/deployments")).toEqual({
      name: "deployments",
      organizationId: "org-a",
      projectId: "p-1",
    });
    expect(parseRoute("/orgs/org-a/audit")).toEqual({ name: "audit", organizationId: "org-a" });
    expect(parseRoute("/orgs/org-a/settings")).toEqual({
      name: "settings",
      organizationId: "org-a",
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parseRoute("/orgs/org-a/")).toEqual({ name: "organization", organizationId: "org-a" });
  });

  it("decodes percent-encoded segments", () => {
    const route = parseRoute("/orgs/org%20a");
    expect(route).toEqual({ name: "organization", organizationId: "org a" });
  });

  it("reports an unknown path instead of falling back", () => {
    const route = parseRoute("/deployments/everything");
    expect(route.name).toBe("not_found");
  });

  it("parses the project-scoped section routes", () => {
    expect(parseRoute("/orgs/org-a/projects/p-1/domains")).toEqual({
      name: "domains",
      organizationId: "org-a",
      projectId: "p-1",
    });
    expect(parseRoute("/orgs/org-a/projects/p-1/database")).toEqual({
      name: "database",
      organizationId: "org-a",
      projectId: "p-1",
    });
    expect(parseRoute("/orgs/org-a/projects/p-1/security")).toEqual({
      name: "security",
      organizationId: "org-a",
      projectId: "p-1",
    });
    expect(parseRoute("/orgs/org-a/projects/p-1/settings")).toEqual({
      name: "projectSettings",
      organizationId: "org-a",
      projectId: "p-1",
    });
    expect(parseRoute("/orgs/org-a/settings/api-keys")).toEqual({
      name: "apiKeys",
      organizationId: "org-a",
    });
  });

  it("parses each database sub-section as its own deep link", () => {
    expect(parseRoute("/orgs/org-a/projects/p-1/database/tables")).toEqual({
      name: "database",
      organizationId: "org-a",
      projectId: "p-1",
      section: "tables",
    });
    expect(parseRoute("/orgs/org-a/projects/p-1/database/sql").section).toBe("sql");
    expect(parseRoute("/orgs/org-a/projects/p-1/database/auth").section).toBe("auth");
    expect(parseRoute("/orgs/org-a/projects/p-1/database/storage").section).toBe("storage");
    expect(parseRoute("/orgs/org-a/projects/p-1/database/api").section).toBe("api");
    expect(parseRoute("/orgs/org-a/projects/p-1/database/roles").section).toBe("roles");
    expect(parseRoute("/orgs/org-a/projects/p-1/database/logs").section).toBe("logs");
    expect(parseRoute("/orgs/org-a/projects/p-1/database/settings").section).toBe("settings");
    expect(parseRoute("/orgs/org-a/projects/p-1/database/overview").section).toBe("overview");
  });

  it("rejects an unknown database sub-section rather than serving a blank page", () => {
    expect(parseRoute("/orgs/org-a/projects/p-1/database/nonsense").name).toBe("not_found");
  });

  it("still resolves the old /data path, so an existing bookmark does not 404", () => {
    expect(parseRoute("/orgs/org-a/projects/p-1/data")).toEqual({
      name: "database",
      organizationId: "org-a",
      projectId: "p-1",
    });
  });

  it("does not treat an unknown project sub-route as a section", () => {
    expect(parseRoute("/orgs/org-a/projects/p-1/billing").name).toBe("not_found");
  });

  it("does not guess at a malformed organization path", () => {
    expect(parseRoute("/orgs/org-a/unknown").name).toBe("not_found");
    expect(parseRoute("/orgs/org-a/projects/p-1/extra/deep").name).toBe("not_found");
  });

  it("round-trips every route through its URL", () => {
    const routes: Route[] = [
      { name: "organizations" },
      { name: "organization", organizationId: "org-a" },
      { name: "projects", organizationId: "org-a" },
      { name: "project", organizationId: "org-a", projectId: "p-1" },
      { name: "deployments", organizationId: "org-a", projectId: "p-1" },
      { name: "domains", organizationId: "org-a", projectId: "p-1" },
      { name: "database", organizationId: "org-a", projectId: "p-1" },
      ...DATABASE_SECTIONS.map((section): Route => ({
        name: "database",
        organizationId: "org-a",
        projectId: "p-1",
        section,
      })),
      { name: "security", organizationId: "org-a", projectId: "p-1" },
      { name: "projectSettings", organizationId: "org-a", projectId: "p-1" },
      { name: "audit", organizationId: "org-a" },
      { name: "settings", organizationId: "org-a" },
      { name: "apiKeys", organizationId: "org-a" },
    ];
    for (const route of routes) {
      expect(parseRoute(toPath(route))).toEqual(route);
    }
  });
});
