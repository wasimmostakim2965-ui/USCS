import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("developer integration foundation", () => {
  it("keeps provider connections and repositories organization-scoped", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922202000_developer_integrations.sql", import.meta.url), "utf8");
    const router = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(migration).toContain("alter table public.developer_connections enable row level security");
    expect(migration).toContain("alter table public.developer_repositories enable row level security");
    expect(router).toContain('action: "developer.connection.create"');
    expect(router).toContain('action: "developer.repository.add"');
    expect(router).toContain("Webhook adapter is not configured");
  });
});
