import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSecurityEdgeAdapter } from "./adapters/securityEdge";
import { resolveSecurityPolicy } from "./securityPolicy";

describe("security foundation", () => {
  it("renders concrete edge artifacts without claiming remote enforcement", async () => {
    const adapter = getSecurityEdgeAdapter();
    const preview = await adapter.preview({ organizationId: "organization", projectId: "project", desiredConfig: resolveSecurityPolicy("high") });
    expect(preview.status).toBe("ready");
    expect(preview.data?.artifacts.openresty).toContain("ssl_protocols TLSv1.3");
    expect(preview.data?.artifacts.coraza).toContain("OWASP CRS");
    expect(preview.data?.diff.length).toBeGreaterThan(3);
  });

  it("keeps security policy tables operator-scoped and mutations auditable", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922155000_security_policy_foundation.sql", import.meta.url), "utf8");
    const router = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(migration).toContain("alter table public.security_policies enable row level security");
    expect(migration).toContain("role in ('owner', 'admin', 'security')");
    expect(migration).toContain("security_policy_events");
    expect(router).toContain('action: "security_policy.set_level"');
    expect(router).toContain('action: "security_policy.apply"');
    expect(router).toContain('action: "security_policy.update_config"');
    expect(router).toContain("security_edge_events");
    const edgeEventsMigration = readFileSync(new URL("../supabase/migrations/20260922200000_security_edge_events.sql", import.meta.url), "utf8");
    expect(edgeEventsMigration).toContain("alter table public.security_edge_events enable row level security");
    expect(edgeEventsMigration).toContain("event_type in ('waf', 'firewall', 'rate_limit', 'bot', 'ddos', 'tls')");
  });
});
