export type DomainAvailability = "available" | "unavailable" | "premium" | "unknown";

export type DomainSearchResult = {
  domain: string;
  availability: DomainAvailability;
  price: { amount: number; currency: string; period: "year" } | null;
  renewalPrice: { amount: number; currency: string; period: "year" } | null;
  premium: boolean;
  supportsPrivacy: boolean | null;
  reason?: string;
};

export type DomainSearchResponse = {
  status: "ready" | "not_configured" | "error";
  provider: string | null;
  query: string;
  results: DomainSearchResult[];
  message: string;
};

export interface DomainResellerAdapter {
  readonly name: string;
  search(query: string): Promise<DomainSearchResponse>;
  register(input: { domain: string; years: number; contactId: string }): Promise<never>;
  transfer(input: { domain: string; authCode: string; contactId: string }): Promise<never>;
}

function normalizeQuery(query: string) {
  const trimmed = query.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return trimmed.replace(/[^a-z0-9.-]/g, "").replace(/\.{2,}/g, ".").replace(/^\.|\.$/g, "");
}

export class NotConfiguredDomainReseller implements DomainResellerAdapter {
  readonly name = "domain-reseller";

  async search(rawQuery: string): Promise<DomainSearchResponse> {
    const query = normalizeQuery(rawQuery);
    return {
      status: "not_configured",
      provider: null,
      query,
      results: query ? [{
        domain: query.includes(".") ? query : `${query}.com`,
        availability: "unknown",
        price: null,
        renewalPrice: null,
        premium: false,
        supportsPrivacy: null,
        reason: "Connect a domain reseller to return live availability and pricing.",
      }] : [],
      message: "Live domain availability is not configured yet. The search contract is ready for a reseller connection.",
    };
  }

  async register(_input: { domain: string; years: number; contactId: string }): Promise<never> {
    throw new Error("DOMAIN_RESELLER_NOT_CONFIGURED");
  }

  async transfer(_input: { domain: string; authCode: string; contactId: string }): Promise<never> {
    throw new Error("DOMAIN_RESELLER_NOT_CONFIGURED");
  }
}

export function getDomainResellerAdapter(): DomainResellerAdapter {
  // Only the domain area may use an external reseller. Until credentials are
  // configured, return an honest adapter state rather than fabricated results.
  return new NotConfiguredDomainReseller();
}
