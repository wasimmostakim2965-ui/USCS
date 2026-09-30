/**
 * The edge must strip the WAF internal-allow marker from inbound traffic.
 *
 * The compiled WAF allow-step exempts a request that carries
 * `x-cloud-wai-internal: 1` from every deny rule. The header is a plain request
 * header, so anyone can send it; the only thing that makes the allow safe is
 * that the edge removes it at the listener that faces the internet. The
 * obligation was documented in a runbook and implemented nowhere in this
 * repository, so on this edge a client that sent the header was exempt from the
 * deny list.
 *
 * This test runs the real `edge-server.mjs` in front of a recording upstream and
 * asserts the upstream never sees the header — and that an unrelated header is
 * still forwarded, so the strip is a strip and not a blanket drop.
 */
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const edge = join(root, "infra", "deployment", "edge-server.mjs");

let upstream: Server | undefined;
let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
  upstream?.close();
  upstream = undefined;
});

/** An API stand-in that records the headers of the last proxied request. */
async function recordingUpstream(): Promise<{
  port: number;
  lastHeaders: () => Record<string, string | string[] | undefined>;
}> {
  let headers: Record<string, string | string[] | undefined> = {};
  const server = createServer((req, res) => {
    headers = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, lastHeaders: () => headers };
}

/** Start the real edge in front of the upstream, on an ephemeral port. */
async function startEdge(upstreamPort: number): Promise<number> {
  const webRoot = mkdtempSync(join(tmpdir(), "edge-web-"));
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>shell</title>");
  const port = await freePort();
  const proc = spawn(process.execPath, [edge], {
    env: {
      ...process.env,
      EDGE_PORT: String(port),
      EDGE_HOST: "127.0.0.1",
      API_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      WEB_ROOT: webRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  await waitForPort(port);
  return port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`edge did not start on :${port}`);
}

describe("the edge strips the internal-allow marker", () => {
  it("removes x-cloud-wai-internal before the API sees it", async () => {
    const api = await recordingUpstream();
    const port = await startEdge(api.port);
    await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloud-wai-internal": "1" },
      body: JSON.stringify({}),
    });
    expect(api.lastHeaders()["x-cloud-wai-internal"]).toBeUndefined();
  });

  it("forwards every other header untouched", async () => {
    const api = await recordingUpstream();
    const port = await startEdge(api.port);
    await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cw_live_test" },
      body: JSON.stringify({}),
    });
    expect(api.lastHeaders()["authorization"]).toBe("Bearer cw_live_test");
  });

  it("asserts x-forwarded-proto itself rather than trusting the client", async () => {
    const api = await recordingUpstream();
    const port = await startEdge(api.port);
    await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "http" },
      body: JSON.stringify({}),
    });
    expect(api.lastHeaders()["x-forwarded-proto"]).toBe("https");
  });
});
