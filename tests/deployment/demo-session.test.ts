/**
 * The server-side demo sign-in (the pre-launch bypass, H2).
 *
 * The property under test is the one the baked-credential bypass violated: the
 * demo password must never be reachable from the browser. These tests run the
 * real handler against a real local HTTP server that stands in for Supabase's
 * token endpoint, and drive the real API server for the routing behaviour.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { listen, type HttpServer, type RpcRequest, type RpcResponse } from "@cloud-wai/api";
import { buildDemoSessionHandler, demoSessionFromEnv } from "../../apps/api/src/demo-session.js";

const nodeServers: Server[] = [];
const httpServers: HttpServer[] = [];

afterEach(async () => {
  while (httpServers.length > 0) await httpServers.pop()!.close();
  while (nodeServers.length > 0) {
    await new Promise<void>((resolve) => nodeServers.pop()!.close(() => resolve()));
  }
});

/** A stand-in for Supabase's `POST /auth/v1/token?grant_type=password`. */
async function fakeAuth(
  handler: (body: unknown) => { status: number; body: unknown },
): Promise<string> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const outcome = handler(raw ? JSON.parse(raw) : {});
      res.writeHead(outcome.status, { "content-type": "application/json" });
      res.end(JSON.stringify(outcome.body));
    });
  });
  nodeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("demoSessionFromEnv", () => {
  it("is off unless explicitly enabled and fully configured", () => {
    expect(demoSessionFromEnv({})).toBeNull();
    expect(
      demoSessionFromEnv({
        DEMO_AUTOLOGIN: "0",
        SUPABASE_URL: "u",
        SUPABASE_ANON_KEY: "a",
        DEMO_EMAIL: "e",
        DEMO_PASSWORD: "p",
      }),
    ).toBeNull();
    // Enabled but missing the password: still off, never a half-configured grant.
    expect(
      demoSessionFromEnv({
        DEMO_AUTOLOGIN: "1",
        SUPABASE_URL: "u",
        SUPABASE_ANON_KEY: "a",
        DEMO_EMAIL: "e",
      }),
    ).toBeNull();
    expect(
      demoSessionFromEnv({
        DEMO_AUTOLOGIN: "1",
        SUPABASE_URL: "u",
        SUPABASE_ANON_KEY: "a",
        DEMO_EMAIL: "e",
        DEMO_PASSWORD: "p",
      }),
    ).toMatchObject({ url: "u", email: "e" });
  });
});

describe("the demo session handler", () => {
  it("exchanges the server-held credential for a session", async () => {
    const url = await fakeAuth(() => ({
      status: 200,
      body: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_at: 123,
        user: { email: "demo@cloudwai.local" },
      },
    }));
    const handler = buildDemoSessionHandler({
      url,
      anonKey: "anon",
      email: "demo@cloudwai.local",
      password: "server-only",
      maxPerWindow: 30,
      windowMs: 60_000,
    });

    const response = await handler.handle("client-1");
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      email: "demo@cloudwai.local",
    });
    // The password is never part of the response.
    expect(JSON.stringify(response)).not.toContain("server-only");
  });

  it("never forwards the identity service's own error body", async () => {
    const url = await fakeAuth(() => ({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "password for demo@cloudwai.local is wrong",
      },
    }));
    const handler = buildDemoSessionHandler({
      url,
      anonKey: "anon",
      email: "demo@cloudwai.local",
      password: "server-only",
      maxPerWindow: 30,
      windowMs: 60_000,
    });

    const response = await handler.handle("client-2");
    expect(response.ok).toBe(false);
    expect(JSON.stringify(response)).not.toContain("demo@cloudwai.local");
    expect(JSON.stringify(response)).not.toContain("server-only");
  });

  it("rate-limits a client after the configured window budget", async () => {
    const url = await fakeAuth(() => ({
      status: 200,
      body: { access_token: "a", refresh_token: "r" },
    }));
    const handler = buildDemoSessionHandler({
      url,
      anonKey: "anon",
      email: "e",
      password: "p",
      maxPerWindow: 2,
      windowMs: 60_000,
    });

    expect((await handler.handle("same")).ok).toBe(true);
    expect((await handler.handle("same")).ok).toBe(true);
    const limited = await handler.handle("same");
    expect(limited.ok).toBe(false);
    expect(limited.status).toBe(429);
    // A different client is unaffected by another's budget.
    expect((await handler.handle("other")).ok).toBe(true);
  });
});

describe("the API server's demo.session route", () => {
  async function start(
    route: (request: RpcRequest) => Promise<RpcResponse>,
    demoSession?: { handle: (key: string) => Promise<RpcResponse> },
  ): Promise<HttpServer> {
    const server = await listen(
      { route, ...(demoSession ? { demoSession } : {}), shutdownGraceMs: 50 },
      0,
      "127.0.0.1",
    );
    httpServers.push(server);
    return server;
  }

  it("404s when the deployment did not enable the bypass", async () => {
    let routed = false;
    const server = await start(async () => {
      routed = true;
      return { ok: true, status: 200, data: null };
    });

    const response = await fetch(`${server.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ procedure: "demo.session" }),
    });
    expect(response.status).toBe(404);
    // It must not fall through to the router, which would reject it as an
    // unknown procedure anyway — but only after a session check.
    expect(routed).toBe(false);
  });

  it("answers with the handler's session and never calls the router", async () => {
    let routed = false;
    let key: string | null = null;
    const server = await start(
      async () => {
        routed = true;
        return { ok: true, status: 200, data: null };
      },
      {
        handle: async (clientKey) => {
          key = clientKey;
          return { ok: true, status: 200, data: { accessToken: "a", refreshToken: "r" } };
        },
      },
    );

    const response = await fetch(`${server.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
      body: JSON.stringify({ procedure: "demo.session" }),
    });
    expect(response.status).toBe(200);
    expect(routed).toBe(false);
    // The rate-limit key is the forwarded client, not the proxy.
    expect(key).toBe("203.0.113.7");
  });
});
