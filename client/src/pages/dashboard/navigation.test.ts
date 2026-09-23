import { describe, expect, it } from "vitest";
import {
  dashboardChildFromSlug,
  dashboardHref,
  dashboardItemFromSlug,
  dashboardNav,
  dashboardRoutes,
  projectRoutes,
  workspaceGroups,
} from "./navigation";

describe("dashboard navigation contract", () => {
  it("registers a deep-link route for every section and child", () => {
    const expectedRouteCount = dashboardNav.reduce((count, item) => count + 1 + item.children.length, 0) + projectRoutes.length;
    expect(dashboardRoutes).toHaveLength(expectedRouteCount);
    for (const item of dashboardNav) {
      expect(dashboardRoutes).toContain(`/dashboard/${item.path}`);
      for (const child of item.children) {
        expect(dashboardRoutes).toContain(dashboardHref(item, child));
      }
    }
  });

  it("never registers the same route twice", () => {
    expect(new Set(dashboardRoutes).size).toBe(dashboardRoutes.length);
  });

  it("resolves active child routes from the URL slug", () => {
    for (const item of dashboardNav) {
      expect(item.children.length).toBeGreaterThan(0);
      const firstChild = item.children[0];
      expect(dashboardItemFromSlug(item.path)).toBe(item);
      expect(dashboardChildFromSlug(item, firstChild.path)).toBe(firstChild);
      expect(dashboardChildFromSlug(item, "missing-route")).toBeUndefined();
    }
  });

  it("uses implementation-safe slugs for nested sections", () => {
    const domains = dashboardNav.find(item => item.path === "domains")!;
    expect(dashboardHref(domains, domains.children.find(child => child.label === "SSL/TLS")!)).toBe("/dashboard/domains/ssl-tls");
    const data = dashboardNav.find(item => item.path === "data")!;
    expect(dashboardHref(data, data.children[0])).toBe("/dashboard/data/databases");
    const security = dashboardNav.find(item => item.path === "security")!;
    expect(dashboardHref(security, security.children[0])).toBe("/dashboard/security/posture");
    const settings = dashboardNav.find(item => item.path === "settings")!;
    expect(dashboardHref(settings, settings.children[0])).toBe("/dashboard/settings/workspace");
  });

  it("keeps every grouped sidebar entry pointing at a real section", () => {
    const labels = new Set(dashboardNav.map(item => item.label));
    for (const group of workspaceGroups) {
      for (const label of group.items) expect(labels.has(label)).toBe(true);
    }
    expect(workspaceGroups.flatMap(group => group.items).sort()).toEqual([...labels].sort());
  });
});
