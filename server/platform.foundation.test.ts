import { describe, expect, it } from "vitest";
import { NotConfiguredDomainReseller } from "./adapters/domainReseller";
import { getPlatformAdapters } from "./adapters/platform";
import { diffSecurityPolicy, resolveSecurityPolicy } from "./securityPolicy";

describe("platform foundation", () => {
  it("returns honest domain adapter state before reseller credentials exist", async () => {
    const result = await new NotConfiguredDomainReseller().search("Acme.com");
    expect(result.status).toBe("not_configured");
    expect(result.results[0]?.domain).toBe("acme.com");
    expect(result.results[0]?.price).toBeNull();
  });

  it("does not report self-operated engines as successful before provisioning", async () => {
    const result = await getPlatformAdapters().database.provision({ organizationId: "org", projectId: "project", name: "primary", engine: "postgres" });
    expect(result.status).toBe("not_configured");
    expect(result.data).toBeNull();
  });

  it("maps ultimate security to concrete edge enforcement and produces a diff", () => {
    const normal = resolveSecurityPolicy("normal");
    const ultimate = resolveSecurityPolicy("ultimate");
    expect(ultimate.tls.minimumVersion).toBe("TLSv1.3");
    expect(ultimate.rateLimit.requestsPerMinute).toBeLessThan(normal.rateLimit.requestsPerMinute);
    expect(diffSecurityPolicy(normal, ultimate)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tls.minimumVersion", after: "TLSv1.3" }),
      expect.objectContaining({ path: "rateLimit.requestsPerMinute", after: 60 }),
    ]));
  });
});
