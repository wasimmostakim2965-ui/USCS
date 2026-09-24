/**
 * The domain verifier's own contract.
 *
 * This adapter is the only thing that decides `verified`, so its honesty rules
 * are tested directly rather than only through the procedure that calls it:
 *
 *   * a matching TXT challenge verifies, and only an exact match does;
 *   * a record that is absent yields `verified: false`, which is a real answer;
 *   * a lookup that *broke* (timeout, SERVFAIL) yields `degraded`, never
 *     `verified: false` — otherwise a flaky resolver would silently report a
 *     domain as confirmed-unverified and pass a check it never performed;
 *   * a CNAME is only accepted when an edge host is configured to match.
 */
import { describe, expect, it } from "vitest";
import {
  createDnsDomainVerifier,
  domainVerifierNotConfigured,
  type DnsResolver,
} from "@cloud-wai/adapters";
import type { AdapterContext } from "@cloud-wai/contracts";

const ctx: AdapterContext = {
  organizationId: "org-a" as AdapterContext["organizationId"],
  idempotencyKey: "k",
  timeoutMs: 1000,
};

function missing(code: string) {
  const error = new Error(`no record (${code})`) as Error & { code: string };
  error.code = code;
  return error;
}

/** A resolver built from plain record tables, so the test states the DNS state. */
function resolver(records: {
  txt?: Record<string, string[][]>;
  cname?: Record<string, string[]>;
  txtError?: Record<string, Error>;
  cnameError?: Record<string, Error>;
}): DnsResolver {
  return {
    async resolveTxt(hostname) {
      const failure = records.txtError?.[hostname];
      if (failure) throw failure;
      const rows = records.txt?.[hostname];
      if (!rows) throw missing("ENOTFOUND");
      return rows;
    },
    async resolveCname(hostname) {
      const failure = records.cnameError?.[hostname];
      if (failure) throw failure;
      const targets = records.cname?.[hostname];
      if (!targets) throw missing("ENOTFOUND");
      return targets;
    },
  };
}

const TOKEN = "cw-domain-verify=abc123";

describe("the DNS domain verifier", () => {
  it("verifies when the challenge TXT record carries the expected token", async () => {
    const verifier = createDnsDomainVerifier({
      resolver: resolver({
        txt: { "_cloud-wai-challenge.app.example.com": [[TOKEN]] },
      }),
    });

    const result = await verifier.resolveDomainVerification(ctx, {
      hostname: "app.example.com",
      expectedToken: TOKEN,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verified).toBe(true);
      expect(result.value.provider).toBe("dns");
    }
  });

  it("joins multi-part TXT strings before comparing", async () => {
    // A long TXT value arrives split into 255-byte chunks; the adapter must
    // compare the whole record, not its first fragment.
    const verifier = createDnsDomainVerifier({
      resolver: resolver({
        txt: { "_cloud-wai-challenge.app.example.com": [["cw-domain-verify=", "abc123"]] },
      }),
    });

    const result = await verifier.resolveDomainVerification(ctx, {
      hostname: "app.example.com",
      expectedToken: TOKEN,
    });

    expect(result.ok && result.value.verified).toBe(true);
  });

  it("does not verify on a token that merely differs", async () => {
    const verifier = createDnsDomainVerifier({
      resolver: resolver({
        txt: { "_cloud-wai-challenge.app.example.com": [["cw-domain-verify=someone-else"]] },
      }),
    });

    const result = await verifier.resolveDomainVerification(ctx, {
      hostname: "app.example.com",
      expectedToken: TOKEN,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verified).toBe(false);
  });

  it("does not verify a token that is a prefix of the record", async () => {
    // Guards against a substring check: `includes` would pass this.
    const verifier = createDnsDomainVerifier({
      resolver: resolver({
        txt: { "_cloud-wai-challenge.app.example.com": [[`${TOKEN}-extra`]] },
      }),
    });

    const result = await verifier.resolveDomainVerification(ctx, {
      hostname: "app.example.com",
      expectedToken: TOKEN,
    });

    expect(result.ok && result.value.verified).toBe(false);
  });

  it("reports a genuinely absent record as unverified, not as a failure", async () => {
    const verifier = createDnsDomainVerifier({ resolver: resolver({}) });

    const result = await verifier.resolveDomainVerification(ctx, {
      hostname: "app.example.com",
      expectedToken: TOKEN,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verified).toBe(false);
  });

  it("reports a broken lookup as degraded, never as unverified", async () => {
    const verifier = createDnsDomainVerifier({
      resolver: resolver({
        txtError: { "_cloud-wai-challenge.app.example.com": missing("ESERVFAIL") },
        cnameError: { "app.example.com": missing("ETIMEOUT") },
      }),
    });

    const result = await verifier.resolveDomainVerification(ctx, {
      hostname: "app.example.com",
      expectedToken: TOKEN,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("degraded");
  });

  it("accepts a CNAME to the edge only when an edge host is configured", async () => {
    const records = { cname: { "app.example.com": ["edge.cloud-wai.dev."] } };

    const withoutEdge = createDnsDomainVerifier({ resolver: resolver(records) });
    const unverified = await withoutEdge.resolveDomainVerification(ctx, {
      hostname: "app.example.com",
      expectedToken: TOKEN,
    });
    expect(unverified.ok && unverified.value.verified).toBe(false);

    const withEdge = createDnsDomainVerifier({
      resolver: resolver(records),
      edgeHostname: "edge.cloud-wai.dev",
    });
    const verified = await withEdge.resolveDomainVerification(ctx, {
      hostname: "app.example.com",
      expectedToken: TOKEN,
    });
    expect(verified.ok && verified.value.verified).toBe(true);
  });

  it("rejects a malformed hostname without resolving anything", async () => {
    const verifier = createDnsDomainVerifier({ resolver: resolver({}) });

    const result = await verifier.resolveDomainVerification(ctx, {
      hostname: "not a hostname",
      expectedToken: TOKEN,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("failed");
  });

  it("an unconfigured verifier reports not_configured and never verifies", async () => {
    const verifier = domainVerifierNotConfigured("dns", "Set the resolver.");

    const result = await verifier.resolveDomainVerification(ctx, {
      hostname: "app.example.com",
      expectedToken: TOKEN,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });
});
