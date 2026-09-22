import { serverConfig } from "../config";

export type BillingPlan = { id: "premium_monthly"; name: string; amount: number; currency: "usd"; interval: "month" };
export type BillingStatus = { configured: boolean; plan: BillingPlan; message: string };

const premiumPlan: BillingPlan = {
  id: "premium_monthly",
  name: "Premium",
  amount: 3900,
  currency: "usd",
  interval: "month",
};

export interface BillingAdapter {
  status(): BillingStatus;
  createCheckoutSession(input: { organizationId: string; customerEmail: string; successUrl: string; cancelUrl: string }): Promise<{ configured: true; url: string } | { configured: false; reason: string }>;
}

export class StripeBillingAdapter implements BillingAdapter {
  status(): BillingStatus {
    const configured = Boolean(serverConfig.STRIPE_SECRET_KEY && serverConfig.STRIPE_PRICE_PREMIUM_MONTHLY);
    return { configured, plan: premiumPlan, message: configured ? "Stripe billing is configured." : "Stripe account, price, and webhook configuration are required before billing is enabled." };
  }

  async createCheckoutSession(_input: { organizationId: string; customerEmail: string; successUrl: string; cancelUrl: string }) {
    if (!serverConfig.STRIPE_SECRET_KEY || !serverConfig.STRIPE_PRICE_PREMIUM_MONTHLY) {
      return { configured: false as const, reason: "STRIPE_SECRET_KEY and STRIPE_PRICE_PREMIUM_MONTHLY are not configured." };
    }
    // The final Stripe call is intentionally isolated here. It is enabled only
    // after the account, price, webhook, and return URLs are configured.
    return { configured: false as const, reason: "Stripe checkout implementation is gated until the production price and webhook contract are verified." };
  }
}

export function getBillingAdapter(): BillingAdapter {
  return new StripeBillingAdapter();
}
