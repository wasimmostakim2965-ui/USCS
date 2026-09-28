/**
 * Cloud Wai build plane.
 *
 * Implements the HTTP contract the platform's Railpack adapter speaks
 * (`packages/adapters/src/build-railpack.ts`):
 *
 *   POST /builds                       -> { id }
 *   GET  /builds/:id                   -> { status, artifact, logs, nextCursor }
 *   GET  /builds/:id/logs?cursor=      -> { logs, nextCursor }
 *   POST /builds/:id/cancel            -> {}
 *
 * The actual builder is Nixpacks (Railway's source-to-image tool, the predecessor
 * of Railpack, now in maintenance mode but still installable and runnable). This
 * process only orchestrates: it clones the source, drives the Nixpacks CLI,
 * records the log lines and reports the produced image. It never invents an
 * image: if Nixpacks fails, the job fails with the real output.
 *
 * Nixpacks is invoked as a **binary** (`nixpacks build …`), not as
 * `docker run <nixpacks-image> build …`. The published `ghcr.io/railwayapp/
 * nixpacks` images are the generated Dockerfiles' *base* images — their CMD is
 * `/bin/bash` and they carry no `nixpacks` executable — so the `docker run`
 * form fails with `exec: "build": executable file not found in $PATH` on every
 * build. `infra/deployment/builder.Dockerfile` installs the pinned binary and
 * puts it on PATH; an operator running this process directly sets `NIXPACKS_BIN`.
 *
 *   node infra/deployment/builder-server.mjs
 *
 * The builder is the one part of the platform that runs untrusted customer
 * source, so it is bounded on every axis an attacker or a broken repository
 * could exhaust: concurrent builds, wall-clock time, log volume and job
 * retention. The bounds are configuration, not constants, and each is applied
 * where the untrusted input arrives.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.BUILDER_PORT ?? 8090);
const HOST = process.env.BUILDER_HOST ?? "0.0.0.0";
const TOKEN = process.env.BUILDER_TOKEN ?? "";
const IMAGE_PREFIX = process.env.BUILDER_IMAGE_PREFIX ?? "cloudwai";
// The Nixpacks executable. The builder image puts a pinned version on PATH; an
// operator running this directly points this at the binary they installed.
const NIXPACKS_BIN = process.env.NIXPACKS_BIN ?? "nixpacks";
// How many builds may run at once. Each drives a Docker build, so an unbounded
// value turns one tenant's build storm into a denial of service for every other
// tenant on the host. Excess builds wait in a FIFO queue rather than failing.
const MAX_CONCURRENT_BUILDS = Math.max(1, Number(process.env.BUILDER_CONCURRENCY ?? 2));
// A build that has not finished in this long is killed and reported as a
// timeout. Without it a hung `npm install` holds a slot forever.
const BUILD_TIMEOUT_MS = Math.max(1000, Number(process.env.BUILDER_BUILD_TIMEOUT_MS ?? 900_000));
// Finished jobs are kept for this long so a caller can read the logs back, then
// dropped so the process does not grow without bound.
const JOB_TTL_MS = Math.max(1000, Number(process.env.BUILDER_JOB_TTL_MS ?? 3_600_000));
// A build log is capped so a repository that prints forever cannot exhaust the
// process's memory; the cap is reported in the log so the truncation is visible.
const MAX_LOG_LINES = Math.max(100, Number(process.env.BUILDER_MAX_LOG_LINES ?? 5_000));
// Where the job index is persisted. Without it every in-flight job is lost on a
// restart: the caller's poll then gets a 404 it must interpret as a failure,
// and a build that was actually running is reported as crashed. With it, a job
// that was in flight is reaped to a terminal failure on the next boot, so the
// caller learns the truth instead of waiting out its own ceiling.
const STATE_DIR = process.env.BUILDER_DATA_DIR ?? "";
const STATE_FILE = STATE_DIR ? join(STATE_DIR, "jobs.json") : "";

if (!TOKEN) {
  console.error("BUILDER_TOKEN is not set; refusing to start an unauthenticated builder.");
  process.exit(1);
}

/** @type {Map<string, {id:string,status:string,artifact:object|null,lines:string[],nextCursor:string|null,idempotencyKey?:string,cancelled:boolean}>} */
const jobs = new Map();
/** @type {Map<string, string>} */
const byIdempotencyKey = new Map();

// Persistence. Every mutation of a job's reported state marks the index dirty;
// a debounced flush writes it, and the process exits only after a final flush.
let dirty = false;
function markDirty() {
  dirty = true;
}

function jobIndex() {
  return {
    jobs: [...jobs.values()].map((job) => ({
      id: job.id,
      status: job.status,
      artifact: job.artifact ?? null,
      lines: job.lines,
      nextCursor: job.nextCursor ?? null,
      idempotencyKey: job.idempotencyKey ?? null,
      cancelled: Boolean(job.cancelled),
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
    })),
  };
}

async function flushState() {
  if (!STATE_FILE || !dirty) return;
  dirty = false;
  const payload = JSON.stringify(jobIndex());
  const tmp = `${STATE_FILE}.${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tmp, payload);
    await rename(tmp, STATE_FILE);
  } catch (error) {
    // A failed write must not crash the builder; the next flush retries.
    await rm(tmp, { force: true }).catch(() => {});
    console.error(`[cloud-wai] builder state flush failed: ${String(error)}`);
  }
}

/**
 * Load the job index and fail anything that was mid-flight when we last exited.
 *
 * A job persisted as `running` or `queued` cannot still be running: this is a
 * fresh process, so its child is gone. Reporting it as `failed` is the honest
 * answer — a caller polling it settles instead of waiting out its ceiling — and
 * the reason says why, so the failure is not mysterious.
 */
async function loadState() {
  if (!STATE_FILE) return;
  await mkdir(STATE_DIR, { recursive: true }).catch(() => {});
  let parsed;
  try {
    parsed = JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return; // no prior index, or an unreadable one: start empty
  }
  for (const row of parsed?.jobs ?? []) {
    if (!row?.id) continue;
    const interrupted = row.status === "running" || row.status === "queued";
    const job = {
      id: row.id,
      status: interrupted ? "failed" : row.status,
      artifact: row.artifact ?? null,
      lines: Array.isArray(row.lines) ? row.lines : [],
      nextCursor: row.nextCursor ?? null,
      idempotencyKey: row.idempotencyKey ?? undefined,
      cancelled: Boolean(row.cancelled),
      startedAt: row.startedAt ?? undefined,
      finishedAt: row.finishedAt ?? undefined,
    };
    if (interrupted) {
      job.finishedAt = Date.now();
      log(
        job,
        "[cloud-wai] the builder restarted while this build was in flight; it did not finish",
      );
    }
    jobs.set(job.id, job);
    if (job.idempotencyKey) byIdempotencyKey.set(job.idempotencyKey, job.id);
  }
  dirty = true;
}

// Builds beyond MAX_CONCURRENT_BUILDS wait here. Each entry resumes the build
// it names; a queued job reports `queued` until a slot frees, so a caller sees
// the real state rather than a build that claims to have started.
let running = 0;
/** @type {Array<() => void>} */
const waiting = [];

function log(job, line) {
  markDirty();
  if (job.lines.length >= MAX_LOG_LINES) {
    // Say so once, then stop recording. Silently dropping the tail would make
    // the log look complete when it is not.
    if (!job.logTruncated) {
      job.logTruncated = true;
      job.lines.push(`[cloud-wai] log truncated at ${MAX_LOG_LINES} lines`);
    }
    return;
  }
  job.lines.push(line);
}

/**
 * Claim a build slot, waiting in FIFO order if the limit is reached. Resolves
 * when this job may run.
 */
function acquireSlot() {
  if (running < MAX_CONCURRENT_BUILDS) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiting.push(() => {
      // The slot is handed over, not freed: the releaser decremented `running`
      // and this re-increments it, keeping the count correct across the handoff.
      running += 1;
      resolve();
    });
  });
}

function releaseSlot() {
  running -= 1;
  const next = waiting.shift();
  if (next) next();
}

/**
 * Drop finished jobs older than JOB_TTL_MS so a long-lived builder does not
 * accumulate every build it has ever run. A running or queued job is never
 * dropped.
 */
function sweepJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    const finished = job.status === "succeeded" || job.status === "failed";
    if (finished && job.finishedAt !== undefined && job.finishedAt < cutoff) {
      jobs.delete(id);
      if (job.idempotencyKey) byIdempotencyKey.delete(job.idempotencyKey);
      markDirty();
    }
  }
}

setInterval(sweepJobs, Math.min(JOB_TTL_MS, 60_000)).unref();

// Debounced persistence: a build writes many log lines, and flushing each one
// would spend more time in fsync than in the build. A short interval bounds the
// work a crash can lose to a few hundred milliseconds of log lines.
const flushTimer = setInterval(() => {
  void flushState();
}, 500);
flushTimer.unref();

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const onData = (buf) => {
      const text = buf.toString();
      out += text;
      if (options.onLine) {
        for (const line of text.split("\n")) if (line.trim() !== "") options.onLine(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => finish({ code: 127, out: String(error) }));
    child.on("close", (code) => finish({ code: code ?? 1, out }));
    // A build that hangs must not hold its slot forever. Kill the process group
    // (`spawn` with `detached` would be needed for grandchildren) and report the
    // timeout distinctly so the deploy fails with the real reason.
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timer = undefined;
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish({ code: 124, out: `${out}\n[cloud-wai] build timed out` });
      }, options.timeoutMs);
    }
  });
}

async function runBuild(job, payload) {
  await acquireSlot();
  if (job.cancelled) {
    job.status = "failed";
    job.finishedAt = Date.now();
    log(job, "build cancelled before it started");
    releaseSlot();
    return;
  }
  job.status = "running";
  markDirty();
  const source = payload.source ?? {};
  const workspace = await mkdtemp(join(tmpdir(), "cloudwai-build-"));
  const sourceDir = join(workspace, "src");
  const tag = `${IMAGE_PREFIX}-${job.id.slice(0, 12)}`;
  try {
    if (source.kind === "git") {
      log(job, `cloning ${source.repository}`);
      const clone = await run("git", ["clone", "--depth", "1", source.repository, sourceDir], {
        onLine: (line) => log(job, line),
        timeoutMs: BUILD_TIMEOUT_MS,
      });
      if (clone.code !== 0) {
        job.status = "failed";
        log(job, `clone failed with exit code ${clone.code}`);
        return;
      }
      if (source.gitRef) {
        const checkout = await run("git", ["-C", sourceDir, "checkout", source.gitRef], {
          onLine: (line) => log(job, line),
          timeoutMs: BUILD_TIMEOUT_MS,
        });
        if (checkout.code !== 0) {
          job.status = "failed";
          log(job, `checkout of ${source.gitRef} failed with exit code ${checkout.code}`);
          return;
        }
      }
    } else if (source.kind === "image") {
      job.status = "succeeded";
      job.finishedAt = Date.now();
      job.artifact = { image: source.uri, resolvedCommit: undefined, framework: null };
      log(job, `image source ${source.uri}: nothing to build`);
      return;
    } else {
      job.status = "failed";
      log(job, `unsupported source kind: ${source.kind}`);
      return;
    }

    // Nixpacks builds through the Docker daemon; this process drives the CLI so
    // the image lands in the same daemon the control plane deploys from.
    // `--name` is the local image tag. The binary is invoked directly — see the
    // header for why `docker run <nixpacks-image> build` is the wrong form.
    log(job, `building with nixpacks -> ${tag}`);
    const args = ["build", sourceDir, "--name", tag];
    if (payload.buildCommand) args.push("--build-cmd", payload.buildCommand);
    if (payload.buildPack) args.push("--buildpacks", payload.buildPack);
    // Non-secret build-time environment the adapter forwarded. It is applied so
    // a build that was configured with it is not built without it — the adapter
    // and the service agree on the contract. Nixpacks takes one `--env KEY=VAL`
    // per variable as a repeated flag. Secrets are not sent here (the contract
    // says so); they are resolved by the engine.
    const buildEnv = payload.environment ?? {};
    if (typeof buildEnv === "object" && buildEnv !== null) {
      for (const [key, value] of Object.entries(buildEnv)) {
        if (typeof key === "string" && key !== "" && typeof value === "string") {
          args.push("--env", `${key}=${value}`);
        }
      }
    }

    const build = await run(NIXPACKS_BIN, args, {
      onLine: (line) => log(job, line),
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    if (job.cancelled) {
      job.status = "failed";
      log(job, "build cancelled");
      return;
    }
    if (build.code !== 0) {
      job.status = "failed";
      log(job, `nixpacks exited with code ${build.code}`);
      return;
    }

    // `nixpacks plan` classifies the source the same way the build did. The
    // detected language is `variables.NIXPACKS_METADATA` (e.g. "node"); the
    // `providers` array is empty for the languages Nixpacks auto-detects, so
    // reading only that would report `null` for every ordinary app. Neither
    // field is guessed: a plan that fails leaves `framework` null.
    const detect = await run(NIXPACKS_BIN, ["plan", sourceDir, "--format", "json"], {
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    let framework = null;
    if (detect.code === 0) {
      try {
        const plan = JSON.parse(detect.out);
        const providers = plan.providers ?? [];
        framework = plan.variables?.NIXPACKS_METADATA ?? providers[0] ?? null;
      } catch {
        framework = null;
      }
    }
    job.artifact = { image: tag, framework };
    job.status = "succeeded";
    markDirty();
    log(job, `build succeeded: ${tag}`);
  } catch (error) {
    job.status = "failed";
    log(job, `build failed: ${String(error)}`);
  } finally {
    if (job.status === "succeeded" || job.status === "failed") {
      job.finishedAt = Date.now();
    }
    markDirty();
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    releaseSlot();
  }
}

function send(res, code, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/healthz") return send(res, 200, { status: "ok" });

  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) return send(res, 401, { message: "Unauthenticated." });

  if (req.method === "POST" && url.pathname === "/builds") {
    const payload = await readBody(req);
    if (payload === null) return send(res, 400, { message: "Invalid JSON body." });
    const key = payload.idempotencyKey;
    if (key && byIdempotencyKey.has(key)) {
      return send(res, 201, { id: byIdempotencyKey.get(key) });
    }
    const id = randomUUID().replace(/-/g, "").slice(0, 24);
    const job = {
      id,
      status: "queued",
      artifact: null,
      lines: [],
      nextCursor: null,
      idempotencyKey: key,
      cancelled: false,
    };
    jobs.set(id, job);
    if (key) byIdempotencyKey.set(key, id);
    // Persist the job before it starts. A caller that receives the id from a
    // response this process wrote can then always read *something* back, even
    // if the process dies before the build reports anything.
    markDirty();
    await flushState();
    log(job, `accepted build for ${payload.source?.kind ?? "unknown"} source`);
    void runBuild(job, payload);
    return send(res, 201, { id });
  }

  const match = url.pathname.match(/^\/builds\/([^/]+)(\/logs|\/cancel)?$/);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) return send(res, 404, { message: "Build not found." });
    const suffix = match[2];
    if (suffix === "/cancel" && req.method === "POST") {
      job.cancelled = true;
      markDirty();
      return send(res, 200, {});
    }
    if (suffix === "/logs" && req.method === "GET") {
      const cursor = url.searchParams.get("cursor");
      const from = cursor ? Number(cursor) : 0;
      const slice = job.lines.slice(Number.isFinite(from) ? from : 0);
      return send(res, 200, { logs: slice, nextCursor: String(job.lines.length) });
    }
    if (!suffix && req.method === "GET") {
      return send(res, 200, {
        id: job.id,
        status: job.status,
        artifact: job.artifact,
        logs: job.lines,
      });
    }
  }

  return send(res, 404, { message: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`Cloud Wai build plane listening on http://${HOST}:${PORT}`);
});

// Load the job index before serving, so a build id a caller already holds is
// answerable the moment the process is up. Anything caught mid-flight is reaped
// to a terminal failure here (see `loadState`).
await loadState();
await flushState();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    // Flush synchronously-ish before exiting so the last log lines and the final
    // statuses survive a clean stop (a `docker stop` sends SIGTERM).
    void flushState().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
