/**
 * Cloud Wai router — the platform's own front door, routing and TLS.
 *
 * This is the piece Vercel owns and we used to borrow from a reverse proxy the
 * operator configured by hand. It does three jobs, and only these:
 *
 *   1. Routing. It reads the Host header and forwards the request to the right
 *      upstream: the dashboard, or one deployed app's loopback port. A route is
 *      published by the control plane through a token-authenticated admin API on
 *      loopback, never by a client of the public port.
 *
 *   2. TLS termination with automatic certificates. For a host whose route says
 *      `tls: "auto"`, it obtains a certificate from an ACME directory over
 *      HTTP-01 and renews it before expiry. It never invents a certificate: if
 *      issuance fails, the host keeps the fallback self-signed certificate and
 *      the route's last error is published, so the dashboard can say why.
 *
 *   3. The ACME challenge listener on :80. `/.well-known/acme-challenge/<token>`
 *      is answered from the in-memory challenge store; every other request is
 *      redirected to HTTPS.
 *
 * It holds no tenant secrets and reads no control-plane database. Its whole
 * state is `routes.json`: a hostname, the upstream it maps to, and the cert it
 * serves.
 *
 *   ROUTER_TOKEN=... ROUTER_DEFAULT_UPSTREAM=http://127.0.0.1:12000 \
 *     node infra/deployment/router-server.mjs
 */
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import acme from "acme-client";
import selfsigned from "selfsigned";

const HTTP_PORT = Number(process.env.ROUTER_HTTP_PORT ?? 8080);
const HTTPS_PORT = Number(process.env.ROUTER_HTTPS_PORT ?? 8443);
const ADMIN_PORT = Number(process.env.ROUTER_ADMIN_PORT ?? 8096);
const HOST = process.env.ROUTER_HOST ?? "0.0.0.0";
const ADMIN_HOST = process.env.ROUTER_ADMIN_HOST ?? "127.0.0.1";
const TOKEN = process.env.ROUTER_TOKEN ?? "";
const DEFAULT_UPSTREAM = (process.env.ROUTER_DEFAULT_UPSTREAM ?? "").replace(/\/+$/, "");
const DATA_DIR = resolve(process.env.ROUTER_DATA_DIR ?? join(process.cwd(), ".deploy", "router"));
const STATE_FILE = join(DATA_DIR, "routes.json");
const ACME_DIRECTORY =
  process.env.ROUTER_ACME_DIRECTORY ?? "https://acme-v02.api.letsencrypt.org/directory";
const ACME_EMAIL = process.env.ROUTER_ACME_EMAIL ?? "";
const ACME_ENABLED = (process.env.ROUTER_ACME_ENABLED ?? "true") === "true" && ACME_EMAIL !== "";
/** Renew when fewer than this many days remain on a certificate. */
const RENEW_WINDOW_DAYS = Number(process.env.ROUTER_RENEW_WINDOW_DAYS ?? 30);
const RENEW_CHECK_MS = Number(process.env.ROUTER_RENEW_CHECK_MS ?? 6 * 60 * 60 * 1000);

if (TOKEN === "") {
  console.error("ROUTER_TOKEN is required: an unauthenticated router is not a router.");
  process.exit(1);
}

/** host -> { upstream, tls, certPem, keyPem, notAfter, lastError }. */
let state = { routes: {}, defaultUpstream: DEFAULT_UPSTREAM };
/** token -> challenge key authorization, live only while an ACME order runs. */
const challenges = new Map();
/** account key for ACME, generated once and reused. */
let accountKey = null;

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return;
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8"));
    state.routes = state.routes ?? {};
  } catch {
    state = { routes: {}, defaultUpstream: DEFAULT_UPSTREAM };
  }
}

async function saveState() {
  const tmp = `${STATE_FILE}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadAccountKey() {
  const path = join(DATA_DIR, "acme-account.pem");
  if (existsSync(path)) {
    accountKey = await readFile(path, "utf8");
    return;
  }
  accountKey = (await acme.crypto.createPrivateKey()).toString();
  await writeFile(path, accountKey);
}

/** A stable self-signed certificate so a host is never served without TLS. */
let fallback = null;
async function loadFallback() {
  const path = join(DATA_DIR, "fallback.pem");
  if (existsSync(path)) {
    const pem = await readFile(path, "utf8");
    const marker = "-----END PRIVATE KEY-----";
    const at = pem.indexOf(marker);
    fallback = {
      key: pem.slice(0, at + marker.length),
      cert: pem.slice(at + marker.length).trim(),
    };
    return;
  }
  const { private: key, cert } = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      days: 3650,
      keySize: 2048,
    },
  );
  fallback = { key, cert };
  await writeFile(path, `${key}\n${cert}`);
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

function hostOf(req) {
  const raw = req.headers.host ?? "";
  return raw.split(":")[0].toLowerCase();
}

/** A hostname a route may be published for: DNS-safe, no wildcard, no scheme. */
function isHostname(host) {
  return (
    typeof host === "string" &&
    host.length > 0 &&
    host.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
  );
}

/** An upstream is a loopback http(s) URL; the router only forwards to itself. */
function isLoopbackUpstream(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    const okScheme = parsed.protocol === "http:" || parsed.protocol === "https:";
    const okHost =
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "[::1]";
    return okScheme && okHost;
  } catch {
    return false;
  }
}

/** Days until a certificate expires, or null when there is none. */
function daysUntil(notAfter) {
  if (!notAfter) return null;
  const ms = new Date(notAfter).getTime() - Date.now();
  return ms / (24 * 60 * 60 * 1000);
}

/**
 * Obtain a certificate for a host over HTTP-01.
 *
 * The challenge is served on :80 by this process, so no external web server is
 * involved. On success the cert and key are stored on the route; on failure the
 * route keeps its previous certificate (or the fallback) and records why.
 */
async function obtainCertificate(host) {
  if (!ACME_ENABLED || !accountKey) {
    return { ok: false, reason: "automatic TLS is not configured (ROUTER_ACME_EMAIL)" };
  }
  const client = new acme.Client({ directoryUrl: ACME_DIRECTORY, accountKey });
  const [key, csr] = await acme.crypto.createCsr({ commonName: host });
  const pem = await client.auto({
    csr,
    email: ACME_EMAIL,
    termsOfServiceAgreed: true,
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      if (challenge.type !== "http-01") {
        throw new Error(`unsupported challenge type ${challenge.type}`);
      }
      challenges.set(challenge.token, keyAuthorization);
    },
    challengeRemoveFn: async (_authz, challenge) => {
      challenges.delete(challenge.token);
    },
  });
  const certPem = pem.toString();
  const keyPem = key.toString();
  const notAfter = new Date(Date.parse(extractNotAfter(certPem))).toISOString();
  return { ok: true, certPem, keyPem, notAfter };
}

/** Read notAfter from a PEM certificate without a crypto dependency. */
function extractNotAfter(pem) {
  try {
    return new X509Certificate(pem).validTo;
  } catch {
    return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  }
}

async function ensureCertificate(host) {
  const route = state.routes[host];
  if (!route) return;
  if (route.tls !== "auto") return;
  const remaining = daysUntil(route.notAfter);
  if (route.certPem && remaining !== null && remaining > RENEW_WINDOW_DAYS) return;
  try {
    const result = await obtainCertificate(host);
    if (result.ok) {
      route.certPem = result.certPem;
      route.keyPem = result.keyPem;
      route.notAfter = result.notAfter;
      route.lastError = null;
    } else {
      route.lastError = result.reason;
    }
  } catch (error) {
    route.lastError = String(error?.message ?? error);
  }
  await saveState();
}

/** The secure context for a host: its own certificate, or the fallback. */
function contextFor(host) {
  const route = state.routes[host];
  if (route?.certPem && route?.keyPem) {
    try {
      return createSecureContext({ cert: route.certPem, key: route.keyPem });
    } catch {
      // fall through to the fallback
    }
  }
  return createSecureContext({ cert: fallback.cert, key: fallback.key });
}

function upstreamFor(host) {
  const route = state.routes[host];
  if (route?.upstream) return route.upstream;
  if (state.defaultUpstream) return state.defaultUpstream;
  return null;
}

/** Forward a request to the upstream, preserving method, headers and body. */
function proxy(req, res, upstreamUrl) {
  let target;
  try {
    target = new URL(req.url ?? "/", upstreamUrl);
  } catch {
    res.writeHead(502).end("Bad upstream");
    return;
  }
  const headers = { ...req.headers, host: new URL(upstreamUrl).host, "x-forwarded-proto": "https" };
  const upstreamReq = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("Upstream unavailable");
  });
  req.pipe(upstreamReq);
}

const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/.well-known/acme-challenge/")) {
    const token = url.pathname.slice("/.well-known/acme-challenge/".length);
    const value = challenges.get(token);
    if (value) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(value);
    } else {
      res.writeHead(404).end("No such challenge");
    }
    return;
  }
  const host = hostOf(req);
  res.writeHead(301, { location: `https://${host}${url.pathname}${url.search}` });
  res.end();
});

const httpsServer = createHttpsServer(
  {
    // No default cert/key: every handshake is resolved by SNI to the route's
    // certificate, or the fallback. A request without SNI gets the fallback.
    SNICallback: (servername, cb) => {
      try {
        cb(null, contextFor((servername ?? "").toLowerCase()));
      } catch (error) {
        cb(error);
      }
    },
  },
  (req, res) => {
    const host = hostOf(req);
    const upstream = upstreamFor(host);
    if (!upstream) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`No route for ${host}`);
      return;
    }
    proxy(req, res, upstream);
  },
);

/** The admin API: the control plane publishes and removes routes here. */
const adminServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/healthz") return send(res, 200, { status: "ok" });
  if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) {
    return send(res, 401, { message: "Unauthenticated." });
  }
  if (req.method === "GET" && url.pathname === "/routes") {
    const list = Object.entries(state.routes).map(([host, r]) => ({
      host,
      upstream: r.upstream,
      tls: r.tls,
      notAfter: r.notAfter ?? null,
      lastError: r.lastError ?? null,
    }));
    return send(res, 200, { routes: list, defaultUpstream: state.defaultUpstream ?? null });
  }
  if (req.method === "PUT" && url.pathname === "/routes") {
    const body = await readBody(req);
    if (body === null) return send(res, 400, { message: "Invalid JSON body." });
    const host = String(body.host ?? "").toLowerCase();
    if (!isHostname(host)) return send(res, 400, { message: "host must be a DNS name." });
    if (!isLoopbackUpstream(body.upstream)) {
      return send(res, 400, { message: "upstream must be a loopback http(s) URL." });
    }
    const tls = body.tls === "auto" ? "auto" : "none";
    const existing = state.routes[host] ?? {};
    state.routes[host] = {
      ...existing,
      upstream: body.upstream,
      tls,
      lastError: null,
    };
    await saveState();
    if (tls === "auto") {
      // Issue in the background so publishing a route is fast; the cert lands on
      // the route when it is ready and the admin API reports its state.
      ensureCertificate(host).catch(() => {});
    }
    return send(res, 202, { host, tls });
  }
  const del = url.pathname.match(/^\/routes\/(.+)$/);
  if (req.method === "DELETE" && del) {
    const host = decodeURIComponent(del[1]).toLowerCase();
    delete state.routes[host];
    await saveState();
    return send(res, 200, { host });
  }
  return send(res, 404, { message: "Not found." });
});

async function renewLoop() {
  for (const host of Object.keys(state.routes)) {
    const route = state.routes[host];
    if (route.tls !== "auto") continue;
    const remaining = daysUntil(route.notAfter);
    if (route.certPem && remaining !== null && remaining > RENEW_WINDOW_DAYS) continue;
    await ensureCertificate(host);
  }
}

await loadState();
await loadFallback();
if (ACME_ENABLED) await loadAccountKey();

adminServer.listen(ADMIN_PORT, ADMIN_HOST, () => {
  console.log(`Cloud Wai router admin on http://${ADMIN_HOST}:${ADMIN_PORT}`);
});
httpsServer.listen(HTTPS_PORT, HOST, () => {
  console.log(`Cloud Wai router HTTPS on :${HTTPS_PORT}`);
});
httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`Cloud Wai router HTTP/ACME on :${HTTP_PORT}`);
});
setInterval(() => {
  renewLoop().catch(() => {});
}, RENEW_CHECK_MS).unref();
