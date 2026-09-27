# Serving Cloud Wai on a single host

## The one-command path

`infra/deployment/deploy.sh` is the "click deploy" entry point. It brings up the
whole control plane on one Linux host — Docker, the Supabase stack, the API, the
worker and both public origins — and leaves it running:

```sh
./infra/deployment/deploy.sh          # deploy
./infra/deployment/deploy.sh status   # what is up right now
./infra/deployment/deploy.sh down     # stop the Cloud Wai processes
```

It is idempotent: re-running it reuses a running Supabase stack, keeps an existing
`CLOUD_WAI_SECRET_ENCRYPTION_KEY`, rebuilds, and restarts only the Cloud Wai
processes. It never runs `supabase db reset`, so a redeploy does not destroy
control-plane data. Each process is started with `setsid`, so a deploy begun over
SSH survives the session that started it.

Set `PUBLIC_SUPABASE_URL` to the browser-facing gateway origin before deploying,
or the bundle bakes in a loopback URL that a browser cannot reach:

```sh
PUBLIC_SUPABASE_URL=https://supabase.example.com ./infra/deployment/deploy.sh
```

The rest of this file explains the same steps by hand, for an operator who wants
to run them individually.

### Container egress and the host MTU

If the host's uplink MTU is below 1500 (common on overlays and some VPCs), a
freshly created Docker bridge still assumes 1500. Packets larger than the path
MTU are then dropped rather than fragmented, which shows up as a container that
cannot clone a repository — `git clone` dies with `Recv failure: Connection
reset by peer` while `curl` of a small page succeeds. The deploy script clamps
the TCP MSS to the path MTU once, before any container is built, so the
connection negotiates a segment size that fits:

```sh
sudo iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --clamp-mss-to-pmtu
```

This is preferred over recreating every network at a lower MTU, because it does
not disturb networks that already hold running state. `deploy.sh` adds it
automatically when passwordless sudo is available.

## The manual path: two origins

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
