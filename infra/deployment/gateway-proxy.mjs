/**
 * Cloud Wai gateway proxy — the public front door for the control plane.
 *
 * The API and the worker reach Supabase over the private Docker network. A
 * browser cannot: it needs an HTTPS origin for `@supabase/supabase-js`, which
 * only ever holds the public anon key. This process exposes exactly that —
 * the Supabase gateway (Kong) — on one public port, and nothing else. The
 * service-role key never appears here; it lives only in the API/worker `.env`.
 *
 * It is a pass-through, not a filter: Kong is already the API gateway and it is
 * the component that enforces Supabase's own routing and keys. Reimplementing
 * any of that here would be a second, weaker policy surface.
 *
 *   node infra/deployment/gateway-proxy.mjs          # listens on :12001
 *   GATEWAY_PORT=12001 SUPABASE_UPSTREAM=http://127.0.0.1:54321 node .../gateway-proxy.mjs
 *
 * The root path answers with a small JSON service index. Kong has no route for
 * `/`, so a bare visit to this origin would otherwise look like a broken site
 * ("no Route matched with those values"); the index names the real endpoints
 * instead. Everything else is proxied unchanged.
 */
import { createServer, request as httpRequest } from "node:http";

const PORT = Number(process.env.GATEWAY_PORT ?? 12001);
const HOST = process.env.GATEWAY_HOST ?? "0.0.0.0";
const SUPABASE_UPSTREAM = process.env.SUPABASE_UPSTREAM ?? "http://127.0.0.1:54321";

const upstream = new URL(SUPABASE_UPSTREAM);

const SERVICE_INDEX = {
  service: "Cloud Wai Supabase gateway",
  description:
    "Public front door for the Supabase API (Auth, REST, Storage, Realtime). This is an API origin, not a web page; the dashboard is on a different port.",
  endpoints: {
    auth: "/auth/v1/*",
    rest: "/rest/v1/*",
    storage: "/storage/v1/*",
    realtime: "/realtime/v1/*",
    health: "/auth/v1/health",
  },
};

const server = createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname === "/" || pathname === "") {
    const body = JSON.stringify(SERVICE_INDEX);
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

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
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  proxied.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(
      JSON.stringify({
        ok: false,
        error: { code: "unreachable", message: `Supabase is unreachable: ${error.message}` },
      }),
    );
  });
  req.pipe(proxied);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `Cloud Wai gateway proxy listening on http://${HOST}:${PORT} -> ${SUPABASE_UPSTREAM}\n`,
  );
});
