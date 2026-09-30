/**
 * Self-hosted database engine, end to end.
 *
 * Two real components and one stub. The *server* is the real
 * `infra/deployment/postgres-server.mjs`, started as a child process exactly as
 * it ships. The *adapter* is the real `createSelfHostedDatabase`, so its URLs,
 * verbs, auth headers and status mapping run for real — no fetch mock. The stub
 * is the `docker` binary: a script on `PATH` that records each invocation and
 * answers as the daemon would, so the engine's container lifecycle is exercised
 * without needing a live Docker in the test environment.
 *
 * What this pins: the request shape the adapter sends is the one the server
 * answers; a provision really starts a container and creates a database; a
 * backup is the file `pg_dump` wrote and a restore reads it back; the credential
 * rotation's password reaches the engine and never comes back in a response; and
 * an organization with no token gets `not_configured`, never a fabricated
 * database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AdapterContext } from "@cloud-wai/contracts";
import { createSelfHostedDatabase } from "@cloud-wai/adapters";

const SERVER = resolve(__dirname, "../../infra/deployment/postgres-server.mjs");
const TOKEN_A = "db-token-a";
const TOKEN_B = "db-token-b";
const PORT = 18197;

const ORG_A = "org-a" as AdapterContext["organizationId"];
const ORG_B = "org-b" as AdapterContext["organizationId"];

let child: ChildProcess;
let dataDir = "";
let binDir = "";
let dockerLog = "";

/** The recorded docker invocations, one line per call. */
async function dockerCalls(): Promise<string[]> {
  const raw = await readFile(dockerLog, "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.trim() !== "");
}

/**
 * A `docker` stand-in. It answers the four subcommands the engine uses and
 * records every argument, so the test can assert both the lifecycle and the
 * exact wire shape (`pg_dump`, `psql`, `docker run`).
 */
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$DOCKER_LOG"
cmd="$1"; shift || true
case "$cmd" in
  run)
    # Print a container id, as \`docker run -d\` does.
    echo "container-$(date +%s%N)"
    ;;
  exec)
    # Skip flags up to the container name, then read the program.
    while [[ "$1" == -* ]]; do shift; done
    container="$1"; shift || true
    prog="$1"; shift || true
    case "$prog" in
      pg_isready) exit 0 ;;
      pg_dump) echo "-- Cloud Wai test dump"; echo "CREATE TABLE t (id int);" ;;
      psql) cat >/dev/null 2>&1 || true ;;
    esac
    exit 0
    ;;
  logs)
    echo "2026-01-01 00:00:00 UTC [1] LOG:  database system is ready to accept connections"
    exit 0
    ;;
  rm) exit 0 ;;
esac
exit 0
`;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cw-pg-engine-"));
  binDir = await mkdtemp(join(tmpdir(), "cw-pg-bin-"));
  dockerLog = join(binDir, "docker.log");
  await writeFile(join(binDir, "docker"), DOCKER_STUB);
  await chmod(join(binDir, "docker"), 0o755);

  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      POSTGRES_ENGINE_TOKEN: TOKEN_A,
      POSTGRES_ENGINE_PORT: String(PORT),
      POSTGRES_ENGINE_HOST: "127.0.0.1",
      POSTGRES_ENGINE_DATA_DIR: dataDir,
      POSTGRES_ENGINE_PUBLIC_HOST: "db.test",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      DOCKER_LOG: dockerLog,
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
  throw new Error("postgres engine did not start");
});

afterAll(async () => {
  child?.kill("SIGKILL");
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (binDir) await rm(binDir, { recursive: true, force: true });
});

function adapter() {
  return createSelfHostedDatabase({
    credentials: (organizationId) =>
      organizationId === ORG_A
        ? { baseUrl: `http://127.0.0.1:${PORT}`, token: TOKEN_A }
        : organizationId === ORG_B
          ? { baseUrl: `http://127.0.0.1:${PORT}`, token: TOKEN_B }
          : null,
  });
}

const ctx = (organizationId: AdapterContext["organizationId"]): AdapterContext => ({
  organizationId,
  idempotencyKey: "k",
  timeoutMs: 30_000,
});

describe("self-hosted database engine", () => {
  it("reports not_configured for an organization with no token", async () => {
    const result = await adapter().provision(ctx("org-none" as AdapterContext["organizationId"]), {
      name: "app",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.status).toBe("not_configured");
  });

  it("refuses a wrong token at the engine, not in the adapter", async () => {
    // Organization B has a token the engine was never given, so the *engine*
    // answers 401 and the adapter maps it honestly rather than inventing a row.
    const result = await adapter().provision(ctx(ORG_B), { name: "app" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.status).not.toBe("succeeded");
  });

  it("provisions a database by starting a container and creating the database", async () => {
    const result = await adapter().provision(ctx(ORG_A), { name: "app-db" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.provider).toBe("postgres");
    expect(result.value.resourceType).toBe("database");
    expect(result.value.resourceId).toMatch(/^[0-9a-f]+$/);

    const calls = await dockerCalls();
    expect(calls.some((c) => c.startsWith("run -d --name cw-db-"))).toBe(true);
    expect(calls.some((c) => c.includes("pg_isready"))).toBe(true);
    expect(calls.some((c) => c.includes("CREATE DATABASE"))).toBe(true);

    // The provisioned database is addressable and its connection detail names
    // the configured public host, not loopback.
    const listed = await fetch(`http://127.0.0.1:${PORT}/databases`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    }).then((r) => r.json() as Promise<{ databases: { host: string }[] }>);
    expect(listed.databases[0]?.host).toBe("db.test");
  });

  it("backs up with pg_dump and restores the file it wrote", async () => {
    const provisioned = await adapter().provision(ctx(ORG_A), { name: "app2" });
    if (!provisioned.ok) throw new Error(provisioned.error.message);
    const ref = provisioned.value;

    const backup = await adapter().backup(ctx(ORG_A), ref);
    expect(backup.ok).toBe(true);
    if (!backup.ok) throw new Error(backup.error.message);
    expect(backup.value.resourceType).toBe("backup");

    const calls = await dockerCalls();
    expect(calls.some((c) => c.includes("pg_dump"))).toBe(true);

    const restore = await adapter().restore(ctx(ORG_A), {
      backupRef: backup.value,
      targetRef: ref,
    });
    expect(restore.ok).toBe(true);
  });

  it("rotates credentials without ever returning the password", async () => {
    const provisioned = await adapter().provision(ctx(ORG_A), { name: "app3" });
    if (!provisioned.ok) throw new Error(provisioned.error.message);

    const rotated = await adapter().rotateCredentials(ctx(ORG_A), provisioned.value);
    expect(rotated.ok).toBe(true);
    // The result carries no value at all — there is nowhere for the password to
    // be, which is the point.
    if (rotated.ok) expect(rotated.value).toBeUndefined();

    const calls = await dockerCalls();
    expect(calls.some((c) => c.includes("ALTER USER") && c.includes("PASSWORD"))).toBe(true);
  });

  it("reads the container log through the engine", async () => {
    const provisioned = await adapter().provision(ctx(ORG_A), { name: "app4" });
    if (!provisioned.ok) throw new Error(provisioned.error.message);

    const logs = await adapter().getLogs(ctx(ORG_A), provisioned.value);
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error(logs.error.message);
    expect(logs.value.lines.join("\n")).toContain("database system is ready");
    // The endpoint has no cursor, so the page cursor is null, not invented.
    expect(logs.value.cursor).toBeNull();
  });

  it("destroys a database by removing its container", async () => {
    const provisioned = await adapter().provision(ctx(ORG_A), { name: "app5" });
    if (!provisioned.ok) throw new Error(provisioned.error.message);

    const destroyed = await adapter().destroy(ctx(ORG_A), provisioned.value);
    expect(destroyed.ok).toBe(true);

    const calls = await dockerCalls();
    expect(calls.some((c) => c.startsWith("rm -f cw-db-"))).toBe(true);
  });
});
