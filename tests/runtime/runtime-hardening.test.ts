/**
 * The self-hosted runtime's request hardening, against the real server.
 *
 * `runtime-server.mjs` forwards a tenant's inputs into `docker run` and `git
 * checkout`, so a value that is read as an option — an env key like
 * `--privileged`, a repository beginning with `-`, a ref like `-u` — would let a
 * tenant reach the daemon through a field it is allowed to set. The server
 * refuses those before it runs anything.
 *
 * This starts the real server as a child process (the code path that ships), not
 * a stub, and asserts the refusal. No Docker is needed: the rejected requests
 * stop at validation, and the accepted one only records state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(__dirname, "../../infra/deployment/runtime-server.mjs");
const TOKEN = "hardening-test-token";
const PORT = 18195;

let child: ChildProcess;
let dataDir = "";

async function rpc(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cw-runtime-"));
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      RUNTIME_TOKEN: TOKEN,
      RUNTIME_PORT: String(PORT),
      RUNTIME_HOST: "127.0.0.1",
      RUNTIME_DATA_DIR: dataDir,
      BUILDER_URL: "",
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
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
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("runtime request hardening", () => {
  it("requires the bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/apps`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("refuses a repository that would be read as a git option", async () => {
    const res = await rpc("POST", "/apps", { name: "x", gitRepository: "-oProxyCommand=x" });
    expect(res.status).toBe(400);
  });

  it("refuses a git ref that would be read as an option", async () => {
    const res = await rpc("POST", "/apps", {
      name: "x",
      gitRepository: "https://example.test/repo.git",
      gitBranch: "-u",
    });
    expect(res.status).toBe(400);
  });

  it("refuses an image that would be read as a docker option", async () => {
    const res = await rpc("POST", "/apps", { name: "x", image: "--privileged" });
    expect(res.status).toBe(400);
  });

  it("refuses a port outside the bindable range", async () => {
    const res = await rpc("POST", "/apps", { name: "x", port: 0 });
    expect(res.status).toBe(400);
  });

  it("accepts a valid git source", async () => {
    const created = await rpc("POST", "/apps", {
      name: "web",
      gitRepository: "https://example.test/repo.git",
    });
    expect(created.status).toBe(201);
    expect(typeof created.json.id).toBe("string");
  });

  it("refuses an env key that would be read as a docker flag", async () => {
    const created = await rpc("POST", "/apps", {
      name: "web2",
      gitRepository: "https://example.test/repo.git",
    });
    const id = created.json.id as string;
    const bad = await rpc("POST", `/apps/${id}/env`, { key: "--privileged", value: "true" });
    expect(bad.status).toBe(400);
    const good = await rpc("POST", `/apps/${id}/env`, {
      key: "DATABASE_URL",
      value: "postgres://x",
    });
    expect(good.status).toBe(201);
    // The value is never returned in the clear.
    expect(good.json.value).toBe("********");
  });

  it("accepts only DNS-shaped app domains", async () => {
    const created = await rpc("POST", "/apps", {
      name: "web3",
      gitRepository: "https://example.test/repo.git",
      domains: ["app.example.com", "-bad", "not a host", "UPPER.example.com"],
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const got = await rpc("GET", `/apps/${id}`);
    expect(got.status).toBe(200);
    expect(got.json.domains).toEqual(["app.example.com"]);
  });

  it("reports a route error honestly when no router is configured", async () => {
    const created = await rpc("POST", "/apps", {
      name: "web4",
      gitRepository: "https://example.test/repo.git",
      domains: ["app.example.com"],
    });
    const id = created.json.id as string;
    const set = await rpc("PUT", `/apps/${id}/domains`, { domains: ["app.example.com"] });
    expect(set.status).toBe(200);
    // No ROUTER_URL in this deployment: the hostname is not claimed reachable.
    expect(set.json.routeError).toMatch(/no router is configured/);
  });

  it("streams the app log as server-sent events", async () => {
    const created = await rpc("POST", "/apps", {
      name: "web5",
      gitRepository: "https://example.test/repo.git",
    });
    const id = created.json.id as string;
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${PORT}/apps/${id}/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("event: open");
    controller.abort();
  });
});
