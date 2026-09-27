/**
 * Cloud Wai edge server — a single-origin front door for the dashboard.
 *
 * This is the nginx role from `infra/deployment/nginx.conf`, expressed in Node
 * so the platform runs on a host that has no nginx (the sandbox this repo is
 * validated in). It does the same two jobs and nothing else:
 *
 *   1. Serve the built dashboard, answering an unknown path with `index.html` so
 *      a deep link or a reload lands on the app.
 *   2. Reverse-proxy `/rpc`, `/healthz` and the git webhook path to the API, so
 *      the browser talks to one origin and no CORS allow-list is involved.
 *
 * It holds no credentials and makes no engine call. The Supabase URL the bundle
 * needs is compiled into the bundle at build time; only the anon key is public.
 *
 *   node infra/deployment/edge-server.mjs            # listens on :12000
 *   EDGE_PORT=12000 API_UPSTREAM=http://127.0.0.1:8787 node .../edge-server.mjs
 */
import { createServer, request as httpRequest } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, extname, resolve } from "node:path";

const PORT = Number(process.env.EDGE_PORT ?? 12000);
const HOST = process.env.EDGE_HOST ?? "0.0.0.0";
const API_UPSTREAM = process.env.API_UPSTREAM ?? "http://127.0.0.1:8787";
const WEB_ROOT = resolve(
  process.env.WEB_ROOT ?? join(import.meta.dirname, "..", "..", "apps", "web", "dist", "browser"),
);

const upstream = new URL(API_UPSTREAM);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Paths the browser must never get the SPA shell for — they belong to the API. */
const PROXY_PREFIXES = ["/rpc", "/healthz", "/hooks/git/"];

function isProxied(pathname) {
  return PROXY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

function proxyToApi(req, res) {
  const proxied = httpRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: upstream.host,
        "x-forwarded-proto": req.headers["x-forwarded-proto"] ?? "https",
      },
    },
    (apiRes) => {
      res.writeHead(apiRes.statusCode ?? 502, apiRes.headers);
      apiRes.pipe(res);
    },
  );
  proxied.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: "unreachable", message: `The API is unreachable: ${error.message}` },
      }),
    );
  });
  req.pipe(proxied);
}

/** Resolve a request path to a file inside the bundle, or null to serve the shell. */
async function resolveAsset(pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = normalize(join(WEB_ROOT, decoded));
  // Refuse to serve anything outside the bundle root.
  if (!candidate.startsWith(WEB_ROOT)) return null;
  try {
    const info = await stat(candidate);
    if (info.isFile()) return candidate;
    const index = join(candidate, "index.html");
    if ((await stat(index)).isFile()) return index;
    return null;
  } catch {
    return null;
  }
}

function sendFile(res, file, pathname) {
  const ext = extname(file);
  const headers = { ...SECURITY_HEADERS };
  if (ext === ".html") {
    // The entry point must always be revalidated, or a deploy keeps serving the
    // old bundle.
    headers["content-type"] = MIME[".html"];
    headers["cache-control"] = "no-cache";
  } else if (/\.[0-9a-f]{8,}\./i.test(pathname)) {
    // A hashed asset filename is immutable.
    headers["content-type"] = MIME[ext] ?? "application/octet-stream";
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else {
    headers["content-type"] = MIME[ext] ?? "application/octet-stream";
    headers["cache-control"] = "no-store";
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];

  if (isProxied(pathname)) {
    proxyToApi(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: { code: "method_not_allowed" } }));
    return;
  }

  void (async () => {
    const asset = await resolveAsset(pathname);
    if (asset) {
      sendFile(res, asset, pathname);
      return;
    }
    // SPA fallback: an unknown path is a client route, not a 404.
    const shell = join(WEB_ROOT, "index.html");
    try {
      await stat(shell);
      sendFile(res, shell, "/index.html");
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("The dashboard bundle is missing. Run `pnpm --filter @cloud-wai/web build:web`.");
    }
  })();
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `Cloud Wai edge listening on http://${HOST}:${PORT}\n` +
      `  dashboard: ${WEB_ROOT}\n` +
      `  api upstream: ${API_UPSTREAM}\n`,
  );
});
