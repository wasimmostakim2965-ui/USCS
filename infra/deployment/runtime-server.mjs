/**
 * Cloud Wai self-hosted runtime engine.
 *
 * This is the platform's own container runtime — the piece Vercel supplies with
 * its own infrastructure and that this deployment used to borrow from Coolify.
 * It implements the same HTTP contract the Coolify hosting adapter speaks
 * (`packages/adapters/src/selfhosted.ts`), so the control plane does not know
 * which engine is behind the port (ADR-0002).
 *
 * A deploy is the Vercel shape, assembled from parts this repo already runs:
 *
 *   1. the source is a git repository (or a pre-built image);
 *   2. the *build plane* (`builder-server.mjs`, nixpacks) turns the source into
 *      an image — the runtime drives it, it does not build itself;
 *   3. the image is run as a container on the host's Docker daemon, given the
 *      app's environment, and bound to a loopback port the edge can front.
 *
 * It holds no tenant secrets beyond an app's own environment variables, and it
 * makes no engine call it cannot see through: if the build fails, the deploy
 * fails with the builder's real log; if the container exits, the deploy reports
 * `failed`, not a fabricated success.
 *
 *   RUNTIME_TOKEN=... BUILDER_URL=http://127.0.0.1:8090 BUILDER_TOKEN=... \
 *     node infra/deployment/runtime-server.mjs      # listens on :8095
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

const PORT = Number(process.env.RUNTIME_PORT ?? 8095);
const HOST = process.env.RUNTIME_HOST ?? "0.0.0.0";
const TOKEN = process.env.RUNTIME_TOKEN ?? "";
const DATA_DIR = resolve(process.env.RUNTIME_DATA_DIR ?? join(process.cwd(), ".deploy", "runtime"));
const STATE_FILE = join(DATA_DIR, "apps.json");
const BUILDER_URL = (process.env.BUILDER_URL ?? "").replace(/\/+$/, "");
const BUILDER_TOKEN = process.env.BUILDER_TOKEN ?? "";
const PUBLIC_HOST = process.env.RUNTIME_PUBLIC_HOST ?? "127.0.0.1";
const CONTAINER_PREFIX = process.env.RUNTIME_CONTAINER_PREFIX ?? "cw-app";
const DEFAULT_PORT = Number(process.env.RUNTIME_APP_PORT ?? 3000);
const PORT_BASE = Number(process.env.RUNTIME_PORT_BASE ?? 18100);
const PORT_RANGE = Number(process.env.RUNTIME_PORT_RANGE ?? 400);
const BUILD_TIMEOUT_MS = Number(process.env.RUNTIME_BUILD_TIMEOUT_MS ?? 900000);
const BUILD_POLL_MS = Number(process.env.RUNTIME_BUILD_POLL_MS ?? 2500);
const LOG_TAIL = Number(process.env.RUNTIME_LOG_TAIL ?? 500);
const ROUTER_URL = (process.env.ROUTER_URL ?? "").replace(/\/+$/, "");
const ROUTER_TOKEN = process.env.ROUTER_TOKEN ?? "";

const routerConfigured = ROUTER_URL !== "" && ROUTER_TOKEN !== "";

if (TOKEN === "") {
  console.error("RUNTIME_TOKEN is required: an unauthenticated runtime is not a runtime.");
  process.exit(1);
}

/** True when a value would be read as an option by the command it is passed to. */
function isOptionLike(value) {
  return typeof value === "string" && value.startsWith("-");
}

/**
 * An environment variable name, which becomes `docker run -e KEY=VALUE`.
 *
 * The check is strict on purpose: a name like `--privileged` would turn the
 * `-e` argument into a Docker flag, so a tenant could reach the daemon through
 * a variable it is allowed to set. Only POSIX-shaped names pass.
 */
function isEnvKey(key) {
  return typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/**
 * A git source the build plane may clone.
 *
 * The runtime forwards this straight into `git clone`, so it accepts only
 * remote-transport schemes and rejects anything option-like: a repository
 * beginning with `-` would otherwise be read as a flag.
 */
function isGitRepository(url) {
  if (typeof url !== "string" || url === "" || isOptionLike(url) || /\s/.test(url)) return false;
  return /^(https?:\/\/|git:\/\/|ssh:\/\/|git@[^:]+:)/.test(url);
}

/** A git ref passed to `git checkout`; must not be read as an option. */
function isGitRef(ref) {
  return ref === undefined || ref === null
    ? true
    : typeof ref === "string" &&
        ref !== "" &&
        !isOptionLike(ref) &&
        !/\s/.test(ref) &&
        !ref.includes("..") &&
        !ref.includes("\0");
}

/** An image reference passed as the final `docker run` argument. */
function isImageRef(image) {
  if (typeof image !== "string" || image === "" || isOptionLike(image) || /\s/.test(image)) {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image);
}

/** The in-container port an app listens on, bound as `127.0.0.1:HOST:PORT`. */
function isPort(port) {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

/** All state in one file, written atomically. A lost runtime is a re-deploy. */
let state = { apps: {} };

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return;
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    state = { apps: {} };
  }
}

async function saveState() {
  const tmp = `${STATE_FILE}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

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
function run(cmd, args, { timeoutMs = 60_000, stdin = null } = {}) {
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
        finish({ code: 124, out: `${out}\n[runtime] command timed out` });
      }, timeoutMs);
    }
  });
}

/** A free host port for an app, skewed per app so restarts keep the number. */
function allocatePort(app) {
  const used = new Set(
    Object.values(state.apps)
      .filter((a) => a.id !== app.id && a.hostPort)
      .map((a) => a.hostPort),
  );
  for (let i = 0; i < PORT_RANGE; i += 1) {
    const candidate = PORT_BASE + (hash(app.id) % PORT_RANGE) + i;
    if (!used.has(candidate)) return candidate;
  }
  return PORT_BASE + PORT_RANGE + Math.floor(Math.random() * 1000);
}

function hash(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function appUrl(app) {
  return app.hostPort ? `http://${PUBLIC_HOST}:${app.hostPort}` : null;
}

/** A DNS name the router may be asked to serve an app on. */
function isHostname(host) {
  return (
    typeof host === "string" &&
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
  );
}

/**
 * Publish an app's route to the router, so its hostname reaches the container.
 *
 * The runtime already binds the app to a loopback port; the router is what turns
 * a public hostname into that port and terminates TLS for it. Publishing is
 * best-effort-but-reported: an app is still deployed when the router is
 * unconfigured, but the caller is told the hostname is not yet reachable rather
 * than being told a URL that does not resolve.
 */
async function publishAppRoutes(app) {
  if (!routerConfigured)
    return { published: false, reason: "no router is configured (ROUTER_URL)" };
  if (!app.hostPort) return { published: false, reason: "the app has no host port yet" };
  const hosts = (app.domains ?? []).filter(isHostname);
  if (hosts.length === 0) return { published: true, reason: null };
  const failures = [];
  for (const host of hosts) {
    const res = await fetchJson(`${ROUTER_URL}/routes`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ROUTER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        host,
        upstream: `http://127.0.0.1:${app.hostPort}`,
        tls: "auto",
      }),
    });
    if (!res.ok) failures.push(`${host}: ${res.reason ?? "refused"}`);
  }
  return failures.length > 0
    ? { published: false, reason: failures.join("; ") }
    : { published: true, reason: null };
}

/** Withdraw every route for an app, so a released hostname stops being served. */
async function withdrawAppRoutes(app) {
  if (!routerConfigured) return;
  for (const host of (app.domains ?? []).filter(isHostname)) {
    await fetchJson(`${ROUTER_URL}/routes/${encodeURIComponent(host)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ROUTER_TOKEN}` },
    });
  }
}

/** Live log subscribers per app id, for the SSE stream the dashboard reads. */
const logStreams = new Map();

function log(app, line) {
  app.logs.push(line);
  if (app.logs.length > 2000) app.logs.splice(0, app.logs.length - 2000);
  const listeners = logStreams.get(app.id);
  if (listeners) for (const fn of listeners) fn(line);
}

/** Poll the build plane until the job finishes; returns the image or an error. */
async function buildSource(app, source) {
  if (BUILDER_URL === "") return { error: "no build plane is configured (BUILDER_URL)" };
  const create = await fetchJson(`${BUILDER_URL}/builds`, {
    method: "POST",
    headers: { authorization: `Bearer ${BUILDER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ source, idempotencyKey: `${app.id}:${app.deployCount}` }),
  });
  if (!create.ok || !create.value?.id) {
    return { error: `build plane refused the job: ${create.reason ?? "no id"}` };
  }
  const jobId = create.value.id;
  log(app, `build job ${jobId} accepted`);
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  let cursor = "0";
  while (Date.now() < deadline) {
    await sleep(BUILD_POLL_MS);
    // Stream the build's new lines as they appear, so the dashboard shows the
    // build live rather than only when it finishes. A failed poll is ignored:
    // the next one retries, and the job's own status decides the outcome.
    const tail = await fetchJson(
      `${BUILDER_URL}/builds/${jobId}/logs?cursor=${encodeURIComponent(cursor)}`,
      { headers: { authorization: `Bearer ${BUILDER_TOKEN}` } },
    );
    if (tail.ok) {
      for (const line of tail.value?.logs ?? []) log(app, line);
      if (tail.value?.nextCursor) cursor = tail.value.nextCursor;
    }
    const job = await fetchJson(`${BUILDER_URL}/builds/${jobId}`, {
      headers: { authorization: `Bearer ${BUILDER_TOKEN}` },
    });
    if (!job.ok) continue;
    if (job.value?.status === "succeeded") {
      const image = job.value.artifact?.image;
      if (!image) return { error: "build reported success with no image" };
      return { image, logs: job.value.logs ?? [] };
    }
    if (job.value?.status === "failed") {
      return { error: "build failed", logs: job.value.logs ?? [] };
    }
  }
  return { error: "build timed out" };
}

async function fetchJson(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    return { ok: res.ok, value, reason: res.ok ? undefined : `${res.status}` };
  } catch (error) {
    return { ok: false, value: undefined, reason: String(error) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run an image as the app's container, replacing any previous one. */
async function runContainer(app, image) {
  const name = `${CONTAINER_PREFIX}-${app.id}`;
  await run("docker", ["rm", "-f", name], { timeoutMs: 60_000 });
  const args = ["run", "-d", "--name", name, "--restart", "unless-stopped"];
  const appPort = app.port ?? DEFAULT_PORT;
  args.push("-e", `PORT=${appPort}`);
  for (const [key, value] of Object.entries(app.env ?? {})) {
    if (!isEnvKey(key)) continue;
    args.push("-e", `${key}=${value}`);
  }
  app.hostPort = app.hostPort ?? allocatePort(app);
  args.push("-p", `127.0.0.1:${app.hostPort}:${appPort}`);
  args.push(image);
  const started = await run("docker", args, { timeoutMs: 120_000 });
  if (started.code !== 0) {
    return { error: `container did not start: ${started.out.trim().slice(-400)}` };
  }
  // Give it a moment, then check it did not exit immediately.
  await sleep(1500);
  const inspect = await run("docker", ["inspect", "-f", "{{.State.Running}}", name], {
    timeoutMs: 30_000,
  });
  const running = inspect.out.trim() === "true";
  return { container: name, running };
}

async function deploy(app) {
  app.deployCount = (app.deployCount ?? 0) + 1;
  app.status = "running";
  app.engineReason = null;
  const source = app.gitRepository
    ? {
        kind: "git",
        repository: app.gitRepository,
        ...(app.gitBranch ? { gitRef: app.gitBranch } : {}),
      }
    : app.image
      ? { kind: "image", uri: app.image }
      : null;
  if (!source) {
    app.status = "failed";
    app.engineReason = "app has neither a git repository nor an image";
    return;
  }
  if (source.kind === "git" && !isGitRepository(app.gitRepository)) {
    app.status = "failed";
    app.engineReason = "app has an invalid git repository";
    return;
  }
  if (source.kind === "image" && !isImageRef(app.image)) {
    app.status = "failed";
    app.engineReason = "app has an invalid image reference";
    return;
  }

  let image = app.image ?? null;
  if (source.kind === "git") {
    const built = await buildSource(app, source);
    for (const line of built.logs ?? []) log(app, line);
    if (built.error) {
      app.status = "failed";
      app.engineReason = built.error;
      await saveState();
      return;
    }
    image = built.image;
  }

  const previous = app.currentImage;
  const result = await runContainer(app, image);
  if (result.error) {
    app.status = "failed";
    app.engineReason = result.error;
    await saveState();
    return;
  }
  if (!result.running) {
    app.status = "failed";
    app.engineReason = "container started but is not running";
    await saveState();
    return;
  }
  app.currentImage = image;
  app.previousImage = previous ?? app.previousImage ?? null;
  app.container = result.container;
  app.status = "succeeded";
  app.url = appUrl(app);
  const route = await publishAppRoutes(app);
  app.routeError = route.published ? null : route.reason;
  log(app, `deployed ${image} on ${app.url}`);
  if (!route.published && route.reason) log(app, `[runtime] route not published: ${route.reason}`);
  await saveState();
}

async function containerLogs(app) {
  if (!app.container) return [];
  const tail = await run("docker", ["logs", "--tail", String(LOG_TAIL), app.container], {
    timeoutMs: 30_000,
  });
  return tail.out.split("\n").filter((l) => l !== "");
}

async function containerRunning(app) {
  if (!app.container) return false;
  const res = await run("docker", ["inspect", "-f", "{{.State.Running}}", app.container], {
    timeoutMs: 30_000,
  });
  return res.out.trim() === "true";
}

const ROUTES = {
  async createApp(body) {
    if (!body?.name) return { code: 400, body: { message: "name is required" } };
    if (body.gitRepository && !isGitRepository(body.gitRepository)) {
      return { code: 400, body: { message: "gitRepository must be a git URL." } };
    }
    if (!isGitRef(body.gitBranch)) {
      return { code: 400, body: { message: "gitBranch is not a valid ref." } };
    }
    if (body.image && !isImageRef(body.image)) {
      return { code: 400, body: { message: "image is not a valid image reference." } };
    }
    if (body.port !== undefined && !isPort(body.port)) {
      return { code: 400, body: { message: "port must be an integer in 1..65535." } };
    }
    const id = randomUUID().replace(/-/g, "").slice(0, 20);
    const app = {
      id,
      name: body.name,
      organizationId: body.organizationId ?? null,
      gitRepository: body.gitRepository ?? null,
      gitBranch: body.gitBranch ?? null,
      buildPack: body.buildPack ?? null,
      rootDirectory: body.rootDirectory ?? null,
      image: body.image ?? null,
      domains: Array.isArray(body.domains) ? body.domains.filter(isHostname) : [],
      port: body.port ?? DEFAULT_PORT,
      env: {},
      envRefs: {},
      hostPort: null,
      container: null,
      currentImage: null,
      previousImage: null,
      status: "pending",
      engineReason: null,
      routeError: null,
      url: null,
      deployCount: 0,
      logs: [],
    };
    state.apps[id] = app;
    await saveState();
    return { code: 201, body: { id } };
  },

  async getApp(app) {
    if (app.container && app.status === "succeeded" && !(await containerRunning(app))) {
      app.status = "degraded";
      app.engineReason = "container is not running";
    }
    return {
      code: 200,
      body: {
        id: app.id,
        status: app.status,
        url: app.url,
        engineReason: app.engineReason,
        routeError: app.routeError ?? null,
        domains: app.domains ?? [],
        artifact: app.currentImage ? { image: app.currentImage } : null,
      },
    };
  },

  async deploy(app) {
    deploy(app).catch(async (error) => {
      app.status = "failed";
      app.engineReason = String(error);
      await saveState();
    });
    return { code: 202, body: { id: app.id } };
  },

  async logs(app, query) {
    const from = query.get("cursor") ? Number(query.get("cursor")) : 0;
    const live = await containerLogs(app);
    const all = [...app.logs, ...live];
    const slice = all.slice(Number.isFinite(from) ? from : 0);
    return { code: 200, body: { logs: slice, nextCursor: String(all.length) } };
  },

  /**
   * Stream an app's log as Server-Sent Events.
   *
   * The dashboard opens this and appends each `data:` line as it arrives; the
   * runtime pushes a line the moment the build plane or the container emits one,
   * so a deploy is watched live rather than polled. The backlog is sent first so
   * a client that connects mid-deploy still sees the whole log.
   */
  async stream(app, res) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (line) => {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    };
    res.write(`event: open\ndata: ${JSON.stringify({ id: app.id })}\n\n`);
    for (const line of app.logs.slice(-LOG_TAIL)) write(line);
    const listeners = logStreams.get(app.id) ?? new Set();
    listeners.add(write);
    logStreams.set(app.id, listeners);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      listeners.delete(write);
      if (listeners.size === 0) logStreams.delete(app.id);
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
    return null;
  },

  async cancel(app) {
    app.status = "pending";
    app.engineReason = "cancelled";
    await saveState();
    return { code: 200, body: {} };
  },

  async rollback(app, body) {
    if (!app.previousImage) {
      return { code: 409, body: { message: "no previous image to roll back to" } };
    }
    const target = app.previousImage;
    const result = await runContainer(app, target);
    if (result.error || !result.running) {
      return { code: 500, body: { message: result.error ?? "rollback container did not run" } };
    }
    app.previousImage = app.currentImage;
    app.currentImage = target;
    app.container = result.container;
    app.status = "succeeded";
    log(app, `rolled back to ${target}`);
    await saveState();
    return { code: 202, body: { id: app.id } };
  },

  async destroy(app) {
    const name = app.container ?? `${CONTAINER_PREFIX}-${app.id}`;
    await run("docker", ["rm", "-f", name], { timeoutMs: 60_000 });
    await withdrawAppRoutes(app);
    delete state.apps[app.id];
    await saveState();
    return { code: 200, body: {} };
  },

  async setDomains(app, body) {
    const domains = Array.isArray(body?.domains) ? body.domains.filter(isHostname) : [];
    app.domains = domains;
    const route = await publishAppRoutes(app);
    app.routeError = route.published ? null : route.reason;
    await saveState();
    return { code: 200, body: { domains, routeError: app.routeError } };
  },

  async listEnv(app) {
    const list = Object.entries(app.env).map(([key, value]) => ({
      key,
      value: mask(value),
      isBuildTime: false,
      engineRef: app.envRefs[key] ?? null,
    }));
    return { code: 200, body: { env: list } };
  },

  async createEnv(app, body) {
    if (!body?.key) return { code: 400, body: { message: "key is required" } };
    if (!isEnvKey(body.key)) {
      return { code: 400, body: { message: "key must match [A-Za-z_][A-Za-z0-9_]*." } };
    }
    app.env[body.key] = body.value ?? "";
    app.envRefs[body.key] = app.envRefs[body.key] ?? randomUUID().slice(0, 8);
    await saveState();
    return {
      code: 201,
      body: {
        key: body.key,
        value: mask(body.value ?? ""),
        isBuildTime: !!body.isBuildTime,
        engineRef: app.envRefs[body.key],
      },
    };
  },

  async updateEnv(app, body) {
    if (!body?.key) return { code: 400, body: { message: "key is required" } };
    if (!isEnvKey(body.key)) {
      return { code: 400, body: { message: "key must match [A-Za-z_][A-Za-z0-9_]*." } };
    }
    app.env[body.key] = body.value ?? "";
    app.envRefs[body.key] = app.envRefs[body.key] ?? randomUUID().slice(0, 8);
    await saveState();
    return {
      code: 200,
      body: {
        key: body.key,
        value: mask(body.value ?? ""),
        isBuildTime: !!body.isBuildTime,
        engineRef: app.envRefs[body.key],
      },
    };
  },

  async deleteEnv(app, key) {
    delete app.env[key];
    delete app.envRefs[key];
    await saveState();
    return { code: 200, body: {} };
  },
};

function mask(value) {
  if (value === undefined || value === null || value === "") return "";
  return "********";
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/healthz") return send(res, 200, { status: "ok" });

  if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) {
    return send(res, 401, { message: "Unauthenticated." });
  }

  if (req.method === "POST" && url.pathname === "/apps") {
    const body = await readBody(req);
    if (body === null) return send(res, 400, { message: "Invalid JSON body." });
    const out = await ROUTES.createApp(body);
    return send(res, out.code, out.body);
  }

  const match = url.pathname.match(
    /^\/apps\/([^/]+)(?:\/(deploy|logs|stream|cancel|rollback|env|domains))?(?:\/(.+))?$/,
  );
  if (!match) return send(res, 404, { message: "Not found." });
  const app = state.apps[match[1]];
  if (!app) return send(res, 404, { message: "Application not found." });
  const action = match[2];
  const sub = match[3];
  const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req) : {};

  if (action === "stream" && req.method === "GET") {
    return ROUTES.stream(app, res);
  }

  if (action === undefined && req.method === "GET") {
    const out = await ROUTES.getApp(app);
    return send(res, out.code, out.body);
  }
  if (action === "domains") {
    if (req.method === "PUT" || req.method === "POST") {
      const out = await ROUTES.setDomains(app, body);
      return send(res, out.code, out.body);
    }
  }
  if (action === "deploy" && req.method === "POST") {
    const out = await ROUTES.deploy(app);
    return send(res, out.code, out.body);
  }
  if (action === "logs" && req.method === "GET") {
    const out = await ROUTES.logs(app, url.searchParams);
    return send(res, out.code, out.body);
  }
  if (action === "cancel" && req.method === "POST") {
    const out = await ROUTES.cancel(app);
    return send(res, out.code, out.body);
  }
  if (action === "rollback" && req.method === "POST") {
    const out = await ROUTES.rollback(app, body);
    return send(res, out.code, out.body);
  }
  if (action === "env") {
    if (req.method === "GET") {
      const out = await ROUTES.listEnv(app);
      return send(res, out.code, out.body);
    }
    if (req.method === "POST") {
      const out = await ROUTES.createEnv(app, body);
      return send(res, out.code, out.body);
    }
    if (req.method === "PATCH" && sub) {
      const out = await ROUTES.updateEnv(app, { key: decodeURIComponent(sub), ...body });
      return send(res, out.code, out.body);
    }
    if (req.method === "DELETE" && sub) {
      const out = await ROUTES.deleteEnv(app, decodeURIComponent(sub));
      return send(res, out.code, out.body);
    }
  }
  if (action === undefined && req.method === "DELETE") {
    const out = await ROUTES.destroy(app);
    return send(res, out.code, out.body);
  }
  return send(res, 404, { message: "Not found." });
});

await loadState();
server.listen(PORT, HOST, () => {
  console.log(`Cloud Wai runtime engine listening on http://${HOST}:${PORT}`);
});
