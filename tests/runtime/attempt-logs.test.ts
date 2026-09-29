/**
 * A deployment handle addresses a build log, against the real runtime server.
 *
 * The control plane records an engine's *deployment* handle (the attempt id) and
 * falls back to the application id only when it has none. A customer opening a
 * settled build's logs therefore asks the runtime for the log of a deployment,
 * not of an application. Before this route existed, that read answered 404, and
 * the dashboard showed "Deployment logs — not configured" for a deployment the
 * engine had actually built — the app-level log is a tail and by then held the
 * running container's output, not the build's.
 *
 * This starts the real `runtime-server.mjs` and seeds one settled attempt with a
 * recorded build log, then asserts that:
 *
 *   * `GET /deployments/:attemptId/logs` answers that attempt's build log;
 *   * the same id through the application path (`/apps/:attemptId/logs`) answers
 *     the same buffer, because the adapter's ref for a deployment build is the
 *     attempt id; and
 *   * an unknown id stays a 404, so the fallback is not a blanket.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER = resolve(__dirname, "../../infra/deployment/runtime-server.mjs");
const TOKEN = "runtime-attempt-log-token";
const PORT = 18197;
const APP_ID = "attempt-log-app";
const ATTEMPT_ID = "attemptbuildlog0001";
const BUILD_LINES = ["cloning https://example.test/repo.git", "nixpacks build -> ok"];

let child: ChildProcess;
let dataDir = "";

async function rpc(
  method: string,
  path: string,
): Promise<{ status: number; json: { logs?: readonly string[]; nextCursor?: string } }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  });
  return { status: res.status, json: (await res.json()) as never };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cw-runtime-attempt-"));
  // Seed the state file exactly as a completed deploy would have left it: the
  // attempt is recorded under its own id, and its build lines live in the
  // per-attempt buffer the server writes as it logs.
  await writeFile(
    join(dataDir, "apps.json"),
    JSON.stringify({
      apps: {
        [APP_ID]: {
          id: APP_ID,
          name: "attempt-log",
          gitRepository: "https://example.test/repo.git",
          gitBranch: "main",
          port: 3000,
          env: {},
          domains: [],
          status: "succeeded",
          url: "http://127.0.0.1:18399",
          hostPort: 18399,
          container: "cw-app-attempt-log",
          deployCount: 1,
          deployAttemptId: ATTEMPT_ID,
          logs: [],
          attemptLogs: { [ATTEMPT_ID]: BUILD_LINES },
          attempts: { [ATTEMPT_ID]: { status: "succeeded", url: null, engineReason: null } },
        },
      },
    }),
  );
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      RUNTIME_TOKEN: TOKEN,
      RUNTIME_PORT: String(PORT),
      RUNTIME_HOST: "127.0.0.1",
      RUNTIME_DATA_DIR: dataDir,
      BUILDER_URL: "",
      ROUTER_URL: "",
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

describe("the runtime's deployment-handle log route", () => {
  it("answers a deployment's build log by its attempt id", async () => {
    const res = await rpc("GET", `/deployments/${ATTEMPT_ID}/logs`);
    expect(res.status).toBe(200);
    expect(res.json.logs).toEqual(BUILD_LINES);
  });

  it("answers the same log when the attempt id arrives on the application path", async () => {
    const res = await rpc("GET", `/apps/${ATTEMPT_ID}/logs`);
    expect(res.status).toBe(200);
    expect(res.json.logs).toEqual(BUILD_LINES);
  });

  it("stays a 404 for an id that is neither an app nor an attempt", async () => {
    const res = await rpc("GET", "/apps/not-a-real-id/logs");
    expect(res.status).toBe(404);
  });
});
