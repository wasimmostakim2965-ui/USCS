import { getDatabaseAdapter, getStorageAdapter } from "./data";
import { getHostingAdapter } from "./hosting";
import { getSecurityEdgeAdapter } from "./securityEdge";

export type AdapterStatus = "ready" | "not_configured" | "error";
export type AdapterResult<T> = { status: AdapterStatus; data: T | null; message: string };

export interface DnsAdapter {
  listRecords(input: { domainId: string }): Promise<AdapterResult<Array<{ type: string; name: string; value: string }>>>;
  applyRecords(input: { domainId: string; records: Array<{ type: string; name: string; value: string; ttl?: number }> }): Promise<AdapterResult<{ applied: number }>>;
}

export interface EmailAdapter {
  send(input: { to: string; subject: string; text: string }): Promise<AdapterResult<{ messageId: string }>>;
}

class NotConfiguredBase {
  constructor(public readonly name: string) {}
  protected notConfigured<T>(message: string): AdapterResult<T> {
    return { status: "not_configured", data: null, message };
  }
}

class NotConfiguredDnsAdapter extends NotConfiguredBase implements DnsAdapter {
  async listRecords(_input: { domainId: string }) {
    return this.notConfigured<Array<{ type: string; name: string; value: string }>>("DNS adapter is not configured.");
  }

  async applyRecords(_input: { domainId: string; records: Array<{ type: string; name: string; value: string; ttl?: number }> }) {
    return this.notConfigured<{ applied: number }>("DNS adapter is not configured.");
  }
}

class NotConfiguredEmailAdapter extends NotConfiguredBase implements EmailAdapter {
  async send(_input: { to: string; subject: string; text: string }) {
    return this.notConfigured<{ messageId: string }>("Self-hosted email engine is not configured.");
  }
}

/** Compatibility facade; domain contracts live in hosting.ts, data.ts, and securityEdge.ts. */
export function getPlatformAdapters() {
  return {
    hosting: getHostingAdapter(),
    database: getDatabaseAdapter(),
    storage: getStorageAdapter(),
    dns: new NotConfiguredDnsAdapter("self-hosted-dns"),
    email: new NotConfiguredEmailAdapter("self-hosted-email"),
    securityEdge: getSecurityEdgeAdapter(),
  };
}
