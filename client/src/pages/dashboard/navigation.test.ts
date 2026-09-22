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
});
