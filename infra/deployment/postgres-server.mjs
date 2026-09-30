/**
 * Cloud Wai database engine — the Postgres this deployment owns.
 *
 * The hosting adapter has `runtime-server.mjs`; the database adapter had only
 * Coolify, so a host that owns its runtime honestly reported `postgres:
 * not_configured` and the Database section could not provision anything. This is
 * the missing engine: it provisions, backs up, restores, rotates credentials and
 * reports the log of a tenant database by driving the Docker daemon, exactly the
 * way the runtime drives containers for hosting.
 *
 * It is one process per host, holding no Cloud Wai credentials and speaking only
 * to Docker. It is the second engine (after the runtime) that may touch the
 * daemon, and it is loopback-only in the compose file for the same reason.
 *
 *   POSTGRES_ENGINE_PORT=8097 POSTGRES_ENGINE_TOKEN=... node postgres-server.mjs
 *
 * Contract (all JSON; `Authorization: Bearer <token>` on every route):
 *   GET    /healthz
 *   POST   /databases                                  { name }            -> 201 { id }
 *   GET    /databases                                                      -> 200 { databases: [...] }
 *   GET    /databases/:id                                                  -> 200 { id, ... }
 *   DELETE /databases/:id                                                  -> 200 {}
 *   PATCH  /databases/:id                              { postgres_password } -> 200 {}
 *   POST   /databases/:id/backups                                          -> 202 { uuid, filename }
 *   GET    /databases/:id/backups                                          -> 200 { backups: [...] }
 *   GET    /databases/:id/backups/:backupId/executions                     -> 200 { executions: [...] }
 *   POST   /databases/:id/imports                      { path }            -> 202 {}
 *   GET    /databases/:id/logs?lines=N                                     -> 200 { logs }
 *
 * Honesty: every response is the engine's own answer. A backup reports the file
 * `pg_dump` actually wrote; a restore reports the code `psql` actually returned.
 * Nothing here reports success for work it did not perform.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PORT = Number(process.env.POSTGRES_ENGINE_PORT ?? 8097);
const HOST = process.env.POSTGRES_ENGINE_HOST ?? "0.0.0.0";
const TOKEN = process.env.POSTGRES_ENGINE_TOKEN ?? "";
const DATA_DIR = resolve(
  process.env.POSTGRES_ENGINE_DATA_DIR ?? join(process.cwd(), ".deploy", "postgres-engine"),
);
const STATE_FILE = join(DATA_DIR, "databases.json");
const BACKUP_DIR = join(DATA_DIR, "backups");
const IMAGE = process.env.POSTGRES_ENGINE_IMAGE ?? "public.ecr.aws/supabase/postgres:17.6.1.171";
const CONTAINER_PREFIX = process.env.POSTGRES_ENGINE_CONTAINER_PREFIX ?? "cw-db";
const DEFAULT_PORT = Number(process.env.POSTGRES_ENGINE_DB_PORT ?? 5432);
const PORT_BASE = Number(process.env.POSTGRES_ENGINE_PORT_BASE ?? 18500);
const PORT_RANGE = Number(process.env.POSTGRES_ENGINE_PORT_RANGE ?? 400);
const PUBLIC_HOST = process.env.POSTGRES_ENGINE_PUBLIC_HOST ?? "127.0.0.1";
const SUPERUSER = process.env.POSTGRES_ENGINE_SUPERUSER ?? "postgres";
const DEFAULT_DATABASE = process.env.POSTGRES_ENGINE_DEFAULT_DATABASE ?? "postgres";
const LOG_TAIL = Number(process.env.POSTGRES_ENGINE_LOG_TAIL ?? 200);
const START_TIMEOUT_MS = Number(process.env.POSTGRES_ENGINE_START_TIMEOUT_MS ?? 120_000);

let state = { databases: {} };

/* ---------------------------------------------------------------- state --- */

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(BACKUP_DIR, { recursive: true });
  // Sweep temp files an interrupted save left behind, the same way the runtime
  // does — a long-lived volume must not accumulate one per write.
  const dir = await readdir(DATA_DIR).catch(() => []);
  const prefix = `${STATE_FILE.split("/").pop()}.`;
  await Promise.all(
    dir
      .filter((name) => name.startsWith(prefix))
      .map((name) => rm(join(DATA_DIR, name), { force: true }).catch(() => {})),
  );
  if (!existsSync(STATE_FILE)) return;
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
    if (!state || typeof state !== "object" || typeof state.databases !== "object") {
      state = { databases: {} };
    }
  } catch {
    state = { databases: {} };
  }
}

async function saveState() {
  const tmp = `${STATE_FILE}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  try {
    await rename(tmp, STATE_FILE);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

/* ------------------------------------------------------------- helpers --- */

function send(res, code, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolveBody) => {
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) tooBig = true;
    });
    req.on("end", () => {
      if (tooBig) return resolveBody(null);
      if (data.trim() === "") return resolveBody({});
      try {
        resolveBody(JSON.parse(data));
      } catch {
        resolveBody(null);
      }
    });
    req.on("error", () => resolveBody(null));
  });
}

/** Run a command, collecting stdout+stderr. Never throws; a failure is a code. */
function run(cmd, args, { timeoutMs = 120_000, stdin = null } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun(result);
    };
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (out += b.toString()));
    child.on("error", (e) => finish({ code: 127, out: `${out}${String(e)}` }));
    child.on("close", (code) => finish({ code: code ?? 1, out }));
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
    if (timeoutMs) {
      timer = setTimeout(() => {
        timer = undefined;
        try {
          child.kill("SIGKILL");
        } catch {
          // gone
        }
        finish({ code: 124, out: `${out}\n[postgres-engine] command timed out` });
      }, timeoutMs);
    }
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A name is a single DNS label; anything else would be read as an option. */
function isName(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

/** A password the SQL grammar accepts, generated here and never returned. */
function generatePassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(24);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `cw${out}`;
}

/** An SQL identifier quoted safely: only the double quote needs escaping. */
function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** A single-quoted SQL string literal, escaped. */
function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** A free host port for a database, skewed per id so a restart keeps it. */
function allocatePort(id) {
  const used = new Set(Object.values(state.databases).map((db) => db.port));
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  for (let i = 0; i < PORT_RANGE; i++) {
    const port = PORT_BASE + ((hash + i) % PORT_RANGE);
    if (!used.has(port)) return port;
  }
  throw new Error("no free database port");
}

const containerFor = (id) => `${CONTAINER_PREFIX}-${id}`;

/** Run SQL as the superuser inside the database's own container. */
async function sql(db, statement, { database = db.database } = {}) {
  return run(
    "docker",
    ["exec", db.container, "psql", "-v", "ON_ERROR_STOP=1", "-U", SUPERUSER, "-d", database, "-c", statement],
    { timeoutMs: 60_000 },
  );
}

/** Wait until the container answers `pg_isready`, then return its own status. */
async function waitReady(db, deadline) {
  while (Date.now() < deadline) {
    const ready = await run("docker", ["exec", db.container, "pg_isready", "-U", SUPERUSER], {
      timeoutMs: 10_000,
    });
    if (ready.code === 0) return true;
    await sleep(1000);
  }
  return false;
}

/* ------------------------------------------------------------ lifecycle --- */

async function createDatabase(name) {
  const id = randomBytes(10).toString("hex");
  const container = containerFor(id);
  const port = allocatePort(id);
  const password = generatePassword();
  const database = name.replace(/-/g, "_");

  const started = await run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      `POSTGRES_DB=${DEFAULT_DATABASE}`,
      "-p",
      `127.0.0.1:${port}:${DEFAULT_PORT}`,
      IMAGE,
    ],
    { timeoutMs: 60_000 },
  );
  if (started.code !== 0) {
    await run("docker", ["rm", "-f", container], { timeoutMs: 30_000 });
    return { ok: false, reason: `the database container did not start: ${started.out.trim()}` };
  }

  const db = {
    id,
    name,
    container,
    port,
    host: PUBLIC_HOST,
    database,
    user: SUPERUSER,
    password,
    image: IMAGE,
    createdAt: new Date().toISOString(),
  };
  state.databases[id] = db;
  await saveState();

  const ready = await waitReady(db, Date.now() + START_TIMEOUT_MS);
  if (!ready) {
    return { ok: false, reason: "the database container did not become ready in time", db };
  }
  // A database of its own, so the tenant's data is separate from the default.
  const created = await sql(db, `CREATE DATABASE ${quoteIdent(database)};`, {
    database: DEFAULT_DATABASE,
  });
  if (created.code !== 0) {
    return { ok: false, reason: `the database was not created: ${created.out.trim()}`, db };
  }
  return { ok: true, db };
}

async function destroyDatabase(id) {
  const db = state.databases[id];
  if (!db) return { ok: false, code: 404, reason: "no such database" };
  await run("docker", ["rm", "-f", db.container], { timeoutMs: 60_000 });
  delete state.databases[id];
  await saveState();
  return { ok: true };
}

async function backupDatabase(id) {
  const db = state.databases[id];
  if (!db) return { ok: false, code: 404, reason: "no such database" };
  const uuid = randomBytes(8).toString("hex");
  const filename = `${db.database}-${uuid}.sql`;
  const path = join(BACKUP_DIR, filename);
  // pg_dump writes the file *inside* the container; stream it to this host so
  // the backup lives with the engine, not in the tenant's container.
  const dump = await run(
    "docker",
    ["exec", db.container, "pg_dump", "-U", SUPERUSER, "-d", db.database],
    { timeoutMs: 300_000 },
  );
  if (dump.code !== 0) {
    return { ok: false, code: 500, reason: `the backup failed: ${dump.out.trim()}` };
  }
  await writeFile(path, dump.out);
  const executions = (db.backups ??= []);
  executions.unshift({
    uuid,
    filename,
    path,
    status: "successful",
    createdAt: new Date().toISOString(),
  });
  await saveState();
  return { ok: true, uuid, filename };
}

async function restoreDatabase(id, sourcePath) {
  const db = state.databases[id];
  if (!db) return { ok: false, code: 404, reason: "no such database" };
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    return { ok: false, code: 400, reason: "an import needs a path" };
  }
  // The path names one of this engine's own backups, by *filename* only. It must
  // be a single component: a path with a separator (or `..`) could name any file
  // on the host, which is not a file the control plane is allowed to choose. The
  // engine therefore joins a bare name onto its own backup directory and nothing
  // else — a caller cannot point a restore at an arbitrary file.
  const filename = sourcePath.trim();
  if (filename.includes("/") || filename.includes("\\") || filename === "..") {
    return { ok: false, code: 400, reason: "the import path must be a backup filename" };
  }
  const resolvedPath = join(BACKUP_DIR, filename);
  if (!existsSync(resolvedPath)) {
    return { ok: false, code: 404, reason: "no such backup file" };
  }
  const sqlText = await readFile(resolvedPath, "utf8");
  const restored = await run(
    "docker",
    ["exec", "-i", db.container, "psql", "-v", "ON_ERROR_STOP=1", "-U", SUPERUSER, "-d", db.database],
    { timeoutMs: 300_000, stdin: sqlText },
  );
  if (restored.code !== 0) {
    return { ok: false, code: 500, reason: `the restore failed: ${restored.out.trim()}` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ HTTP --- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://engine");
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/healthz") {
    return send(res, 200, { ok: true, engine: "postgres", image: IMAGE });
  }
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { message: "Unauthorized" });
  }

  const body = ["POST", "PATCH", "PUT"].includes(req.method ?? "") ? await readBody(req) : null;
  if (body === null && ["POST", "PATCH", "PUT"].includes(req.method ?? "")) {
    return send(res, 400, { message: "A JSON body is required." });
  }

  try {
    if (parts[0] !== "databases") return send(res, 404, { message: "Not found." });

    if (parts.length === 1) {
      if (req.method === "GET") {
        return send(res, 200, {
          databases: Object.values(state.databases).map(publicDatabase),
        });
      }
      if (req.method === "POST") {
        if (!isName(body?.name)) {
          return send(res, 400, { message: "A database name must be a lowercase DNS label." });
        }
        const created = await createDatabase(body.name);
        if (!created.ok) {
          return send(res, 500, { message: created.reason, id: created.db?.id ?? null });
        }
        return send(res, 201, { id: created.db.id });
      }
      return send(res, 405, { message: "Method not allowed." });
    }

    const id = parts[1];
    const db = state.databases[id];
    if (!db) return send(res, 404, { message: "Not found." });

    if (parts.length === 2) {
      if (req.method === "GET") return send(res, 200, publicDatabase(db));
      if (req.method === "DELETE") {
        const out = await destroyDatabase(id);
        return send(res, out.ok ? 200 : out.code ?? 500, out.ok ? {} : { message: out.reason });
      }
      if (req.method === "PATCH") {
        const password = body?.postgres_password;
        if (typeof password !== "string" || password.length < 8) {
          return send(res, 400, { message: "postgres_password is required." });
        }
        const rotated = await sql(
          db,
          `ALTER USER ${quoteIdent(SUPERUSER)} WITH PASSWORD ${quoteLiteral(password)};`,
          { database: DEFAULT_DATABASE },
        );
        if (rotated.code !== 0) {
          return send(res, 500, { message: `the credential rotation failed: ${rotated.out.trim()}` });
        }
        db.password = password;
        await saveState();
        return send(res, 200, {});
      }
      return send(res, 405, { message: "Method not allowed." });
    }

    // /databases/:id/backups  and  /databases/:id/backups/:backupId/executions
    if (parts[2] === "backups") {
      if (parts.length === 3 && req.method === "POST") {
        const out = await backupDatabase(id);
        if (!out.ok) return send(res, out.code ?? 500, { message: out.reason });
        return send(res, 202, { uuid: out.uuid, filename: out.filename });
      }
      if (parts.length === 3 && req.method === "GET") {
        return send(res, 200, { backups: db.backups ?? [] });
      }
      if (parts.length === 5 && parts[4] === "executions" && req.method === "GET") {
        const config = parts[3];
        const executions = (db.backups ?? []).filter((b) => b.uuid === config);
        return send(res, 200, { executions });
      }
      return send(res, 404, { message: "Not found." });
    }

    if (parts[2] === "imports" && parts.length === 3 && req.method === "POST") {
      const out = await restoreDatabase(id, body?.path);
      if (!out.ok) return send(res, out.code ?? 500, { message: out.reason });
      return send(res, 202, {});
    }

    if (parts[2] === "logs" && parts.length === 3 && req.method === "GET") {
      const lines = Math.min(Number(url.searchParams.get("lines") ?? 100) || 100, 2000);
      const logs = await run("docker", ["logs", "--tail", String(lines), db.container], {
        timeoutMs: 30_000,
      });
      return send(res, 200, { logs: logs.out });
    }

    return send(res, 404, { message: "Not found." });
  } catch (error) {
    return send(res, 500, { message: String(error) });
  }
});

/** The engine's view of a database. The password is never in a response. */
function publicDatabase(db) {
  return {
    id: db.id,
    name: db.name,
    container: db.container,
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    image: db.image,
    createdAt: db.createdAt,
  };
}

await loadState();
server.listen(PORT, HOST, () => {
  console.log(`Cloud Wai database engine listening on http://${HOST}:${PORT}`);
});
