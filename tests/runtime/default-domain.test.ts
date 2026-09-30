/**
 * The default deployment hostname, against the real runtime and router.
 *
 * A deployment needs an address before a customer adds a domain, the way a
 * Vercel deployment has a `<project>.vercel.app` url. The runtime mints that
 * hostname under `RUNTIME_DEFAULT_DOMAIN_SUFFIX`, publishes it to the router
 * with automatic TLS, and reports it as the app's url. Two honesty properties
 * matter: the minted name is a real DNS name the router was actually told to
 * serve (never an invented url), and a customer's own domain is added
 * *alongside* it, not instead of it.
 *
 * This starts the real `runtime-server.mjs` and a recording router, so the HTTP
 * the runtime emits is what is asserted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(__dirname, "../../infra/deployment/runtime-server.mjs");
const RUNTIME_TOKEN = "runtime-default-domain-token";
const ROUTER_TOKEN = "router-admin-token";
const RUNTIME_PORT = 18296;
const ROUTER_PORT = 18298;
const APP_DOMAIN = "apps.example.com";

let child: ChildProcess;
let router: Server;
let dataDir = "";

interface RouteCall {
  method: string;
  host: string;
  tls?: string;
}
const routeCalls: RouteCall[] = [];

const SEED_ID = "seed-default-1";
const SEED_PORT = 18310;

async function rpc(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${RUNTIME_PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  router = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if ((req.headers.authorization ?? "") !== `Bearer ${ROUTER_TOKEN}`) {
      res.writeHead(401).end("{}");
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (url.pathname === "/routes" && req.method === "PUT") {
        const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
        routeCalls.push({
          method: "PUT",
          host: String(body.host ?? ""),
          tls: body.tls === undefined ? undefined : String(body.tls),
        });
        res.writeHead(202, { "content-type": "application/json" }).end("{}");
        return;
      }
      const del = url.pathname.match(/^\/routes\/(.+)$/);
      if (del && req.method === "DELETE") {
        routeCalls.push({ method: "DELETE", host: decodeURIComponent(del[1]!) });
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise<void>((resolve) => router.listen(ROUTER_PORT, "127.0.0.1", resolve));

  dataDir = await mkdtemp(join(tmpdir(), "cw-runtime-default-domain-"));
  await writeFile(
    join(dataDir, "apps.json"),
    JSON.stringify({
      apps: {
        [SEED_ID]: {
          id: SEED_ID,
          name: "My Demo Site",
          organizationId: null,
          domains: [],
          port: 3000,
          env: {},
          hostPort: SEED_PORT,
          container: `cw-app-${SEED_ID}`,
          currentImage: "example:latest",
          status: "succeeded",
          routeError: null,
          logs: [],
        },
      },
    }),
  );
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      RUNTIME_TOKEN,
      RUNTIME_PORT: String(RUNTIME_PORT),
      RUNTIME_HOST: "127.0.0.1",
      RUNTIME_DATA_DIR: dataDir,
      BUILDER_URL: "",
      ROUTER_URL: `http://127.0.0.1:${ROUTER_PORT}`,
      ROUTER_TOKEN,
      RUNTIME_DEFAULT_DOMAIN_SUFFIX: APP_DOMAIN,
      RUNTIME_PUBLIC_SCHEME: "https",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${RUNTIME_PORT}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("runtime server did not start");
});

afterAll(async () => {
  child?.kill("SIGKILL");
  await new Promise<void>((resolve) => router.close(() => resolve()));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("the runtime mints a default deployment hostname", () => {
  it("gives an app a real default hostname the router is told to serve", async () => {
    routeCalls.length = 0;
    const set = await rpc("PUT", `/apps/${SEED_ID}/domains`, { domains: [] });

    expect(set.status).toBe(200);
    expect(set.json.defaultHostname).toBe(`my-demo-site.${APP_DOMAIN}`);
    // The reported url is the public name, not the loopback port.
    expect(set.json.url).toBe(`https://my-demo-site.${APP_DOMAIN}`);
    expect(set.json.routeError).toBeNull();
    // It is a name the router was actually told to serve with TLS — not an
    // invented url that resolves nowhere.
    expect(routeCalls).toContainEqual({
      method: "PUT",
      host: `my-demo-site.${APP_DOMAIN}`,
      tls: "auto",
    });
  });

  it("serves a customer's own domain alongside the default, not instead of it", async () => {
    routeCalls.length = 0;
    const set = await rpc("PUT", `/apps/${SEED_ID}/domains`, { domains: ["custom.example.com"] });

    expect(set.status).toBe(200);
    expect(set.json.defaultHostname).toBe(`my-demo-site.${APP_DOMAIN}`);
    expect(routeCalls).toContainEqual(
      expect.objectContaining({ method: "PUT", host: "custom.example.com" }),
    );
    expect(routeCalls).toContainEqual(
      expect.objectContaining({ method: "PUT", host: `my-demo-site.${APP_DOMAIN}` }),
    );
  });

  it("keeps the default when a customer domain is removed", async () => {
    routeCalls.length = 0;
    const set = await rpc("PUT", `/apps/${SEED_ID}/domains`, { domains: [] });

    expect(set.status).toBe(200);
    expect(routeCalls).toContainEqual({ method: "DELETE", host: "custom.example.com" });
    expect(routeCalls).toContainEqual(
      expect.objectContaining({ method: "PUT", host: `my-demo-site.${APP_DOMAIN}` }),
    );
    expect(
      routeCalls.some((c) => c.method === "DELETE" && c.host === `my-demo-site.${APP_DOMAIN}`),
    ).toBe(false);
  });
});
