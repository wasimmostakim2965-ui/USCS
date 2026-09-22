import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getDomainResellerAdapter } from "./adapters/domainReseller";

describe("domains foundation", () => {
  it("keeps marketplace results unknown before a reseller is configured", async () => {
    const response = await getDomainResellerAdapter().search("https://www.ExampleBrand.test/path");
    expect(response.status).toBe("not_configured");
    expect(response.query).toBe("examplebrand.test");
    expect(response.results[0]?.availability).toBe("unknown");
    expect(response.results[0]?.price).toBeNull();
  });

  it("keeps domain and DNS tables tenant-scoped with RLS and audited mutations", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922180000_domains_dns.sql", import.meta.url), "utf8");
    const router = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(migration).toContain("alter table public.domains enable row level security");
    expect(migration).toContain("alter table public.dns_records enable row level security");
    expect(migration.match(/private\.is_organization_member\(organization_id\)/g)?.length).toBeGreaterThanOrEqual(6);
    expect(router).toContain('action: "domain.create"');
    expect(router).toContain('action: "dns_record.create"');
    expect(router).toContain('action: "dns_record.delete"');
  });
});
