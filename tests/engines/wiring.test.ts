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
  it("has only the resolver-based engines configured by default", () => {
    const engines = buildEngines({});
    const report = engineReport(engines);
    // Every credentialed engine is absent. DNS verification is the exception:
    // it needs a resolver, not a secret, so a real deployment always has it.
    expect(report.filter((r) => r.engine !== "dns").every((r) => !r.configured)).toBe(true);
    expect(report.find((r) => r.engine === "dns")?.configured).toBe(true);
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

  it("reads per-organization Coolify infrastructure from the environment", () => {
    const config = engineConfigFromEnv({
      COOLIFY_URL: "https://coolify.test",
      "COOLIFY_TOKEN__org-a": "tok-a",
      "COOLIFY_PROJECT_UUID__org-a": "proj-a",
      "COOLIFY_SERVER_UUID__org-a": "srv-a",
      "COOLIFY_ENVIRONMENT_NAME__org-a": "production",
    });
    expect(config.coolifyInfra).toEqual({
      "org-a": {
        projectUuid: "proj-a",
        serverUuid: "srv-a",
        environmentName: "production",
      },
    });
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

  it("refuses the fakes in a production process, so no fake success is reachable there", () => {
    // The flag alone would let a mistaken production deployment report success
    // for work no engine performed. The build refuses instead.
    expect(() => buildEngines({ useFakes: true, nodeEnv: "production" })).toThrow(
      /CLOUD_WAI_USE_FAKE_ENGINES is set in a production process/,
    );
    // A test/development process is unaffected.
    expect(
      buildEngines({ useFakes: true, nodeEnv: "test" }).hosting.__notConfigured,
    ).toBeUndefined();
  });

  it("uses a supplied security edge adapter, and stays unconfigured without one", () => {
    // Without an adapter the edge is honestly not_configured even when a URL is
    // set: this package cannot build the real edge (it needs resolvers the API
    // owns), and it must not pretend otherwise.
    const withoutAdapter = buildEngines({ securityEdgeConfigured: true });
    expect(engineReport(withoutAdapter).find((r) => r.engine === "envoy")?.configured).toBe(false);

    const supplied = {
      publishRoute: async () => ({ ok: false, status: "not_configured", reason: "x" }) as const,
      removeRoute: async () => ({ ok: false, status: "not_configured", reason: "x" }) as const,
      applyPolicy: async () => ({ ok: false, status: "not_configured", reason: "x" }) as const,
      quarantine: async () => ({ ok: false, status: "not_configured", reason: "x" }) as const,
      inspectHealth: async () => ({ ok: false, status: "not_configured", reason: "x" }) as const,
    };
    const withAdapter = buildEngines({ securityEdgeConfigured: true, securityEdge: supplied });
    expect(engineReport(withAdapter).find((r) => r.engine === "envoy")?.configured).toBe(true);
    expect(withAdapter.securityEdge).toBe(supplied);
  });

  it("reads the storage and edge keys the adapters actually use", () => {
    const config = engineConfigFromEnv({
      STORAGE_ENDPOINT: "https://minio.test",
      "STORAGE_ACCESS_KEY__org-a": "ak-a",
      "STORAGE_SECRET_KEY__org-a": "sk-a",
      SECURITY_EDGE_URL: "https://edge.test",
      EDGE_HOSTNAME: "edge.cloud-wai.test",
    });
    expect(config.storageEndpoint).toBe("https://minio.test");
    expect(config.storageCredentials).toEqual({
      "org-a": { accessKey: "ak-a", secretKey: "sk-a" },
    });
    expect(config.securityEdgeConfigured).toBe(true);
    expect(config.edgeHostname).toBe("edge.cloud-wai.test");
  });
});
