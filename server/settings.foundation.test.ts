import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("settings foundation", () => {
  it("keeps invitations and notification preferences organization-scoped", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922204000_workspace_settings.sql", import.meta.url), "utf8");
    const router = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(migration).toContain("create policy organization_members_admin_update");
    expect(migration).toContain("create policy workspace_invitations_admin_insert");
    expect(migration).toContain("create policy workspace_notification_preferences_admin_update");
    expect(router).toContain('action: "workspace.member.invite"');
    expect(router).toContain('action: "workspace.member.role_update"');
    expect(router).toContain('action: "workspace.notifications.update"');
  });
});
