import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getHostingAdapter } from "./adapters/hosting";

describe("deployments foundation", () => {
  it("keeps hosting operations honest before a compute host exists", async () => {
    const adapter = getHostingAdapter();
    if (adapter.configured) return;
    const created = await adapter.createDeployment({ deploymentId: "deployment", projectId: "project", environment: "preview" });
    const rolledBack = await adapter.rollbackDeployment("deployment");
    expect(created.configured).toBe(false);
    expect(rolledBack.configured).toBe(false);
    expect(created.reason).toContain("hosting runtime is not configured");
  });

  it("keeps deployment control tables organization-scoped with private membership RLS", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922170000_deployment_controls.sql", import.meta.url), "utf8");
    const router = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(migration).toContain("alter table public.deployment_protection enable row level security");
    expect(migration).toContain("alter table public.deployment_rollback_history enable row level security");
    expect(migration.match(/private\.is_organization_member\(organization_id\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(router).toContain('action: "deployment.protection.update"');
    expect(router).toContain('action: "deployment.rollback"');
  });

  it("keeps environment references masked and domain binding adapter-gated", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922191000_deployment_depth.sql", import.meta.url), "utf8");
    const router = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(migration).toContain("masked_value text not null");
    expect(migration).toContain("alter table public.deployment_env_vars enable row level security");
    expect(migration).toContain("alter table public.deployment_domain_bindings enable row level security");
    expect(router).toContain('action: "deployment.env_var.upsert"');
    expect(router).toContain('status: "not_configured"');
  });
});
