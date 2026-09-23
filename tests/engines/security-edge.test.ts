/**
 * Security edge adapter.
 *
 * Two things are worth proving here: that customer input can never become a
 * Coraza directive by concatenation, and that the adapter is honest about a
 * policy version it did not get to apply.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterContext, ProviderRef } from "@cloud-wai/contracts";
import {
  CORAZA_ACTION,
  compileEdge,
  createEnvoySecurityEdge,
  validateEdgeRoute,
  type EdgeRoute,
} from "@cloud-wai/adapters";

const ORG = "org-edge" as AdapterContext["organizationId"];
const ctx = (key = "k"): AdapterContext => ({
  organizationId: ORG,
  idempotencyKey: key,
  timeoutMs: 2_000,
});

const route = (over: Partial<EdgeRoute> = {}): EdgeRoute => ({
  host: "app.example.com",
  origin: "10.0.0.7:3000",
  pathPrefix: "/api",
  organizationId: ORG,
  ...over,
});

describe("edge compile", () => {
  it("maps every enforcement action to a Coraza action", () => {
    expect(CORAZA_ACTION.allow).toBe("pass");
    expect(CORAZA_ACTION.log).toBe("pass");
    expect(CORAZA_ACTION.challenge).toBe("deny");
    expect(CORAZA_ACTION.block).toBe("deny");
    expect(CORAZA_ACTION.quarantine).toBe("deny");
  });

  it("is deterministic: the same input compiles to the same config", () => {
    const input = {
      route: route(),
      policy: { riskLevel: "high" as const, action: "block" as const, version: 7 },
    };
    expect(JSON.stringify(compileEdge(input))).toBe(JSON.stringify(compileEdge(input)));
  });

  it("carries the policy version into the distribution", () => {
    const compiled = compileEdge({
      route: route(),
      policy: { riskLevel: "low", action: "log", version: 4 },
    });
    expect(compiled.version).toBe(4);
  });

  it("keeps the origin private in the generated config", () => {
    const compiled = compileEdge({ route: route() });
    expect(compiled.envoyConfig.privateOrigin).toBe("10.0.0.7:3000");
    expect(compiled.envoyConfig.wafEnabled).toBe(false);
  });

  it("rejects a public origin", () => {
    const verdict = validateEdgeRoute(route({ origin: "203.0.113.5:8080" }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("private address");
  });

  // The important one: hostile input is refused, not quoted and forwarded.
  it.each([
    ["host with a directive", route({ host: 'evil.com" \nSecRuleRemoveById 900000' })],
    ["host with a space", route({ host: "evil .com" })],
    ["path with a newline", route({ pathPrefix: "/api\nSecRuleEngine Off" })],
    ["path with a quote", route({ pathPrefix: '/api"inject' })],
    ["path not starting with a slash", route({ pathPrefix: "api" })],
    ["absolute URL as path", route({ pathPrefix: "/api; rm -rf /" })],
  ])("refuses %s", (_label, hostile) => {
    expect(validateEdgeRoute(hostile).ok).toBe(false);
  });

  it("accepts an IPv6 unique-local origin", () => {
    expect(validateEdgeRoute(route({ origin: "[fd00::1]:3000" })).ok).toBe(true);
  });
});

describe("edge adapter", () => {
  let server: Server;
  let adminUrl = "";
  const seen: { method: string; path: string; body: string }[] = [];
  let policyStatus = 200;
  let policyBody: unknown = { version: 9 };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", path: url.pathname, body });
        if (!req.headers.authorization?.startsWith("Bearer ")) {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ message: "unauthenticated" }));
        }
        if (url.pathname === "/edge/v1/policies") {
          res.writeHead(policyStatus, { "content-type": "application/json" });
          return res.end(JSON.stringify(policyBody));
        }
        if (url.pathname === "/edge/v1/routes" && req.method === "POST") {
          res.writeHead(201, { "content-type": "application/json" });
          return res.end(JSON.stringify({ version: 1 }));
        }
        if (url.pathname.startsWith("/edge/v1/health/")) {
          // Deliberately does not report the flag: absence is not health.
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ status: "unknown" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    adminUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const adapter = (routes: Record<string, EdgeRoute> = {}) =>
    createEnvoySecurityEdge({
      credentials: (org) => (org === ORG ? { adminUrl, token: "edge-token" } : null),
      resolveRoute: (ref) => routes[ref.resourceId] ?? null,
      resolvePolicy: () => ({
        route: route(),
        policy: { riskLevel: "high", action: "block", version: 9 },
      }),
    });

  const routeRef = (id: string): ProviderRef => ({
    organizationId: ORG,
    provider: "envoy",
    resourceType: "route",
    resourceId: id,
  });

  it("reports not_configured without edge credentials", async () => {
    const bare = createEnvoySecurityEdge({
      credentials: () => null,
      resolveRoute: () => route(),
      resolvePolicy: () => null,
    });
    const result = await bare.publishRoute(ctx(), { routeRef: routeRef("app.example.com") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });

  it("fails honestly for an unknown route rather than guessing", async () => {
    const result = await adapter().publishRoute(ctx(), { routeRef: routeRef("nope.example.com") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("No route is known");
  });

  it("publishes a known route and sends only the compiled config", async () => {
    const result = await adapter({ "app.example.com": route() }).publishRoute(ctx("publish"), {
      routeRef: routeRef("app.example.com"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.providerRef.resourceId).toBe("app.example.com");

    const call = seen.at(-1)!;
    expect(call.path).toBe("/edge/v1/routes");
    const sent = JSON.parse(call.body);
    expect(sent.envoyConfig.privateOrigin).toBe("10.0.0.7:3000");
    expect(sent.corazaDirectives.some((d: string) => d.includes("SecRuleEngine On"))).toBe(true);
  });

  it("refuses to publish a route whose origin is public", async () => {
    const result = await adapter({
      "app.example.com": route({ origin: "8.8.8.8:80" }),
    }).publishRoute(ctx("public"), { routeRef: routeRef("app.example.com") });
    expect(result.ok).toBe(false);
  });

  it("reports a stale policy version as a failure, not a success", async () => {
    policyStatus = 409;
    policyBody = { message: "a newer policy version is active" };
    const result = await adapter().applyPolicy(ctx("stale"), {
      ref: { organizationId: ORG, provider: "coraza", resourceType: "policy", resourceId: "p1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("newer policy version");
    }
    policyStatus = 200;
    policyBody = { version: 9 };
  });

  it("does not call an absent health flag healthy", async () => {
    const result = await adapter().inspectHealth(ctx("health"), {
      ref: {
        organizationId: ORG,
        provider: "envoy",
        resourceType: "route",
        resourceId: "app.example.com",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.healthy).toBe(false);
  });
});
