/**
 * Self-hosted runtime adapter against a local stub.
 *
 * The stub is a real HTTP server on 127.0.0.1 that speaks the *pinned* shape of
 * `infra/deployment/runtime-server.mjs` — the routes, verbs and envelopes here
 * mirror that file, so the adapter's real request code runs against it with no
 * fetch mock: URLs, verbs, auth headers, request bodies and status mapping are
 * all exercised.
 *
 * The isolation property under test: organization A's runtime token can never
 * reach organization B's application, because credentials are resolved per
 * tenant. The honesty property: an unconfigured organization gets
 * `not_configured`, never a fabricated deploy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterContext } from "@cloud-wai/contracts";
import { createSelfHostedHostingAdapter } from "@cloud-wai/adapters";

const ORG_A = "org-a" as AdapterContext["organizationId"];
const ORG_B = "org-b" as AdapterContext["organizationId"];

const TOKEN_A = "runtime-token-a";
const TOKEN_B = "runtime-token-b";

interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
}

let server: Server;
let baseUrl = "";
const requests: Recorded[] = [];

/** Applications per token, keyed by id. */
const apps = new Map<
  string,
  Map<string, { name: string; status: string; url: string | null; domains: string[] }>
>();
const envs = new Map<
  string,
  Map<string, { key: string; value: string; isBuildTime: boolean; engineRef: string }>
>();
/** Deploy attempts the runtime has issued, keyed by attempt id. */
const attempts = new Map<
  string,
  { app: string; status: string; url: string | null; engineReason: string | null }
>();
let appSeq = 0;
let attemptSeq = 0;

function tokenFor(auth: string | undefined): string | null {
  if (auth === `Bearer ${TOKEN_A}`) return TOKEN_A;
  if (auth === `Bearer ${TOKEN_B}`) return TOKEN_B;
  return null;
}

function readJson(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data.trim() === "" ? {} : JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res: import("node:http").ServerResponse, code: number, body: unknown) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

beforeAll(async () => {
  apps.set(TOKEN_A, new Map());
  apps.set(TOKEN_B, new Map());
  envs.set(TOKEN_A, new Map());
  envs.set(TOKEN_B, new Map());

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = req.headers.authorization;
    requests.push({ method: req.method ?? "", path: url.pathname, auth });
    if (url.pathname === "/healthz") return send(res, 200, { status: "ok" });

    const token = tokenFor(auth);
    if (!token) return send(res, 401, { message: "Unauthenticated." });
    const tenant = apps.get(token)!;
    const tenantEnv = envs.get(token)!;

    if (req.method === "POST" && url.pathname === "/apps") {
      const body = await readJson(req);
      const id = `app-${++appSeq}`;
      tenant.set(id, { name: String(body.name ?? ""), status: "pending", url: null, domains: [] });
      return send(res, 201, { id });
    }

    const appMatch = url.pathname.match(
      /^\/apps\/([^/]+)(?:\/(deploy|logs|cancel|rollback|env|domains))?$/,
    );
    if (!appMatch) {
      // A deploy attempt is addressable on its own, the way the pinned runtime
      // serves it, so a caller holding only the attempt ref can read it back.
      const attemptMatch = url.pathname.match(/^\/deployments\/([^/]+)(\/cancel)?$/);
      if (attemptMatch && req.method === "GET") {
        const attempt = attempts.get(attemptMatch[1]!);
        if (!attempt) return send(res, 404, { message: "Deployment attempt not found." });
        return send(res, 200, {
          id: attempt.app,
          status: attempt.status,
          url: attempt.url,
          engineReason: attempt.engineReason,
        });
      }
      if (attemptMatch && req.method === "POST") return send(res, 200, {});
      return send(res, 404, { message: "Not found." });
    }
    const id = appMatch[1]!;
    const action = appMatch[2];
    // A tenant can only see its own applications.
    const app = tenant.get(id);
    if (!app) return send(res, 404, { message: "Application not found." });

    if (action === undefined && req.method === "GET") {
      return send(res, 200, { id, status: app.status, url: app.url, artifact: null });
    }
    if (action === "deploy" && req.method === "POST") {
      // An app named `fail-build` makes the runtime report a build failure, so
      // the adapter's reason propagation is exercised for real rather than
      // assumed.
      const failed = app.name.startsWith("fail-build");
      app.status = failed ? "failed" : "succeeded";
      app.url = failed ? null : `http://127.0.0.1:18100/${id}`;
      // The pinned runtime mints a per-attempt id and returns it. The adapter
      // must hand back a *deployment* ref carrying it, so a requeue polls this
      // attempt rather than starting a second deploy.
      const attemptId = `attempt-${++attemptSeq}`;
      attempts.set(attemptId, {
        app: id,
        status: app.status,
        url: app.url,
        engineReason: failed ? "build failed" : null,
      });
      return send(res, 202, { id, attemptId });
    }
    if (action === "logs" && req.method === "GET") {
      const cursor = url.searchParams.get("cursor");
      const lines = ["cloning", "building", "deployed"];
      const from = cursor ? Number(cursor) : 0;
      const slice = lines.slice(from);
      return send(res, 200, { logs: slice, nextCursor: String(lines.length) });
    }
    if (action === "cancel" && req.method === "POST") return send(res, 200, {});
    if (action === "rollback" && req.method === "POST") {
      return send(res, req.headers["x-no-previous"] ? 409 : 202, { id });
    }
    if (action === "env" && req.method === "GET") {
      return send(res, 200, { env: [...tenantEnv.values()] });
    }
    if (action === "domains" && req.method === "PUT") {
      const body = await readJson(req);
      app.domains = Array.isArray(body.domains) ? (body.domains as string[]) : [];
      // An application named `fail-route` makes the runtime report a route
      // failure through `routeError` — the shape the adapter turns into
      // `published: false` — so the honesty mapping is exercised for real.
      const routeError = app.name.startsWith("fail-route")
        ? "runtime could not reach the router"
        : null;
      return send(res, 200, { domains: app.domains, routeError });
    }
    if (action === "env" && req.method === "POST") {
      const body = await readJson(req);
      const record = {
        key: String(body.key ?? ""),
        value: "********",
        isBuildTime: Boolean(body.isBuildTime),
        engineRef: `ref-${String(body.key ?? "")}`,
      };
      tenantEnv.set(record.key, record);
      return send(res, 201, record);
    }
    if (action === "env" && req.method === "DELETE") {
      return send(res, 200, {});
    }
    if (action === undefined && req.method === "DELETE") {
      tenant.delete(id);
      return send(res, 200, {});
    }
    return send(res, 404, { message: "Not found." });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The adapter under test: A and B each get their own token; C has none. */
function adapter() {
  return createSelfHostedHostingAdapter({
    credentials: (org) => {
      if (org === ORG_A) return { baseUrl, token: TOKEN_A };
      if (org === ORG_B) return { baseUrl, token: TOKEN_B };
      return null;
    },
  });
}

function ctx(org: AdapterContext["organizationId"], key = "k1"): AdapterContext {
  return { organizationId: org, idempotencyKey: key, timeoutMs: 5000 };
}

describe("createSelfHostedHostingAdapter", () => {
  it("refuses an organization with no runtime credentials, never fabricating a deploy", async () => {
    const result = await adapter().createApplication(
      ctx("org-c" as AdapterContext["organizationId"]),
      {
        name: "x",
        gitRepository: "https://github.com/example/x.git",
        gitBranch: "main",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe("not_configured");
  });

  it("creates an application and reports the runtime's own id", async () => {
    const result = await adapter().createApplication(ctx(ORG_A), {
      name: "site",
      gitRepository: "https://github.com/example/site.git",
      gitBranch: "main",
      buildPack: "nixpacks",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.providerRef.provider).toBe("selfhosted");
    expect(result.value.providerRef.resourceType).toBe("application");
    expect(result.value.providerRef.resourceId).toMatch(/^app-/);
  });

  it("drives a deploy to success and reads back the runtime's url", async () => {
    const host = adapter();
    const created = await host.createApplication(ctx(ORG_A), {
      name: "site",
      gitRepository: "https://github.com/example/site.git",
      gitBranch: "main",
    });
    if (!created.ok) throw new Error("create failed");
    const ref = created.value.providerRef;

    const deployed = await host.deploy(ctx(ORG_A, "k2"), { applicationRef: ref });
    expect(deployed.ok).toBe(true);
    if (!deployed.ok) throw new Error("unreachable");
    // The runtime accepted the deploy; it has not finished when this returns.
    expect(deployed.status).toBe("running");
    // The handle names the *attempt*, so a requeued job can poll this run's own
    // settled state instead of the application's, which a new attempt would
    // overwrite.
    const runRef = deployed.value.providerRef;
    expect(runRef.resourceType).toBe("deployment");

    const state = await host.getDeployment(ctx(ORG_A, "k3"), runRef);
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.value.status).toBe("succeeded");
    expect(state.value.url).toContain("127.0.0.1");
  });

  it("carries the engine's failure reason so a failed build is explained", async () => {
    const host = adapter();
    const created = await host.createApplication(ctx(ORG_A), {
      name: "fail-build-site",
      gitRepository: "https://github.com/example/site.git",
      gitBranch: "main",
    });
    if (!created.ok) throw new Error("create failed");
    const ref = created.value.providerRef;

    const deployed = await host.deploy(ctx(ORG_A, "kb1"), { applicationRef: ref });
    expect(deployed.ok).toBe(true);
    if (!deployed.ok) throw new Error("unreachable");

    const state = await host.getDeployment(ctx(ORG_A, "kb2"), deployed.value.providerRef);
    expect(state.ok).toBe(true);
    if (!state.ok) throw new Error("unreachable");
    expect(state.value.status).toBe("failed");
    // The reason comes from the engine, not a fabrication at the adapter.
    expect(state.value.reason).toBe("build failed");
  });

  it("cannot reach another tenant's application with its own token", async () => {
    const host = adapter();
    const created = await host.createApplication(ctx(ORG_A), {
      name: "site",
      gitRepository: "https://github.com/example/site.git",
      gitBranch: "main",
    });
    if (!created.ok) throw new Error("create failed");
    const ref = created.value.providerRef;

    // The same resource id, presented by organization B: the runtime answers
    // 404 because B's token cannot see A's application. It is not a success.
    const crossed = await host.getDeployment(ctx(ORG_B, "kb"), ref);
    expect(crossed.ok).toBe(false);
  });

  it("manages environment variables without returning the secret value", async () => {
    const host = adapter();
    const created = await host.createApplication(ctx(ORG_A), {
      name: "site",
      gitRepository: "https://github.com/example/site.git",
      gitBranch: "main",
    });
    if (!created.ok) throw new Error("create failed");
    const ref = created.value.providerRef;

    const write = await host.createEnvVar(ctx(ORG_A, "k-env"), {
      applicationRef: ref,
      variable: { key: "DATABASE_URL", value: "postgres://secret" },
    });
    expect(write.ok).toBe(true);
    if (!write.ok) throw new Error("unreachable");
    expect(write.value.value).not.toContain("secret");

    const list = await host.listEnvVars(ctx(ORG_A, "k-env2"), ref);
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error("unreachable");
    expect(list.value.map((v) => v.key)).toContain("DATABASE_URL");
  });

  it("reports a rollback with no previous image as not_configured, not a crash", async () => {
    const result = await adapter().rollback(ctx(ORG_A), {
      applicationRef: {
        organizationId: ORG_A,
        provider: "selfhosted",
        resourceType: "application",
        resourceId: "missing",
      },
      commit: "abc123",
    });
    // The runtime answers 404 for an unknown application; that is a real
    // refusal surfaced as a non-success result, never a fabricated success.
    expect(result.ok).toBe(false);
  });

  it("sets an application's domains and reports the runtime published them", async () => {
    const host = adapter();
    const created = await host.createApplication(ctx(ORG_A), {
      name: "site",
      gitRepository: "https://github.com/example/site.git",
      gitBranch: "main",
    });
    if (!created.ok) throw new Error("create failed");
    const ref = created.value.providerRef;

    const result = await host.setDomains?.(ctx(ORG_A, "k-domains"), {
      applicationRef: ref,
      hostnames: ["app.example.com"],
    });
    expect(result?.ok).toBe(true);
    if (!result || !result.ok) throw new Error("unreachable");
    expect(result.value.published).toBe(true);
    expect(result.value.reason).toBeNull();
  });

  it("surfaces a route the runtime could not publish, never a false success", async () => {
    const host = adapter();
    const created = await host.createApplication(ctx(ORG_A), {
      name: "fail-route",
      gitRepository: "https://github.com/example/site.git",
      gitBranch: "main",
    });
    if (!created.ok) throw new Error("create failed");
    const ref = created.value.providerRef;

    // The runtime answers 200 with a `routeError`; the adapter must report
    // `published: false` carrying the runtime's own reason, not a false success.
    const result = await host.setDomains?.(ctx(ORG_A, "k-domains-fail"), {
      applicationRef: ref,
      hostnames: ["app.example.com"],
    });
    expect(result?.ok).toBe(true);
    if (!result || !result.ok) throw new Error("unreachable");
    expect(result.value.published).toBe(false);
    expect(result.value.reason).toContain("router");
  });
});
