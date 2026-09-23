/**
 * Engine wiring: the decision of which engines are real happens in one place,
 * and an incompletely configured engine is never pointed at a fake.
 */
import { describe, expect, it } from "vitest";
import {
  buildEngines,
  engineConfigFromEnv,
  engineReport,
  fakeHosting,
  hostingNotConfigured,
} from "@cloud-wai/adapters";
import type { AdapterContext } from "@cloud-wai/contracts";

const ORG_A = "org-a" as AdapterContext["organizationId"];
const ORG_B = "org-b" as AdapterContext["organizationId"];

const ctx = (org: AdapterContext["organizationId"]): AdapterContext => ({
  organizationId: org,
  idempotencyKey: "k",
  timeoutMs: 100,
});

describe("engine configuration", () => {
  it("has no engines configured by default", () => {
    const engines = buildEngines({});
    const report = engineReport(engines);
    expect(report.every((r) => !r.configured)).toBe(true);
  });

  it("does not wire a fake when configuration is missing", async () => {
    const engines = buildEngines({ coolifyUrl: "https://coolify.test" }); // no token
    const result = await engines.hosting.createApplication(ctx(ORG_A), { name: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });

  it("reads per-organization tokens from the environment", () => {
    const config = engineConfigFromEnv({
      COOLIFY_URL: "https://coolify.test",
      "COOLIFY_TOKEN__org-a": "tok-a",
      "COOLIFY_TOKEN__org-b": "tok-b",
      COOLIFY_TOKEN__ignored: "   ",
    });
    expect(config.coolifyUrl).toBe("https://coolify.test");
    expect(config.coolifyTokens).toEqual({ "org-a": "tok-a", "org-b": "tok-b" });
  });

  it("builds a real Coolify adapter when a url and tokens are present", () => {
    const engines = buildEngines({
      coolifyUrl: "https://coolify.test",
      coolifyTokens: { "org-a": "tok-a" },
    });
    expect(engineReport(engines).find((r) => r.engine === "coolify")?.configured).toBe(true);
  });

  it("is not configured for an organization with no token, even when others have one", async () => {
    const engines = buildEngines({
      coolifyUrl: "https://coolify.test",
      coolifyTokens: { "org-a": "tok-a" },
    });
    const result = await engines.hosting.getDeployment(ctx(ORG_B), {
      organizationId: ORG_B,
      provider: "coolify",
      resourceType: "application",
      resourceId: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });

  it("wires fakes only when explicitly requested", () => {
    const engines = buildEngines({ useFakes: true });
    expect(engines.hosting.__notConfigured).toBeUndefined();
    // Storage and the edge have no fake, so they stay honestly unconfigured.
    expect(engines.storage.__notConfigured).toBe(true);
    expect(engineReport(engines).find((r) => r.engine === "coolify")?.configured).toBe(true);
  });

  it("brands the not-configured adapters so the report needs no probe", () => {
    expect(hostingNotConfigured("coolify").__notConfigured).toBe(true);
    expect(fakeHosting().__notConfigured).toBeUndefined();
  });
});
