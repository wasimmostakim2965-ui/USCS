/**
 * Coolify adapter against a local stub server.
 *
 * The stub is a real HTTP server on 127.0.0.1 that speaks the *pinned upstream*
 * shape — the routes, verbs, request fields and response envelopes here were
 * read out of `engines-src/coolify` at commit 7c86e53422ad, not invented. The
 * adapter's real request code runs against it (no fetch mock), so URLs, verbs,
 * auth headers, request bodies and status mapping are all exercised.
 *
 * The isolation property under test: organization A's token can never reach
 * organization B's application, because credentials are resolved per tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { AdapterContext, ProviderRef } from "@cloud-wai/contracts";
import { createCoolifyHosting, mapDeploymentStatus, mapQueueStatus } from "@cloud-wai/adapters";

const ORG_A = "org-a" as AdapterContext["organizationId"];
const ORG_B = "org-b" as AdapterContext["organizationId"];

const TOKEN_A = "token-team-a";
const TOKEN_B = "token-team-b";

/** Coolify infrastructure UUIDs are per-tenant, exactly as in production. */
const INFRA = {
  [TOKEN_A]: { project: "proj-a", server: "srv-a", environment: "production" },
  [TOKEN_B]: { project: "proj-b", server: "srv-b", environment: "production" },
} as const;

interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
  body: Record<string, unknown>;
}

let server: Server;
let baseUrl = "";
const requests: Recorded[] = [];

/** Applications per team token, keyed by uuid. */
const applications = new Map<
  string,
  Map<string, { name: string; status: string; fqdn: string }>
>();
/** Queued deployments per team token, keyed by deployment_uuid. */
const deployments = new Map<string, Map<string, { status: string }>>();

function teamFor(auth: string | undefined) {
  if (auth === `Bearer ${TOKEN_A}`) return TOKEN_A;
  if (auth === `Bearer ${TOKEN_B}`) return TOKEN_B;
  return null;
}

beforeAll(async () => {
  applications.set(TOKEN_A, new Map());
  applications.set(TOKEN_B, new Map());
  deployments.set(TOKEN_A, new Map());
  deployments.set(TOKEN_B, new Map());

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = req.headers.authorization;

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ method: req.method ?? "", path: url.pathname, auth, body: parsed });

      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      const team = teamFor(auth);
      if (!team) return json(401, { message: "unauthenticated" });

      const apps = applications.get(team)!;
      const deps = deployments.get(team)!;
      const infra = INFRA[team as keyof typeof INFRA];

      // POST /api/v1/applications/public — the real create route. Coolify has
      // no generic POST /applications, and this stub does not pretend it does.
      if (req.method === "POST" && url.pathname === "/api/v1/applications/public") {
        const missing = ["project_uuid", "server_uuid", "git_repository", "git_branch"].filter(
          (field) => !parsed[field],
        );
        if (missing.length > 0) {
          return json(422, { message: "Validation failed.", errors: missing });
        }
        if (parsed.project_uuid !== infra.project || parsed.server_uuid !== infra.server) {
          return json(404, { message: "Project not found." });
        }
        const uuid = `app-${team}-${apps.size + 1}`;
        apps.set(uuid, {
          name: String(parsed.name ?? ""),
          status: "exited:unhealthy",
          fqdn: `https://${uuid}.test`,
        });
        // Coolify answers 201 with { uuid, domains }.
        return json(201, { uuid, domains: `https://${uuid}.test` });
      }

      // POST /api/v1/deploy — queues work and returns a deployment_uuid.
      if (req.method === "POST" && url.pathname === "/api/v1/deploy") {
        const uuid = String(parsed.uuid ?? "");
        if (!apps.has(uuid)) return json(404, { message: "No resources found." });
        const deploymentUuid = `dep-${team}-${deps.size + 1}`;
        deps.set(deploymentUuid, { status: "queued" });
        return json(200, {
          deployments: [
            { message: "Deployment queued.", resource_uuid: uuid, deployment_uuid: deploymentUuid },
          ],
        });
      }

      // GET /api/v1/deployments/{uuid} — the deployment queue record.
      const depMatch = url.pathname.match(/^\/api\/v1\/deployments\/([^/]+)$/);
      if (depMatch && req.method === "GET") {
        const key = decodeURIComponent(depMatch[1]!);
        const deployment = deps.get(key);
        if (!deployment) return json(404, { message: "Deployment not found." });
        return json(200, { deployment_uuid: key, status: deployment.status });
      }

      // POST /api/v1/deployments/{uuid}/cancel — by deployment uuid.
      const cancelMatch = url.pathname.match(/^\/api\/v1\/deployments\/([^/]+)\/cancel$/);
      if (cancelMatch && req.method === "POST") {
        const key = decodeURIComponent(cancelMatch[1]!);
        const deployment = deps.get(key);
        if (!deployment) return json(404, { message: "Deployment not found." });
        deployment.status = "cancelled-by-user";
        return json(200, { message: "Deployment cancelled.", status: deployment.status });
      }

      // POST /api/v1/applications/{uuid}/rollback — requires `commit`.
      const rollbackMatch = url.pathname.match(/^\/api\/v1\/applications\/([^/]+)\/rollback$/);
      if (rollbackMatch && req.method === "POST") {
        const uuid = decodeURIComponent(rollbackMatch[1]!);
        if (!apps.has(uuid)) return json(404, { message: "Application not found." });
        if (typeof parsed.commit !== "string" || parsed.commit.trim() === "") {
          return json(422, { message: "Validation failed.", errors: { commit: ["required"] } });
        }
        const deploymentUuid = `dep-${team}-rollback-${deps.size + 1}`;
        deps.set(deploymentUuid, { status: "queued" });
        return json(200, { message: "Rollback queued.", deployment_uuid: deploymentUuid });
      }

      // GET /api/v1/applications/{uuid} and DELETE
      const appMatch = url.pathname.match(/^\/api\/v1\/applications\/([^/]+)$/);
      if (appMatch) {
        const uuid = decodeURIComponent(appMatch[1]!);
        const app = apps.get(uuid);
        if (!app) return json(404, { message: "Application not found." });
        if (req.method === "GET") return json(200, { uuid, ...app });
        if (req.method === "DELETE") {
          apps.delete(uuid);
          return json(200, { message: "Application deleted." });
        }
      }

      // GET /api/v1/applications/{uuid}/logs — { logs }, no cursor in the schema.
      const logsMatch = url.pathname.match(/^\/api\/v1\/applications\/([^/]+)\/logs$/);
      if (logsMatch && req.method === "GET") {
        const uuid = decodeURIComponent(logsMatch[1]!);
        if (!apps.has(uuid)) return json(404, { message: "Application not found." });
        return json(200, { logs: "line one\nline two" });
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
      if (org === ORG_A) {
        return {
          baseUrl,
          token: TOKEN_A,
          projectUuid: INFRA[TOKEN_A].project,
          serverUuid: INFRA[TOKEN_A].server,
          environmentName: INFRA[TOKEN_A].environment,
        };
      }
      if (org === ORG_B) {
        return {
          baseUrl,
          token: TOKEN_B,
          projectUuid: INFRA[TOKEN_B].project,
          serverUuid: INFRA[TOKEN_B].server,
          environmentName: INFRA[TOKEN_B].environment,
        };
      }
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

const CREATE_INPUT = {
  name: "Alpha",
  gitRepository: "https://github.com/example/alpha",
  gitBranch: "main",
} as const;

describe("Coolify adapter", () => {
  it("reports not_configured for an organization with no credentials", async () => {
    const result = await adapter().createApplication(ctx("org-unknown", "k"), CREATE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("not_configured");
      expect(result.reason).toContain("org-unknown");
    }
  });

  it("creates an application through the real /applications/public route", async () => {
    requests.length = 0;
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "a1"), CREATE_INPUT);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const call = requests.find((r) => r.path === "/api/v1/applications/public");
    expect(call?.method).toBe("POST");
    // The body Coolify actually requires, verified field by field.
    expect(call?.body.project_uuid).toBe("proj-a");
    expect(call?.body.server_uuid).toBe("srv-a");
    expect(call?.body.environment_name).toBe("production");
    expect(call?.body.git_repository).toBe("https://github.com/example/alpha");
    expect(call?.body.git_branch).toBe("main");
    expect(call?.body.build_pack).toBe("nixpacks");
  });

  it("never calls a generic POST /applications, which Coolify does not have", async () => {
    requests.length = 0;
    await adapter().createApplication(ctx(ORG_A, "shape"), CREATE_INPUT);
    expect(
      requests.some((r) => r.path === "/api/v1/applications" && r.method === "POST"),
    ).toBe(false);
  });

  it("reads application state back with the state:health vocabulary", async () => {
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "a2"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");

    const state = await coolify.getDeployment(ctx(ORG_A, "a2"), created.value.providerRef);
    expect(state.ok).toBe(true);
    if (state.ok) {
      // `exited:unhealthy` is not a healthy application.
      expect(state.value.status).toBe("failed");
      expect(state.value.url).toBe(`https://${created.value.providerRef.resourceId}.test`);
    }
  });

  it("authenticates with the organization's own team token", async () => {
    requests.length = 0;
    await adapter().createApplication(ctx(ORG_B, "b1"), CREATE_INPUT);
    const call = requests.find((r) => r.path === "/api/v1/applications/public");
    expect(call?.auth).toBe(`Bearer ${TOKEN_B}`);
  });

  it("cannot reach another organization's application", async () => {
    const coolify = adapter();
    const createdA = await coolify.createApplication(ctx(ORG_A, "iso-a"), CREATE_INPUT);
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

  it("reports a queued deploy as running, with the deployment uuid Coolify returned", async () => {
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "dep"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");

    const deployed = await coolify.deploy(ctx(ORG_A, "dep"), {
      applicationRef: created.value.providerRef,
    });
    expect(deployed.ok).toBe(true);
    if (!deployed.ok) throw new Error("unreachable");
    // Queueing is not completion. Claiming succeeded here would be a lie.
    expect(deployed.status).toBe("running");
    expect(deployed.value.providerRef.resourceType).toBe("deployment");
    expect(deployed.value.providerRef.resourceId).toContain("dep-");
  });

  it("reads a deployment's own state from the deployment queue", async () => {
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "depq"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");
    const deployed = await coolify.deploy(ctx(ORG_A, "depq"), {
      applicationRef: created.value.providerRef,
    });
    if (!deployed.ok) throw new Error("setup failed");

    const state = await coolify.getDeployment(ctx(ORG_A, "depq"), deployed.value.providerRef);
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.value.status).toBe("running"); // still queued
  });

  it("cancels by deployment uuid, not by application uuid", async () => {
    requests.length = 0;
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "ops"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");
    const deployed = await coolify.deploy(ctx(ORG_A, "ops"), {
      applicationRef: created.value.providerRef,
    });
    if (!deployed.ok) throw new Error("setup failed");

    const cancelled = await coolify.cancelDeployment(ctx(ORG_A, "ops"), deployed.value.providerRef);
    expect(cancelled.ok).toBe(true);
    const call = requests.find((r) => r.path.endsWith("/cancel"));
    expect(call?.path).toBe(`/api/v1/deployments/${deployed.value.providerRef.resourceId}/cancel`);
  });

  it("refuses to cancel an application ref rather than sending a request Coolify rejects", async () => {
    requests.length = 0;
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "badcancel"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");

    const result = await coolify.cancelDeployment(
      ctx(ORG_A, "badcancel"),
      created.value.providerRef,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("deployment uuid");
    expect(requests.some((r) => r.path.endsWith("/cancel"))).toBe(false);
  });

  it("sends the commit Coolify requires on rollback", async () => {
    requests.length = 0;
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "rb"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");

    const rolled = await coolify.rollback(ctx(ORG_A, "rb"), {
      applicationRef: created.value.providerRef,
      commit: "abc123",
    });
    expect(rolled.ok).toBe(true);
    const call = requests.find((r) => r.path.endsWith("/rollback"));
    expect(call?.body.commit).toBe("abc123");
  });

  it("reports a rollback without a commit as failed instead of a fake success", async () => {
    requests.length = 0;
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "rb2"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");

    const rolled = await coolify.rollback(ctx(ORG_A, "rb2"), {
      applicationRef: created.value.providerRef,
      commit: "   ",
    });
    expect(rolled.ok).toBe(false);
    if (!rolled.ok) expect(rolled.status).toBe("failed");
    expect(requests.some((r) => r.path.endsWith("/rollback"))).toBe(false);
  });

  it("parses logs and reports the cursor as null, because Coolify has none", async () => {
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "logs"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");

    const logs = await coolify.getLogs(ctx(ORG_A, "logs"), created.value.providerRef);
    expect(logs.ok).toBe(true);
    if (logs.ok) {
      expect(logs.value.lines).toEqual(["line one", "line two"]);
      expect(logs.value.cursor).toBeNull();
    }
  });

  it("creates, deploys, cancels, rolls back and deletes through documented endpoints", async () => {
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "life"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");
    const ref = created.value.providerRef;

    const deployed = await coolify.deploy(ctx(ORG_A, "life"), { applicationRef: ref });
    if (!deployed.ok) throw new Error("deploy failed");
    expect(
      (await coolify.cancelDeployment(ctx(ORG_A, "life"), deployed.value.providerRef)).ok,
    ).toBe(true);
    expect(
      (await coolify.rollback(ctx(ORG_A, "life"), { applicationRef: ref, commit: "abc123" })).ok,
    ).toBe(true);
    expect((await coolify.deleteApplication(ctx(ORG_A, "life"), ref)).ok).toBe(true);
  });

  it("refuses create when the source repository is missing, and does not call Coolify", async () => {
    requests.length = 0;
    const result = await adapter().createApplication(ctx(ORG_A, "nosource"), { name: "NoSource" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("failed");
      expect(result.reason).toContain("gitRepository");
    }
    expect(requests.length).toBe(0);
  });

  it("reports not_configured when the tenant's Coolify infrastructure is incomplete", async () => {
    const partial = createCoolifyHosting({
      credentials: () => ({ baseUrl, token: TOKEN_A }),
    });
    const result = await partial.createApplication(ctx(ORG_A, "partial"), CREATE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("not_configured");
      expect(result.reason).toContain("projectUuid");
    }
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
      credentials: () => ({
        baseUrl: "http://127.0.0.1:1",
        token: TOKEN_A,
        projectUuid: INFRA[TOKEN_A].project,
        serverUuid: INFRA[TOKEN_A].server,
        environmentName: INFRA[TOKEN_A].environment,
      }),
    });
    const result = await coolify.createApplication(ctx(ORG_A, "k"), CREATE_INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("degraded");
  });

  it("bounds a hanging engine call", async () => {
    const coolify = createCoolifyHosting({
      credentials: () => ({
        baseUrl,
        token: TOKEN_A,
        projectUuid: INFRA[TOKEN_A].project,
        serverUuid: INFRA[TOKEN_A].server,
        environmentName: INFRA[TOKEN_A].environment,
      }),
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
  it("maps application state:health vocabulary to Cloud Wai states", () => {
    expect(mapDeploymentStatus("running:healthy")).toBe("succeeded");
    expect(mapDeploymentStatus("running (healthy)")).toBe("succeeded");
    expect(mapDeploymentStatus("RUNNING:HEALTHY")).toBe("succeeded");
    expect(mapDeploymentStatus("running:unhealthy")).toBe("running");
    expect(mapDeploymentStatus("running:starting")).toBe("running");
    expect(mapDeploymentStatus("starting")).toBe("running");
    expect(mapDeploymentStatus("restarting")).toBe("running");
    expect(mapDeploymentStatus("paused")).toBe("degraded");
    expect(mapDeploymentStatus("exited")).toBe("failed");
    expect(mapDeploymentStatus("dead")).toBe("failed");
    expect(mapDeploymentStatus(undefined)).toBe("pending");
    // An unknown upstream value is not success.
    expect(mapDeploymentStatus("something-new")).toBe("pending");
  });

  it("maps the deployment queue vocabulary to Cloud Wai states", () => {
    expect(mapQueueStatus("queued")).toBe("running");
    expect(mapQueueStatus("in_progress")).toBe("running");
    expect(mapQueueStatus("finished")).toBe("succeeded");
    expect(mapQueueStatus("failed")).toBe("degraded");
    expect(mapQueueStatus("cancelled-by-user")).toBe("failed");
    expect(mapQueueStatus(undefined)).toBe("pending");
    expect(mapQueueStatus("something-new")).toBe("pending");
  });

  it("never reports an unknown value as a finished deployment", () => {
    for (const raw of ["", "weird", "finished-ish", "SUCCESS?"]) {
      expect(mapQueueStatus(raw)).not.toBe("succeeded");
    }
  });
});

describe("adapter routes exist in the pinned Coolify route table", () => {
  // Deriving the fixture from the pinned commit rather than typing it here means
  // a route that Coolify does not have cannot pass this test.
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/coolify-routes.json", import.meta.url), "utf8"),
  ) as { _commit: string; routes: { method: string; path: string }[] };

  const patternFor = (path: string) =>
    new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[a-z_]+\}/g, "[^/]+")}$`);

  it("pins a real upstream commit", () => {
    expect(fixture._commit).toBe("7c86e53422ad7c4f19c5821621c71403b9173f62");
    expect(fixture.routes.length).toBeGreaterThan(0);
  });

  it("confirms Coolify has no bare POST /applications, which the old adapter assumed", () => {
    expect(
      fixture.routes.some((r) => r.method === "POST" && r.path === "/api/v1/applications"),
    ).toBe(false);
    expect(
      fixture.routes.some(
        (r) => r.method === "POST" && r.path === "/api/v1/applications/public",
      ),
    ).toBe(true);
  });

  it("uses only routes that exist upstream, across the whole lifecycle", async () => {
    requests.length = 0;
    const coolify = adapter();
    const created = await coolify.createApplication(ctx(ORG_A, "shape-everything"), CREATE_INPUT);
    if (!created.ok) throw new Error("setup failed");
    const ref = created.value.providerRef;

    const deployed = await coolify.deploy(ctx(ORG_A, "shape-everything"), { applicationRef: ref });
    if (!deployed.ok) throw new Error("deploy failed");

    await coolify.getDeployment(ctx(ORG_A, "shape-everything"), ref);
    await coolify.getDeployment(ctx(ORG_A, "shape-everything"), deployed.value.providerRef);
    await coolify.cancelDeployment(ctx(ORG_A, "shape-everything"), deployed.value.providerRef);
    await coolify.rollback(ctx(ORG_A, "shape-everything"), {
      applicationRef: ref,
      commit: "abc123",
    });
    await coolify.getLogs(ctx(ORG_A, "shape-everything"), ref);
    await coolify.reconcile(ctx(ORG_A, "shape-everything"), ref);
    await coolify.deleteApplication(ctx(ORG_A, "shape-everything"), ref);

    const called = requests.filter((r) => r.path !== "/api/v1/applications/public");
    expect(called.length).toBeGreaterThan(5);

    for (const call of requests) {
      const exists = fixture.routes.some(
        (route) => route.method === call.method && patternFor(route.path).test(call.path),
      );
      expect(
        exists,
        `${call.method} ${call.path} is not in the pinned Coolify route table`,
      ).toBe(true);
    }
  });
});
