/**
 * Coolify adapter against a local stub server.
 *
 * The stub is a real HTTP server on 127.0.0.1 that speaks Coolify's documented
 * shape. The adapter's real request code runs against it — no fetch mock — so
 * the URLs, verbs, auth header and status mapping are all exercised.
 *
 * The isolation property under test: organization A's token can never reach
 * organization B's application, because credentials are resolved per tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterContext, ProviderRef } from "@cloud-wai/contracts";
import { createCoolifyHosting, mapDeploymentStatus } from "@cloud-wai/adapters";

const ORG_A = "org-a" as AdapterContext["organizationId"];
const ORG_B = "org-b" as AdapterContext["organizationId"];

const TOKEN_A = "token-team-a";
const TOKEN_B = "token-team-b";

interface Request {
  method: string;
  path: string;
  auth: string | undefined;
}

let server: Server;
let baseUrl = "";
const requests: Request[] = [];
/** Applications, keyed by team token then uuid. */
const applications = new Map<string, Map<string, { name: string; status: string; fqdn: string }>>();

function teamFor(auth: string | undefined) {
  if (auth === `Bearer ${TOKEN_A}`) return TOKEN_A;
  if (auth === `Bearer ${TOKEN_B}`) return TOKEN_B;
  return null;
}

beforeAll(async () => {
  applications.set(TOKEN_A, new Map());
  applications.set(TOKEN_B, new Map());

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = req.headers.authorization;

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: url.pathname, auth });

      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      const team = teamFor(auth);
      if (!team) return json(401, { message: "unauthenticated" });

      const store = applications.get(team)!;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

      if (req.method === "POST" && url.pathname === "/api/v1/applications") {
        const uuid = `app-${team}-${store.size + 1}`;
        store.set(uuid, { name: "app", status: "queued", fqdn: `https://${uuid}.test` });
        return json(201, { uuid });
      }

      if (req.method === "POST" && url.pathname === "/api/v1/deploy") {
        const uuid = String(body.uuid ?? "");
        const app = store.get(uuid);
        if (!app) return json(404, { message: "Not found" });
        app.status = "finished";
        return json(200, { deployments: [{ id: "d1" }] });
      }

      const appMatch = url.pathname.match(/^\/api\/v1\/applications\/([^/]+)$/);
      if (appMatch) {
        const uuid = decodeURIComponent(appMatch[1]!);
        const app = store.get(uuid);
        if (!app) return json(404, { message: "Not found" });
        if (req.method === "GET") return json(200, { uuid, ...app });
        if (req.method === "DELETE") {
          store.delete(uuid);
          return json(200, { message: "deleted" });
        }
      }

      const cancelMatch = url.pathname.match(/^\/api\/v1\/applications\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        const uuid = decodeURIComponent(cancelMatch[1]!);
        const app = store.get(uuid);
        if (!app) return json(404, { message: "Not found" });
        app.status = "cancelled";
        return json(200, { message: "cancelled" });
      }

      const rollbackMatch = url.pathname.match(/^\/api\/v1\/applications\/([^/]+)\/rollback$/);
      if (rollbackMatch && req.method === "POST") {
        const uuid = decodeURIComponent(rollbackMatch[1]!);
        if (!store.has(uuid)) return json(404, { message: "Not found" });
        return json(200, { message: "rolling back" });
      }

      const logsMatch = url.pathname.match(/^\/api\/v1\/applications\/([^/]+)\/logs$/);
      if (logsMatch && req.method === "GET") {
        const uuid = decodeURIComponent(logsMatch[1]!);
        if (!store.has(uuid)) return json(404, { message: "Not found" });
        return json(200, { logs: "line one\nline two", cursor: "c1" });
      }

      json(404, { message: "unknown endpoint" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function adapter() {
  return createCoolifyHosting({
    credentials: (org) => {
      if (org === ORG_A) return { baseUrl, token: TOKEN_A };
      if (org === ORG_B) return { baseUrl, token: TOKEN_B };
      return null;
    },
  });
}

function ctx(
  org: AdapterContext["organizationId"],
  key: string,
  timeoutMs = 2_000,
): AdapterContext {
  return { organizationId: org, idempotencyKey: key, timeoutMs };
}

describe("Coolify adapter", () => {
  it("reports not_configured for an organization with no credentials", async () => {
    const result = await adapter().createApplication(ctx("org-unknown", "k"), { name: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("not_configured");
      expect(result.reason).toContain("org-unknown");
    }
  });

  it("creates an application and reads its state back", async () => {
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "a1"), { name: "Alpha" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const uuid = created.value.providerRef.resourceId;
    const state = await coolify.getDeployment(ctx(ORG_A, "a1"), created.value.providerRef);
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.value.status).toBe("running");
      expect(state.value.url).toBe(`https://${uuid}.test`);
    }
  });

  it("authenticates with the organization's own team token", async () => {
    requests.length = 0;
    await adapter().createApplication(ctx(ORG_B, "b1"), { name: "Beta" });
    const call = requests.find((r) => r.path === "/api/v1/applications");
    expect(call?.auth).toBe(`Bearer ${TOKEN_B}`);
  });

  it("cannot reach another organization's application", async () => {
    const coolify = adapter();
    const createdA = await coolify.createApplication(ctx(ORG_A, "iso-a"), { name: "A" });
    if (!createdA.ok) throw new Error("setup failed");
    const uuidA = createdA.value.providerRef.resourceId;

    // Organization B holds a different token and therefore a different team.
    const asB: ProviderRef = {
      organizationId: ORG_B,
      provider: "coolify",
      resourceType: "application",
      resourceId: uuidA,
    };
    const read = await coolify.getDeployment(ctx(ORG_B, "iso-b"), asB);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.status).toBe("failed"); // Coolify answered 404
  });

  it("deploys, then reports the application as succeeded", async () => {
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "dep"), { name: "Alpha" });
    if (!created.ok) throw new Error("setup failed");

    const deployed = await coolify.deploy(ctx(ORG_A, "dep"), {
      applicationRef: created.value.providerRef,
    });
    expect(deployed.ok).toBe(true);

    const state = await coolify.getDeployment(ctx(ORG_A, "dep"), created.value.providerRef);
    if (!state.ok) throw new Error("unreachable");
    expect(state.value.status).toBe("succeeded");
  });

  it("parses logs and returns a cursor", async () => {
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "logs"), { name: "Alpha" });
    if (!created.ok) throw new Error("setup failed");

    const logs = await coolify.getLogs(ctx(ORG_A, "logs"), created.value.providerRef);
    expect(logs.ok).toBe(true);
    if (logs.ok) {
      expect(logs.value.lines).toEqual(["line one", "line two"]);
      expect(logs.value.cursor).toBe("c1");
    }
  });

  it("cancels and rolls back through the documented endpoints", async () => {
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "ops"), { name: "Alpha" });
    if (!created.ok) throw new Error("setup failed");
    const ref = created.value.providerRef;

    expect((await coolify.cancelDeployment(ctx(ORG_A, "ops"), ref)).ok).toBe(true);
    expect((await coolify.rollback(ctx(ORG_A, "ops"), { applicationRef: ref })).ok).toBe(true);
  });

  it("reconciles an unknown application as not_configured, never a fabricated state", async () => {
    const ref: ProviderRef = {
      organizationId: ORG_A,
      provider: "coolify",
      resourceType: "application",
      resourceId: "app-team-a-does-not-exist",
    };
    const result = await adapter().reconcile(ctx(ORG_A, "recon"), ref);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });

  it("surfaces an unreachable engine as degraded, not failed", async () => {
    const coolify = createCoolifyHosting({
      credentials: () => ({ baseUrl: "http://127.0.0.1:1", token: TOKEN_A }),
    });
    const result = await coolify.createApplication(ctx(ORG_A, "k"), { name: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("degraded");
  });

  it("bounds a hanging engine call", async () => {
    const coolify = createCoolifyHosting({
      credentials: () => ({ baseUrl, token: TOKEN_A }),
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    });
    const result = await coolify.getDeployment(ctx(ORG_A, "slow", 20), {
      organizationId: ORG_A,
      provider: "coolify",
      resourceType: "application",
      resourceId: "any",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("failed");
  });
});

describe("Coolify status mapping", () => {
  it("maps upstream vocabulary to Cloud Wai states", () => {
    expect(mapDeploymentStatus("finished")).toBe("succeeded");
    expect(mapDeploymentStatus("RUNNING:HEALTHY")).toBe("succeeded");
    expect(mapDeploymentStatus("failed")).toBe("failed");
    expect(mapDeploymentStatus("unhealthy")).toBe("degraded");
    expect(mapDeploymentStatus("deploying")).toBe("running");
    expect(mapDeploymentStatus(undefined)).toBe("pending");
    // An unknown upstream value is not success.
    expect(mapDeploymentStatus("something-new")).toBe("pending");
  });
});
