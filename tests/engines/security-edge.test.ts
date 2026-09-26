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
  BOT_CONFIRM_VARIABLE,
  CORAZA_ACTION,
  INTERNAL_REQUEST_HEADER,
  compileEdge,
  createEnvoySecurityEdge,
  validateDenyRule,
  validateEdgeRoute,
  validateRateLimitRule,
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

  it("emits every bot chain with a matching member, never a dangling chain", () => {
    // `chain` binds a rule to the rule that immediately follows it. A starter
    // with no member is not a valid ruleset, and if the member is the *next*
    // bot's rule then the bots form one impossible AND-chain and no crawler is
    // ever allowed. So: one member per starter, immediately after it, and the
    // member is a suffix check rather than another bot's UA.
    const compiled = compileEdge({ route: route(), policy });
    const lines = compiled.corazaDirectives.flatMap((d) => d.split("\n"));
    lines.forEach((line, index) => {
      if (!line.includes(",chain,")) return;
      const member = lines[index + 1];
      expect(member, `chain starter at ${index} has no member`).toBeDefined();
      // A member must not repeat the bot's UA; it must be the confirm check.
      expect(member).toContain(BOT_CONFIRM_VARIABLE);
      expect(member).not.toContain("User-Agent");
    });
  });

  it("keeps chain members free of the actions Coraza forbids on a member", () => {
    // Coraza rejects `id` and `phase` on a chain member ("can only be specified
    // by chain starter rules"), which would make the whole ruleset fail to load.
    const compiled = compileEdge({ route: route(), policy });
    const members = compiled.corazaDirectives
      .flatMap((d) => d.split("\n"))
      .filter((line) => line.includes(BOT_CONFIRM_VARIABLE));
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(member).not.toMatch(/id:\d+/);
      expect(member).not.toContain("phase:");
    }
  });

  it("does not let a bot chain swallow the internal-request rule", () => {
    // The internal rule is a real rule of its own. If a bot starter chained onto
    // it, the deployment's own probes would stop being recognised.
    const compiled = compileEdge({ route: route(), policy });
    const lines = compiled.corazaDirectives.flatMap((d) => d.split("\n"));
    const internalIndex = lines.findIndex((line) => line.includes(INTERNAL_REQUEST_HEADER));
    expect(internalIndex).toBeGreaterThan(0);
    expect(lines[internalIndex - 1]).toContain(BOT_CONFIRM_VARIABLE);
  });

  it("refuses a hostile bot entry rather than emitting it as a directive", () => {
    // `botAllowList` is operator-supplied and reaches the same templates as a
    // deny rule. A value that would be directive syntax is dropped, never
    // escaped and forwarded.
    const compiled = compileEdge({
      route: route(),
      botAllowList: [
        {
          name: "evil",
          userAgent: '" \nSecRuleEngine Off',
          confirmSuffix: "evil.example",
        },
      ],
    });
    expect(compiled.corazaDirectives.some((d) => d.includes("SecRuleEngine Off"))).toBe(false);
    const evil = compiled.ladder.filter(
      (s) => s.stage === "allow-verified-bot" && s.directive.includes("evil"),
    );
    expect(evil).toEqual([]);
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

  it("reads the anomaly score the pinned CRS actually accumulates", () => {
    // The pinned ruleset is CRS 4.30.0-dev. It accumulates the inbound score in
    // `tx.blocking_inbound_anomaly_score` and reads the threshold from
    // `tx.inbound_anomaly_score_threshold`. `tx.anomaly_score_threshold` does
    // not exist in any CRS version, and `tx.anomaly_score` is a phase-5 derived
    // value, so a phase-2 rule reading it can never fire.
    const compiled = compileEdge({ route: route(), policy });
    const waf = compiled.ladder.find((step) => step.stage === "waf");
    expect(waf!.directive).toContain("TX:BLOCKING_INBOUND_ANOMALY_SCORE");
    expect(waf!.directive).toContain("tx.inbound_anomaly_score_threshold");
    expect(waf!.directive).not.toContain("tx.anomaly_score_threshold");
    expect(compiled.corazaDirectives.some((d) => d.includes("tx.anomaly_score_threshold"))).toBe(
      false,
    );
    const setThreshold = compiled.corazaDirectives.find((d) => d.includes("score_threshold"));
    expect(setThreshold).toContain("tx.inbound_anomaly_score_threshold");
    expect(setThreshold).toContain("phase:1");
  });

  it("raises the block sensitivity as the policy risk rises", () => {
    const thresholdOf = (riskLevel: "low" | "medium" | "high" | "critical") => {
      const compiled = compileEdge({
        route: route(),
        policy: { riskLevel, action: "block", version: 1 },
      });
      const waf = compiled.ladder.find((step) => step.stage === "waf");
      // The literal threshold is set by the phase-1 SecAction; the phase-2 rule
      // compares against the variable, so read the SecAction.
      const setThreshold = compiled.corazaDirectives.find((d) =>
        d.includes("tx.inbound_anomaly_score_threshold="),
      );
      expect(waf).toBeDefined();
      return Number(/threshold=(\d+)/.exec(setThreshold!)![1]);
    };
    // A critical policy blocks on the first critical-severity hit; a low-risk one
    // needs more corroboration before it denies real traffic.
    expect(thresholdOf("critical")).toBeLessThan(thresholdOf("high"));
    expect(thresholdOf("high")).toBeLessThan(thresholdOf("low"));
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

  it("lets a trusted source win when it is also in the deny list", () => {
    // "Trusted" means never blocked. Without the guard on the deny chain, an
    // operator's own webhook sender — an address they trusted and then swept up
    // in a broader block — would be denied by the very rule the allow step is
    // meant to outrank.
    //
    // This asserts on `corazaDirectives`, the config the edge loads, not on the
    // `ladder` summary: the two are built separately, and a ladder that reads
    // correctly while the emitted rules do something else is the exact failure
    // this file keeps finding.
    const compiled = compileEdge({
      route: route(),
      trustedSources: [{ kind: "ip", value: "198.51.100.7" }],
      denyList: [{ kind: "ip", value: "198.51.100.7" }],
    });
    const lines = compiled.corazaDirectives.flatMap((d) => d.split("\n"));
    const denyIndex = lines.findIndex((line) => line.includes("cloud-wai deny list"));
    expect(denyIndex).toBeGreaterThan(-1);
    expect(lines[denyIndex]).toContain("chain");
    // The member immediately follows and fails when the trusted marker is set.
    const member = lines[denyIndex + 1];
    expect(member).toContain("TX:cloud_wai_trusted");
    expect(member).toContain("!@streq 1");
    expect(member).not.toMatch(/id:\d+/);
  });

  it("does not let the trusted guard be claimed without the allow step", () => {
    // The marker is set only by the trusted-source step, from an address literal.
    // With no trusted sources, no request can set it, so the deny guard is inert
    // and an ordinary deny still blocks.
    const compiled = compileEdge({
      route: route(),
      denyList: [{ kind: "ip", value: "203.0.113.9" }],
    });
    expect(compiled.corazaDirectives.some((d) => d.includes("setvar:tx.cloud_wai_trusted"))).toBe(
      false,
    );
    const deny = compiled.corazaDirectives.find((d) => d.includes("cloud-wai deny list"));
    expect(deny).toContain("deny,status:403");
  });

  it("balances every chain in the emitted config, bot and deny alike", () => {
    // One compile with every chain-producing input at once, checked on the real
    // output: each starter is followed by exactly one member, and no member
    // carries the actions Coraza forbids there.
    const compiled = compileEdge({
      route: route(),
      policy,
      trustedSources: [{ kind: "ip", value: "198.51.100.7" }],
      denyList: [
        { kind: "ip", value: "203.0.113.9" },
        { kind: "user-agent", value: "EvilScraper" },
      ],
    });
    const lines = compiled.corazaDirectives.flatMap((d) => d.split("\n"));
    const starters = lines.filter((line) => line.includes(",chain"));
    expect(starters.length).toBeGreaterThan(0);
    for (const [index, line] of lines.entries()) {
      if (!line.includes(",chain")) continue;
      const member = lines[index + 1];
      expect(member, `chain starter at ${index} has no member`).toBeDefined();
      // The member reads a transaction variable, never a request header: the
      // allow must not be claimable from attacker-controlled input.
      expect(member.toLowerCase()).toContain("tx:");
      expect(member.toLowerCase()).not.toContain("request_headers");
      expect(member).not.toMatch(/id:\d+/);
      expect(member).not.toContain("phase:");
      // The next starter must not be this chain's member.
      expect(member).not.toContain(",chain");
    }
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

  it("compiles each deny kind to the variable the edge contract names", () => {
    // IP and CIDR match REMOTE_ADDR directly. ASN and user-agent depend on a
    // value the edge supplies; the exact variable name is the contract in
    // docs/runbooks/deploy-aws.md, so a rename here without the edge is a silent
    // no-op rather than a loud failure.
    const compiled = compileEdge({
      route: route(),
      denyList: [
        { kind: "ip", value: "203.0.113.9" },
        { kind: "cidr", value: "203.0.113.0/24" },
        { kind: "asn", value: "AS15169" },
        { kind: "user-agent", value: "EvilScraper" },
      ],
    });
    const directives = compiled.corazaDirectives.filter((d) => d.includes("cloud-wai deny list"));
    expect(directives).toHaveLength(4);
    expect(directives[0]).toContain("REMOTE_ADDR");
    expect(directives[1]).toContain("REMOTE_ADDR");
    expect(directives[2]).toContain("TX:CLOUD_WAI_ASN");
    expect(directives[2]).toContain("@streq AS15169");
    expect(directives[3]).toContain("REQUEST_HEADERS:User-Agent");
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

  it("compiles one shared rule set with a fragment per host", () => {
    const compiled = compileEdge({
      route: route({ host: "one.example.com" }),
      routes: [
        route({ host: "two.example.com" }),
        // A duplicate host must not produce a duplicate fragment.
        route({ host: "one.example.com" }),
      ],
      policy,
    });
    expect(compiled.envoyRoutes.map((r) => r.host)).toEqual(["one.example.com", "two.example.com"]);
    // The primary is the first fragment, so a single-route caller reads the
    // same shape it always did.
    expect(compiled.envoyConfig).toEqual(compiled.envoyRoutes[0]);
    // One set of directives covers both hosts, because they inspect the request,
    // not the host.
    expect(compiled.corazaDirectives.length).toBe(
      compileEdge({ route: route({ host: "one.example.com" }), policy }).corazaDirectives.length,
    );
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

  it("compiles a rate limit after the allow steps, so a crawler is never counted", () => {
    const compiled = compileEdge({
      route: route(),
      policy,
      protection: "attack",
      botAllowList: [{ name: "hook", userAgent: "AcmeHook", confirmSuffix: "acme.example" }],
      trustedSources: [{ kind: "ip", value: "198.51.100.7" }],
      rateLimits: [{ id: "rl-1", key: "ip", limit: 60, windowSeconds: 60 }],
    });
    const stages = compiled.ladder.map((step) => step.stage);
    const rate = stages.indexOf("ratelimit");
    expect(rate).toBeGreaterThan(-1);
    // After every allow step, or a verified bot would be throttled as if it were
    // a scraper — the exact SEO break the ladder exists to prevent.
    expect(rate).toBeGreaterThan(stages.indexOf("allow-verified-bot"));
    expect(rate).toBeGreaterThan(stages.indexOf("allow-internal"));
    expect(rate).toBeGreaterThan(stages.indexOf("allow-trusted-ip"));
    // Before the challenge and the WAF, so a burst is throttled before it is
    // inspected against the full CRS.
    expect(rate).toBeLessThan(stages.indexOf("challenge"));
    expect(rate).toBeLessThan(stages.indexOf("waf"));
  });

  it("carries the rate limit as a descriptor the edge can actuate", () => {
    const compiled = compileEdge({
      route: route(),
      rateLimits: [
        { id: "rl-1", key: "ip", limit: 60, windowSeconds: 60 },
        { id: "rl-2", key: "header", headerName: "x-api-key", limit: 1000, windowSeconds: 3600 },
        { id: "rl-3", key: "global", limit: 100000, windowSeconds: 1 },
      ],
    });
    expect(compiled.rateLimits).toHaveLength(3);
    expect(compiled.rateLimits[0]).toEqual({
      descriptor: "remote_address",
      limit: 60,
      windowSeconds: 60,
    });
    expect(compiled.rateLimits[1]!.descriptor).toBe("header:x-api-key");
    expect(compiled.rateLimits[2]!.descriptor).toBe("route_global");
    expect(compiled.corazaDirectives.some((d) => d.includes("cloud_wai_rate_limit=60/60s"))).toBe(
      true,
    );
  });

  it("refuses a rate limit that is not a real rule, never escaping it into a directive", () => {
    const compiled = compileEdge({
      route: route(),
      rateLimits: [
        // A header name that is directive syntax must be refused, not escaped.
        {
          id: "bad-1",
          key: "header",
          headerName: '" \nSecRuleEngine Off',
          limit: 10,
          windowSeconds: 60,
        },
        // A header name on a non-header key is a half-specified rule.
        { id: "bad-2", key: "ip", headerName: "x-api-key", limit: 10, windowSeconds: 60 },
        // Zero and out-of-range values are refused.
        { id: "bad-3", key: "ip", limit: 0, windowSeconds: 60 },
        { id: "bad-4", key: "ip", limit: 10, windowSeconds: 0 },
        // The one valid rule is the only one that becomes a descriptor.
        { id: "ok-1", key: "ip", limit: 60, windowSeconds: 60 },
      ],
    });
    expect(compiled.rateLimits).toHaveLength(1);
    expect(compiled.corazaDirectives.some((d) => d.includes("SecRuleEngine Off"))).toBe(false);
  });

  it("validates a rate-limit rule against its key and bounds", () => {
    expect(validateRateLimitRule({ id: "a", key: "ip", limit: 60, windowSeconds: 60 }).ok).toBe(
      true,
    );
    expect(validateRateLimitRule({ id: "a", key: "global", limit: 1, windowSeconds: 1 }).ok).toBe(
      true,
    );
    expect(
      validateRateLimitRule({
        id: "a",
        key: "header",
        headerName: "x-api-key",
        limit: 1,
        windowSeconds: 1,
      }).ok,
    ).toBe(true);
    // A header key without a header name is refused.
    expect(validateRateLimitRule({ id: "a", key: "header", limit: 1, windowSeconds: 1 }).ok).toBe(
      false,
    );
    // A non-header key that names a header is refused.
    expect(
      validateRateLimitRule({ id: "a", key: "ip", headerName: "x", limit: 1, windowSeconds: 1 }).ok,
    ).toBe(false);
    // Bounds.
    expect(validateRateLimitRule({ id: "a", key: "ip", limit: 0, windowSeconds: 60 }).ok).toBe(
      false,
    );
    expect(validateRateLimitRule({ id: "a", key: "ip", limit: 60, windowSeconds: 0 }).ok).toBe(
      false,
    );
    expect(validateRateLimitRule({ id: "a", key: "ip", limit: 60, windowSeconds: 86_401 }).ok).toBe(
      false,
    );
  });

  it("stays deterministic with a rate limit present", () => {
    const input = {
      route: route(),
      policy,
      rateLimits: [
        {
          id: "rl-1",
          key: "header" as const,
          headerName: "x-api-key",
          limit: 60,
          windowSeconds: 60,
        },
      ],
    };
    expect(JSON.stringify(compileEdge(input))).toBe(JSON.stringify(compileEdge(input)));
  });
});
