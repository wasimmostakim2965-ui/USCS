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
 * of Railpack and still the one with a published, runnable image). This process
 * only orchestrates: it clones the source, drives Nixpacks, records the log
 * lines and reports the produced image. It never invents an image: if Nixpacks
 * fails, the job fails with the real output.
 *
 *   node infra/deployment/builder-server.mjs
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.BUILDER_PORT ?? 8090);
const HOST = process.env.BUILDER_HOST ?? "0.0.0.0";
const TOKEN = process.env.BUILDER_TOKEN ?? "";
const IMAGE_PREFIX = process.env.BUILDER_IMAGE_PREFIX ?? "cloudwai";
const NIXPACKS_IMAGE = process.env.NIXPACKS_IMAGE ?? "cloudwai-nixpacks:latest";

if (!TOKEN) {
  console.error("BUILDER_TOKEN is not set; refusing to start an unauthenticated builder.");
  process.exit(1);
}

/** @type {Map<string, {id:string,status:string,artifact:object|null,lines:string[],nextCursor:string|null,idempotencyKey?:string,cancelled:boolean}>} */
const jobs = new Map();
/** @type {Map<string, string>} */
const byIdempotencyKey = new Map();

function log(job, line) {
  job.lines.push(line);
}

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const onData = (buf) => {
      const text = buf.toString();
      out += text;
      if (options.onLine) {
        for (const line of text.split("\n")) if (line.trim() !== "") options.onLine(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => resolve({ code: 127, out: String(error) }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function runBuild(job, payload) {
  job.status = "running";
  const source = payload.source ?? {};
  const workspace = await mkdtemp(join(tmpdir(), "cloudwai-build-"));
  const sourceDir = join(workspace, "src");
  const tag = `${IMAGE_PREFIX}-${job.id.slice(0, 12)}`;
  try {
    if (source.kind === "git") {
      log(job, `cloning ${source.repository}`);
      const clone = await run("git", ["clone", "--depth", "1", source.repository, sourceDir], {
        onLine: (line) => log(job, line),
      });
      if (clone.code !== 0) {
        job.status = "failed";
        log(job, `clone failed with exit code ${clone.code}`);
        return;
      }
      if (source.gitRef) {
        const checkout = await run("git", ["-C", sourceDir, "checkout", source.gitRef], {
          onLine: (line) => log(job, line),
        });
        if (checkout.code !== 0) {
          job.status = "failed";
          log(job, `checkout of ${source.gitRef} failed with exit code ${checkout.code}`);
          return;
        }
      }
    } else if (source.kind === "image") {
      job.status = "succeeded";
      job.artifact = { image: source.uri, resolvedCommit: undefined, framework: null };
      log(job, `image source ${source.uri}: nothing to build`);
      return;
    } else {
      job.status = "failed";
      log(job, `unsupported source kind: ${source.kind}`);
      return;
    }

    // Nixpacks builds through the Docker daemon; this process is given the
    // socket so the image lands in the same registry the control plane deploys
    // from. `--name` is the local image tag.
    log(job, `building with nixpacks -> ${tag}`);
    const args = [
      "run",
      "--rm",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${sourceDir}:/app:ro`,
      NIXPACKS_IMAGE,
      "build",
      "/app",
      "--name",
      tag,
    ];
    if (payload.buildCommand) args.push("--build-cmd", payload.buildCommand);
    if (payload.buildPack) args.push("--buildpacks", payload.buildPack);

    const build = await run("docker", args, { onLine: (line) => log(job, line) });
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

    const detect = await run("docker", ["run", "--rm", "-v", `${sourceDir}:/app:ro`, NIXPACKS_IMAGE, "plan", "/app", "--format", "json"]);
    let framework = null;
    if (detect.code === 0) {
      try {
        const plan = JSON.parse(detect.out);
        const providers = plan.providers ?? [];
        framework = providers[0] ?? null;
      } catch {
        framework = null;
      }
    }
    job.artifact = { image: tag, framework };
    job.status = "succeeded";
    log(job, `build succeeded: ${tag}`);
  } catch (error) {
    job.status = "failed";
    log(job, `build failed: ${String(error)}`);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

function send(res, code, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
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
    const job = { id, status: "queued", artifact: null, lines: [], nextCursor: null, idempotencyKey: key, cancelled: false };
    jobs.set(id, job);
    if (key) byIdempotencyKey.set(key, id);
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
      return send(res, 200, {});
    }
    if (suffix === "/logs" && req.method === "GET") {
      const cursor = url.searchParams.get("cursor");
      const from = cursor ? Number(cursor) : 0;
      const slice = job.lines.slice(Number.isFinite(from) ? from : 0);
      return send(res, 200, { logs: slice, nextCursor: String(job.lines.length) });
    }
    if (!suffix && req.method === "GET") {
      return send(res, 200, { id: job.id, status: job.status, artifact: job.artifact, logs: job.lines });
    }
  }

  return send(res, 404, { message: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`Cloud Wai build plane listening on http://${HOST}:${PORT}`);
});
