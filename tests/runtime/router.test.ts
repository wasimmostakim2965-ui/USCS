/**
 * The router, against the real server.
 *
 * The router is the platform's own front door: it maps a Host header to a
 * loopback upstream and terminates TLS. These tests start the real
 * `router-server.mjs` as a child process and assert the properties that make it
 * safe to expose: a route can only be published with the admin token, an
 * upstream must be loopback (or a tenant could aim the router at any host), a
 * hostname must be a DNS name, and an unpublished host is refused rather than
 * forwarded.
 *
 * TLS is exercised with the self-signed fallback, so no certificate authority
 * and no network are involved. ACME itself is disabled here (`ROUTER_ACME_ENABLED
 * =false`); issuance is an external, credentialed flow, and its absence must not
 * change the routing behaviour under test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpsRequest } from "node:https";

const ROUTER = resolve(__dirname, "../../infra/deployment/router-server.mjs");
const TOKEN = "router-test-token";
const HTTP_PORT = 18081;
const HTTPS_PORT = 18444;
const ADMIN_PORT = 18097;
const APP_PORT = 18778;

let child: ChildProcess;
let app: Server;
let dataDir = "";

const admin = (method: string, path: string, body?: unknown, auth = `Bearer ${TOKEN}`) =>
  fetch(`http://127.0.0.1:${ADMIN_PORT}${path}`, {
    method,
    headers: { authorization: auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** One HTTPS request with an explicit SNI and Host, ignoring the self-signed CA. */
function httpsGet(servername: string, path = "/") {
  return new Promise<{ status: number; body: string }>((resolveResult, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port: HTTPS_PORT,
        servername,
        path,
        headers: { host: servername },
        rejectUnauthorized: false,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolveResult({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cw-router-"));
  app = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello-from-app");
  });
  await new Promise<void>((r) => app.listen(APP_PORT, "127.0.0.1", r));

  child = spawn(process.execPath, [ROUTER], {
    env: {
      ...process.env,
      ROUTER_TOKEN: TOKEN,
      ROUTER_DATA_DIR: dataDir,
      ROUTER_ACME_ENABLED: "false",
      ROUTER_HTTP_PORT: String(HTTP_PORT),
      ROUTER_HTTPS_PORT: String(HTTPS_PORT),
      ROUTER_ADMIN_PORT: String(ADMIN_PORT),
      ROUTER_DEFAULT_UPSTREAM: "",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("router did not start");
});

afterAll(async () => {
  child?.kill("SIGKILL");
  app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("router", () => {
  it("requires the admin token to publish a route", async () => {
    const res = await admin(
      "PUT",
      "/routes",
      { host: "app.test.dev", upstream: `http://127.0.0.1:${APP_PORT}` },
      "",
    );
    expect(res.status).toBe(401);
  });

  it("refuses an upstream that is not loopback", async () => {
    const res = await admin("PUT", "/routes", {
      host: "app.test.dev",
      upstream: "http://evil.example.com:80",
    });
    expect(res.status).toBe(400);
  });

  it("refuses a host that is not a DNS name", async () => {
    const res = await admin("PUT", "/routes", {
      host: "bad_host",
      upstream: `http://127.0.0.1:${APP_PORT}`,
    });
    expect(res.status).toBe(400);
  });

  it("refuses an unpublished host rather than forwarding it", async () => {
    const out = await httpsGet("nobody.test.dev");
    expect(out.status).toBe(404);
  });

  it("serves a published host over TLS, terminating at the router", async () => {
    const put = await admin("PUT", "/routes", {
      host: "app.test.dev",
      upstream: `http://127.0.0.1:${APP_PORT}`,
      tls: "none",
    });
    expect([200, 202]).toContain(put.status);
    const out = await httpsGet("app.test.dev");
    expect(out.status).toBe(200);
    expect(out.body).toBe("hello-from-app");
  });

  it("redirects plain HTTP to HTTPS", async () => {
    const res = await new Promise<{ code: number; location?: string }>((res, rej) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: HTTP_PORT, path: "/path", headers: { host: "app.test.dev" } },
        (r) => res({ code: r.statusCode ?? 0, location: r.headers.location }),
      );
      req.on("error", rej);
      req.end();
    });
    expect(res.code).toBe(301);
    expect(res.location).toBe("https://app.test.dev/path");
  });

  it("answers an unknown ACME challenge with 404", async () => {
    const res = await new Promise<number>((res, rej) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: HTTP_PORT, path: "/.well-known/acme-challenge/missing" },
        (r) => res(r.statusCode ?? 0),
      );
      req.on("error", rej);
      req.end();
    });
    expect(res).toBe(404);
  });

  it("withdraws a route so the host stops being served", async () => {
    await admin("DELETE", "/routes/app.test.dev");
    const out = await httpsGet("app.test.dev");
    expect(out.status).toBe(404);
  });
});
