# Serving Cloud Wai on a single host

This is the "one VM, two origins" profile. It is what `infra/deployment/docker-compose.yml`
does with containers, written for a host that runs the processes directly — the shape
this repository is validated in. Use it when you have a Supabase stack and a built
bundle and no nginx.

Two public origins are needed, and only two:

| Origin | Process | Serves |
| --- | --- | --- |
| `https://api.example.com` | `edge-server.mjs` | the dashboard bundle, and `/rpc` + `/healthz` proxied to the API |
| `https://supabase.example.com` | `gateway-proxy.mjs` | the Supabase gateway (Kong), which the browser needs for Auth |

The browser talks to the API and to Supabase. Nothing else is exposed; the API, the
worker and the control-plane Postgres stay on the private network.

## 1. Build the bundle with public values

The dashboard compiles its Supabase URL and anon key into the bundle, so they are
build-time values, not runtime ones. The anon key is public by design; the
service-role key is never read here.

```sh
VITE_SUPABASE_URL="https://supabase.example.com" \
VITE_SUPABASE_ANON_KEY="<the anon key>" \
VITE_CLOUD_WAI_API_URL="" \
  pnpm --filter @cloud-wai/web build:web
```

Leaving `VITE_CLOUD_WAI_API_URL` empty makes the dashboard use its own origin for
`/rpc`, which is why the edge server proxies that path. That removes CORS from the
picture entirely: one origin, no allow-list to get wrong.

## 2. Configure the API and worker environment

`infra/deployment/.env.example` lists every variable. At minimum:

```sh
SUPABASE_URL=https://supabase.example.com
SUPABASE_SERVICE_ROLE_KEY=<service role key>   # API/worker only, never the browser
SUPABASE_ANON_KEY=<anon key>
HOST=127.0.0.1
PORT=8787
NODE_ENV=production
# Encrypts per-project environment variables and git webhook secrets at rest.
# Without it, `env.set` and `git.connect` answer `engine_unavailable` — honestly,
# not with a fake success. Generate one:
#   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
CLOUD_WAI_SECRET_ENCRYPTION_KEY=<32-byte base64 key>
```

Then start the two processes and both proxies:

```sh
node --env-file=.env apps/api/dist/main.js          # 127.0.0.1:8787
node --env-file=.env apps/worker/dist/main.js       # drains the orchestration queue

EDGE_PORT=12000   API_UPSTREAM=http://127.0.0.1:8787 \
  node infra/deployment/edge-server.mjs
GATEWAY_PORT=12001 SUPABASE_UPSTREAM=http://127.0.0.1:54321 \
  node infra/deployment/gateway-proxy.mjs
```

## 3. What is still not_configured, and why that is correct

A fresh deployment with no engine credentials reports `not_configured` for
`coolify`, `postgres`, `minio`, `envoy`, `railpack` and `lambda`. That is the
honest state, not a bug:

* `deployments.create` stores a `pending` deployment with `engineReason` set, and
  the worker records `not_configured` rather than a fake `ready`.
* `data.provision` stores a resource in state `not_configured`.
* `security.policy.distribute` answers `distributed: false` and opens a
  `policy_distribution_rejected` incident.
* `domains.verify` returns `verified: false` with the reason and no edge host.

To make those real, supply the engine credentials in `.env` (see
`infra/deployment/.env.example`) and re-run each flow. `docs/release-gates.md`
gates 6–9 stay open until a real edge and hosting engine are wired — they cannot be
closed with simulated data.
