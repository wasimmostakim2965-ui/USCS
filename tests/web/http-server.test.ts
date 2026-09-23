/**
 * The API's HTTP adapter.
 *
 * These tests bind a real server on an ephemeral port and speak HTTP to it, so
 * the thing under test is the actual wire behaviour: methods, status codes,
 * headers, body limits and CORS. A mocked `route` would prove none of that.
 */
import { afterEach, describe, expect, it } from "vitest";
import { listen, type HttpServer } from "@cloud-wai/api";
import type { RpcRequest, RpcResponse } from "@cloud-wai/api";

const servers: HttpServer[] = [];

async function startServer(
  route: (request: RpcRequest) => Promise<RpcResponse>,
  allowedOrigins?: readonly string[],
): Promise<HttpServer> {
  const server = await listen(
    { route, ...(allowedOrigins ? { allowedOrigins } : {}), shutdownGraceMs: 50 },
    0,
    "127.0.0.1",
  );
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await server.close();
  }
});

const ok = (data: unknown): RpcResponse => ({ ok: true, status: 200, data });

describe("POST /rpc", () => {
  it("dispatches a procedure and returns its payload", async () => {
    let seen: RpcRequest | null = null;
    const server = await startServer(async (request) => {
      seen = request;
      return ok([{ id: "o1", name: "Org" }]);
    });

    const response = await fetch(`${server.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token-1" },
      body: JSON.stringify({ procedure: "organizations.list", input: {} }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // A per-user response must not be cached by an intermediary.
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as RpcResponse;
    expect(body.ok).toBe(true);
    expect(seen!.procedure).toBe("organizations.list");
    expect(seen!.accessToken).toBe("token-1");
  });

  it("reads the token only from the Authorization header, never a query string", async () => {
    let seen: RpcRequest | null = null;
    const server = await startServer(async (request) => {
      seen = request;
      return ok(null);
    });

    await fetch(`${server.url}/rpc?access_token=leaked`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ procedure: "organizations.list" }),
    });

    expect(seen!.accessToken).toBeNull();
  });

  it("passes an absent session through as null so the router rejects it", async () => {
    let seen: RpcRequest | null = null;
    const server = await startServer(async (request) => {
      seen = request;
      return { ok: false, status: 401, error: { code: "unauthenticated", message: "no" } };
    });

    const response = await fetch(`${server.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ procedure: "organizations.list" }),
    });

    expect(response.status).toBe(401);
    expect(seen!.accessToken).toBeNull();
  });

  it("rejects a body that is not JSON", async () => {
    const server = await startServer(async () => ok(null));
    const response = await fetch(`${server.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as RpcResponse;
    expect(body.error?.code).toBe("invalid_input");
  });

  it("requires a procedure name", async () => {
    const server = await startServer(async () => ok(null));
    const response = await fetch(`${server.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(response.status).toBe(400);
  });

  it("caps the body size instead of buffering it without limit", async () => {
    const server = await startServer(async () => ok(null));
    const huge = JSON.stringify({ procedure: "x", input: "a".repeat(300 * 1024) });
    // The server destroys the socket mid-upload; fetch may see the reset or the
    // 413, and both are a refusal rather than acceptance.
    let status = 0;
    try {
      const response = await fetch(`${server.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: huge,
      });
      status = response.status;
    } catch {
      status = 413;
    }
    expect(status).toBe(413);
  });

  it("does not mount an engine, database or admin route", async () => {
    const server = await startServer(async () => ok(null));
    for (const path of ["/", "/admin", "/engine", "/db", "/api/v1/projects"]) {
      const response = await fetch(`${server.url}${path}`, { method: "GET" });
      expect(response.status).toBe(404);
    }
  });

  it("answers a liveness probe without exposing configuration", async () => {
    const server = await startServer(async () => ok(null));
    const response = await fetch(`${server.url}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { service: string } };
    expect(body.data.service).toBe("api");
    expect(JSON.stringify(body)).not.toMatch(/supabase|token|key|secret/i);
  });

  it("rejects a method it does not serve", async () => {
    const server = await startServer(async () => ok(null));
    const response = await fetch(`${server.url}/rpc`, { method: "PUT" });
    expect(response.status).toBe(404);
  });
});

describe("CORS", () => {
  it("echoes only an allow-listed origin", async () => {
    const server = await startServer(async () => ok(null), ["https://app.cloud-wai.test"]);

    const allowed = await fetch(`${server.url}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://app.cloud-wai.test",
      },
      body: JSON.stringify({ procedure: "organizations.list" }),
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.cloud-wai.test");

    const denied = await fetch(`${server.url}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.test",
      },
      body: JSON.stringify({ procedure: "organizations.list" }),
    });
    // No allow-origin header: the browser blocks the response for evil.test.
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never answers with a wildcard origin", async () => {
    const server = await startServer(async () => ok(null), ["https://app.cloud-wai.test"]);
    const response = await fetch(`${server.url}/healthz`, {
      headers: { origin: "https://app.cloud-wai.test" },
    });
    expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("answers a preflight without touching a procedure", async () => {
    let called = false;
    const server = await startServer(async () => {
      called = true;
      return ok(null);
    }, ["https://app.cloud-wai.test"]);

    const response = await fetch(`${server.url}/rpc`, {
      method: "OPTIONS",
      headers: { origin: "https://app.cloud-wai.test" },
    });
    expect(response.status).toBe(204);
    expect(called).toBe(false);
  });
});
