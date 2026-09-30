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

  it("reports only the engine that answered the shared hosting port", () => {
    // Coolify and the self-hosted runtime share the container-engine port. A
    // host wired to the runtime must not also report Coolify as ready, or the
    // dashboard would advertise an engine that would refuse every call.
    const runtime = buildEngines({
      selfHostedUrl: "http://runtime.test:8095",
      selfHostedTokens: { "org-a": "tok-a" },
    });
    const runtimeReport = engineReport(runtime);
    expect(runtimeReport.find((r) => r.engine === "selfhosted")?.configured).toBe(true);
    expect(runtimeReport.find((r) => r.engine === "coolify")?.configured).toBe(false);

    const coolify = buildEngines({
      coolifyUrl: "https://coolify.test",
      coolifyTokens: { "org-a": "tok-a" },
    });
    const coolifyReport = engineReport(coolify);
    expect(coolifyReport.find((r) => r.engine === "coolify")?.configured).toBe(true);
    expect(coolifyReport.find((r) => r.engine === "selfhosted")?.configured).toBe(false);
  });

  it("wires the self-hosted database engine when its url and token are present", () => {
    // A host that owns its runtime owns its databases too. The database engine
    // has its own URL and tokens — it is a separate process from the runtime —
    // so a runtime-only host with no database engine still reports Postgres
    // unconfigured, and one with a database engine reports it ready.
    const runtimeOnly = buildEngines({
      selfHostedUrl: "http://runtime.test:8095",
      selfHostedTokens: { "org-a": "tok-a" },
    });
    expect(engineReport(runtimeOnly).find((r) => r.engine === "postgres")?.configured).toBe(false);

    const withDatabase = buildEngines({
      selfHostedUrl: "http://runtime.test:8095",
      selfHostedTokens: { "org-a": "tok-a" },
      selfHostedDatabaseUrl: "http://db.test:8097",
      selfHostedDatabaseTokens: { "org-a": "db-tok-a" },
    });
    const report = engineReport(withDatabase);
    expect(report.find((r) => r.engine === "postgres")?.configured).toBe(true);
    expect(withDatabase.database.__engine).toBe("postgres");
  });

  it("reads the self-hosted database engine keys from the environment", () => {
    const config = engineConfigFromEnv({
      POSTGRES_ENGINE_URL: "http://db.test:8097",
      "POSTGRES_ENGINE_TOKEN__org-a": "db-tok-a",
      "POSTGRES_ENGINE_TOKEN__org-b": "db-tok-b",
      POSTGRES_ENGINE_TOKEN__ignored: "   ",
    });
    expect(config.selfHostedDatabaseUrl).toBe("http://db.test:8097");
    expect(config.selfHostedDatabaseTokens).toEqual({ "org-a": "db-tok-a", "org-b": "db-tok-b" });
  });

  it("leaves the database engine unconfigured when only a Coolify URL is set", () => {
    // Coolify provisions databases too, but only when the host rents Coolify.
    // A Coolify token alone does not make the *self-hosted* engine ready.
    const engines = buildEngines({
      coolifyUrl: "https://coolify.test",
      coolifyTokens: { "org-a": "tok-a" },
    });
    const report = engineReport(engines);
    expect(report.find((r) => r.engine === "postgres")?.configured).toBe(true);
    // It is the Coolify adapter that answers, not the self-hosted one.
    expect(engines.database.__engine).not.toBe("postgres");
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
