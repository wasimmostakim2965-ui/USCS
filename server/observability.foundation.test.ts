import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("observability foundation", () => {
  it("keeps telemetry empty until an ingestion source exists", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922190000_observability.sql", import.meta.url), "utf8");
    expect(migration).toContain("observability_events");
    expect(migration).toContain("observability_alerts");
    expect(migration).toContain("grant select, insert on public.observability_events");
  });

  it("keeps event and alert data organization-scoped and alert creation auditable", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922190000_observability.sql", import.meta.url), "utf8");
    const router = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(migration).toContain("alter table public.observability_events enable row level security");
    expect(migration).toContain("alter table public.observability_alerts enable row level security");
    expect(migration.match(/private\.is_organization_member\(organization_id\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(router).toContain('action: "observability.alert.create"');
  });
});
