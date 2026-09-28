/**
 * The runtime's last-mile publishing, against the real servers.
 *
 * The runtime binds each app to a loopback port and tells the router which
 * public hostname maps to it. Two properties matter and neither is visible from
 * the adapter contract alone:
 *
 *   * a hostname the app drops must stop being served — the router is told to
 *     DELETE it, not merely left with the previous set; and
 *   * the runtime never claims a route is published when the router refused it.
 *
 * This starts the real `runtime-server.mjs` and a small recording router, so the
 * HTTP the runtime actually emits is what is asserted — not a stub of the
 * runtime itself.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(__dirname, "../../infra/deployment/runtime-server.mjs");
const RUNTIME_TOKEN = "runtime-router-test-token";
const ROUTER_TOKEN = "router-admin-token";
const RUNTIME_PORT = 18196;
const ROUTER_PORT = 18198;

let child: ChildProcess;
let router: Server;
let dataDir = "";

interface RouteCall {
  method: string;
  host: string;
  upstream?: string;
  tls?: string;
}
const routeCalls: RouteCall[] = [];
let routerRefuses = false;

/** An app the runtime already knows, with a loopback port a deploy would have set. */
const SEED_ID = "seed-app-1";
const SEED_PORT = 18300;

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
  // A minimal router: records what it is told, refuses when asked to.
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
          upstream: body.upstream === undefined ? undefined : String(body.upstream),
          tls: body.tls === undefined ? undefined : String(body.tls),
        });
        if (routerRefuses) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "refused" }));
          return;
        }
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

  dataDir = await mkdtemp(join(tmpdir(), "cw-runtime-router-"));
  // Seed one app with a loopback host port a real deploy would have assigned,
  // so the route publish/withdraw path runs without Docker.
  await writeFile(
    join(dataDir, "apps.json"),
    JSON.stringify({
      apps: {
        [SEED_ID]: {
          id: SEED_ID,
          name: "seed",
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

describe("the runtime publishes and withdraws routes at the router", () => {
  it("publishes each hostname to the router with automatic TLS", async () => {
    routeCalls.length = 0;
    const set = await rpc("PUT", `/apps/${SEED_ID}/domains`, { domains: ["app.example.com"] });
    expect(set.status).toBe(200);
    expect(set.json.routeError).toBeNull();
    expect(routeCalls).toHaveLength(1);
    expect(routeCalls[0]?.method).toBe("PUT");
    expect(routeCalls[0]?.host).toBe("app.example.com");
    expect(routeCalls[0]?.upstream).toBe(`http://127.0.0.1:${SEED_PORT}`);
    expect(routeCalls[0]?.tls).toBe("auto");
  });

  it("withdraws a hostname the app drops, and keeps the ones it retains", async () => {
    routeCalls.length = 0;
    await rpc("PUT", `/apps/${SEED_ID}/domains`, {
      domains: ["keep.example.com", "gone.example.com"],
    });
    routeCalls.length = 0;

    const set = await rpc("PUT", `/apps/${SEED_ID}/domains`, { domains: ["keep.example.com"] });

    expect(set.status).toBe(200);
    // The dropped hostname is DELETEd; the retained one is re-PUT. A release
    // that only forgot the name locally would leave the router answering it.
    expect(routeCalls).toContainEqual({ method: "DELETE", host: "gone.example.com" });
    expect(routeCalls).toContainEqual(
      expect.objectContaining({ method: "PUT", host: "keep.example.com" }),
    );
    expect(routeCalls.some((c) => c.method === "PUT" && c.host === "gone.example.com")).toBe(false);
  });

  it("reports not-published when the router refuses, never a false success", async () => {
    routerRefuses = true;
    try {
      const set = await rpc("PUT", `/apps/${SEED_ID}/domains`, {
        domains: ["refused.example.com"],
      });
      expect(set.status).toBe(200);
      expect(String(set.json.routeError)).toMatch(/refused/i);
    } finally {
      routerRefuses = false;
    }
  });
});
