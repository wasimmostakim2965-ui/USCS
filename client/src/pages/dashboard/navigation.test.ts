import { describe, expect, it } from "vitest";
import {
  dashboardHref,
  dashboardItemFromSlug,
  dashboardNav,
  dashboardRoutes,
  dashboardChildFromSlug,
} from "./navigation";

describe("dashboard navigation", () => {
  it("registers a deep-link route for every section and child", () => {
    const expectedRouteCount = dashboardNav.reduce((count, item) => count + 1 + item.children.length, 0);
    expect(dashboardRoutes).toHaveLength(expectedRouteCount);
    for (const item of dashboardNav) {
      expect(dashboardRoutes).toContain(`/dashboard/${item.path}`);
      for (const child of item.children) {
        expect(dashboardRoutes).toContain(dashboardHref(item, child));
      }
    }
  });

  it("resolves active child routes from the URL slug", () => {
    for (const item of dashboardNav) {
      const child = item.children[0];
      expect(child).toBeDefined();
      expect(dashboardItemFromSlug(item.path)).toBe(item);
      expect(dashboardChildFromSlug(item, child.path)).toBe(child);
      expect(dashboardChildFromSlug(item, "missing-route")).toBeUndefined();
    }
  });

  it("uses implementation-safe slugs for nested sections", () => {
    expect(dashboardHref(dashboardNav.find(item => item.path === "domains")!, dashboardNav.find(item => item.path === "domains")!.children.find(child => child.label === "SSL/TLS"))).toBe("/dashboard/domains/ssl-tls");
    expect(dashboardHref(dashboardNav.find(item => item.path === "database")!, dashboardNav.find(item => item.path === "database")!.children[0])).toBe("/dashboard/database/instances");
    expect(dashboardHref(dashboardNav.find(item => item.path === "security")!, dashboardNav.find(item => item.path === "security")!.children[0])).toBe("/dashboard/security/overview");
    expect(dashboardHref(dashboardNav.find(item => item.path === "settings")!, dashboardNav.find(item => item.path === "settings")!.children[0])).toBe("/dashboard/settings/workspace");
    expect(new Set(dashboardRoutes).size).toBe(dashboardRoutes.length);
  });
});
