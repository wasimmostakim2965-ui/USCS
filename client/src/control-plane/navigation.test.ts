import { describe, expect, it } from "vitest";
import { projectNavigation, workspaceNavigation } from "./navigation";

describe("control-plane navigation contract", () => {
  it("keeps workspace navigation in the product order", () => {
    expect(workspaceNavigation.map(item => item.label)).toEqual([
      "Overview", "Projects", "Deployments", "Logs", "Observability",
      "Domains", "Data", "Security", "Connect", "Billing", "Settings",
    ]);
  });

  it("keeps project navigation distinct from workspace navigation", () => {
    expect(projectNavigation[0].label).toBe("Overview");
    expect(projectNavigation.some(item => item.label === "Environment Variables")).toBe(true);
    expect(projectNavigation.some(item => item.label === "Projects")).toBe(false);
    expect(projectNavigation.find(item => item.label === "Deployments")?.children).toHaveLength(3);
  });

  it("uses one parent security item in both contexts", () => {
    expect(workspaceNavigation.filter(item => item.label === "Security")).toHaveLength(1);
    expect(projectNavigation.filter(item => item.label === "Security")).toHaveLength(1);
  });
});
