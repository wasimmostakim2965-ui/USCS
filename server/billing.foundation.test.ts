import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getBillingAdapter } from "./adapters/billing";

describe("billing foundation", () => {
  it("never claims checkout success without a configured provider", async () => {
    const result = await getBillingAdapter().createCheckoutSession({ organizationId: "organization", customerEmail: "user@example.com", successUrl: "https://example.com/success", cancelUrl: "https://example.com/cancel" });
    if (!getBillingAdapter().status().configured) expect(result.configured).toBe(false);
  });

  it("keeps billing metadata organization-scoped", () => {
    const migration = readFileSync(new URL("../supabase/migrations/20260922203000_billing_control_plane.sql", import.meta.url), "utf8");
    const router = readFileSync(new URL("./routers.ts", import.meta.url), "utf8");
    expect(migration).toContain("alter table public.billing_usage enable row level security");
    expect(migration).toContain("alter table public.billing_invoices enable row level security");
    expect(migration).toContain("alter table public.billing_payment_methods enable row level security");
    expect(router).toContain("billing_payment_methods");
    expect(router).toContain('action: "billing.checkout.request"');
  });
});
