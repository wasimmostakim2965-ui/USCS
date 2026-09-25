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
  validateDenyRule,
  validateEdgeRoute,
  validateTrustedSource,
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

describe("the decision ladder", () => {
  const policy = { riskLevel: "high" as const, action: "block" as const, version: 3 };

  it("allows verified bots before anything can challenge or block them", () => {
    const compiled = compileEdge({ route: route(), policy, protection: "attack" });
    const stages = compiled.ladder.map((step) => step.stage);
    // The allow steps must precede the challenge and the WAF, or attack mode
    // would break SEO and a customer's own monitors.
    expect(stages.indexOf("allow-verified-bot")).toBeLessThan(stages.indexOf("challenge"));
    expect(stages.indexOf("allow-internal")).toBeLessThan(stages.indexOf("challenge"));
    expect(stages.indexOf("challenge")).toBeLessThan(stages.indexOf("waf"));
  });

  it("requires a forward-confirmed DNS suffix, not just a User-Agent", () => {
    const compiled = compileEdge({ route: route(), protection: "attack" });
    const googlebot = compiled.ladder.find((step) => step.directive.includes("Googlebot"));
    expect(googlebot).toBeDefined();
    // The UA match is chained and carries the confirm suffix, so a scraper that
    // sets `User-Agent: Googlebot` does not get the allow on UA alone.
    expect(googlebot!.directive).toContain("chain");
    expect(googlebot!.directive).toContain("googlebot.com");
  });

  it("challenges browsers only in attack mode", () => {
    const normal = compileEdge({ route: route(), policy });
    const attack = compileEdge({ route: route(), policy, protection: "attack" });
    expect(normal.envoyConfig.challengeBrowsers).toBe(false);
    expect(attack.envoyConfig.challengeBrowsers).toBe(true);
    expect(normal.ladder.some((s) => s.stage === "challenge")).toBe(false);
    expect(attack.ladder.some((s) => s.stage === "challenge")).toBe(true);
  });

  it("keeps the WAF rule in attack mode: a challenge never weakens inspection", () => {
    const attack = compileEdge({ route: route(), policy, protection: "attack" });
    const waf = attack.ladder.find((step) => step.stage === "waf");
    expect(waf).toBeDefined();
    expect(waf!.directive).toContain("status:403");
    expect(attack.envoyConfig.wafEnabled).toBe(true);
  });

  it("compiles a deny rule to a real block, and refuses an invalid one", () => {
    const compiled = compileEdge({
      route: route(),
      denyList: [
        { kind: "ip", value: "203.0.113.9" },
        { kind: "user-agent", value: "EvilScraper" },
        // This one would be directive syntax if it were emitted. It must be
        // dropped, never escaped and forwarded.
        { kind: "user-agent", value: '" \nSecRuleEngine Off' },
      ],
    });
    const blocks = compiled.ladder.filter((step) => step.stage === "block-deny-list");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.directive).toContain("@ipMatch 203.0.113.9");
    expect(blocks[1]!.directive).toContain("@contains EvilScraper");
    expect(compiled.corazaDirectives.some((d) => d.includes("SecRuleEngine Off"))).toBe(false);
  });

  it("validates each deny rule kind against its grammar", () => {
    expect(validateDenyRule({ kind: "ip", value: "10.0.0.1" }).ok).toBe(true);
    expect(validateDenyRule({ kind: "ip", value: "not-an-ip" }).ok).toBe(false);
    expect(validateDenyRule({ kind: "cidr", value: "10.0.0.0/8" }).ok).toBe(true);
    expect(validateDenyRule({ kind: "cidr", value: "10.0.0.0" }).ok).toBe(false);
    expect(validateDenyRule({ kind: "asn", value: "AS15169" }).ok).toBe(true);
    expect(validateDenyRule({ kind: "asn", value: "15169" }).ok).toBe(false);
    expect(validateDenyRule({ kind: "user-agent", value: "Bad Bot/1.0" }).ok).toBe(true);
    expect(validateDenyRule({ kind: "user-agent", value: "Bad;Bot" }).ok).toBe(false);
  });

  it("allows a trusted source address before the deny list and the challenge", () => {
    const compiled = compileEdge({
      route: route(),
      policy,
      protection: "attack",
      denyList: [{ kind: "ip", value: "203.0.113.9" }],
      trustedSources: [
        { kind: "ip", value: "198.51.100.7" },
        { kind: "cidr", value: "192.0.2.0/24" },
      ],
    });
    const stages = compiled.ladder.map((step) => step.stage);
    const trusted = stages.indexOf("allow-trusted-ip");
    expect(trusted).toBeGreaterThan(-1);
    // Before the deny list, so a customer's own webhook sender is allowed even
    // while attack mode is up.
    expect(trusted).toBeLessThan(stages.indexOf("block-deny-list"));
    expect(trusted).toBeLessThan(stages.indexOf("challenge"));
    const steps = compiled.ladder.filter((step) => step.stage === "allow-trusted-ip");
    expect(steps).toHaveLength(2);
    expect(steps[0]!.directive).toContain("@ipMatch 198.51.100.7");
    expect(steps[1]!.directive).toContain("@ipMatch 192.0.2.0/24");
  });

  it("refuses a trusted source that is not an address literal", () => {
    const compiled = compileEdge({
      route: route(),
      trustedSources: [
        // A name would have to be resolved, and the DNS answer is
        // attacker-influenced; it must never become a rule.
        { kind: "ip", value: "hooks.example.com" },
        { kind: "cidr", value: '" \nSecRuleEngine Off' },
        { kind: "ip", value: "203.0.113.4" },
      ],
    });
    const steps = compiled.ladder.filter((step) => step.stage === "allow-trusted-ip");
    expect(steps).toHaveLength(1);
    expect(steps[0]!.directive).toContain("@ipMatch 203.0.113.4");
    expect(compiled.corazaDirectives.some((d) => d.includes("SecRuleEngine Off"))).toBe(false);
  });

  it("validates a trusted source against the same grammar a deny rule uses", () => {
    expect(validateTrustedSource({ kind: "ip", value: "10.0.0.1" }).ok).toBe(true);
    expect(validateTrustedSource({ kind: "ip", value: "10.0.0.0/8" }).ok).toBe(false);
    expect(validateTrustedSource({ kind: "cidr", value: "10.0.0.0/8" }).ok).toBe(true);
    expect(validateTrustedSource({ kind: "cidr", value: "10.0.0.1" }).ok).toBe(false);
  });

  it("stays deterministic with the whole ladder present", () => {
    const input = {
      route: route(),
      policy,
      protection: "attack" as const,
      denyList: [{ kind: "ip" as const, value: "203.0.113.9" }],
    };
    expect(JSON.stringify(compileEdge(input))).toBe(JSON.stringify(compileEdge(input)));
  });

  it("lets a deployment add its own bots without removing the curated ones", () => {
    const compiled = compileEdge({
      route: route(),
      botAllowList: [{ name: "hook", userAgent: "AcmeHook", confirmSuffix: "acme.example" }],
    });
    const directives = compiled.ladder.filter((s) => s.stage === "allow-verified-bot");
    expect(directives.some((s) => s.directive.includes("AcmeHook"))).toBe(true);
    expect(directives.some((s) => s.directive.includes("Googlebot"))).toBe(true);
  });
});
