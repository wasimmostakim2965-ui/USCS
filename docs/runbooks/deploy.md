# Deploying Cloud Wai

This runbook takes the repository to a running, internet-reachable deployment on
a single host — an AWS EC2 instance, a Hetzner/DigitalOcean VM, or any machine
with Docker. It is the smallest coherent production topology: one host runs the
dashboard, the API and the worker; Supabase provides identity and the control
plane; the engines (Coolify, MinIO, the edge) are separate services reached
through the adapters.

Nothing in this runbook claims a gate that the repository cannot prove. The
release gates that need a live engine stay **open** until one is configured —
see `docs/release-gates.md`. Do not describe a deployment as complete while
gates 6–9 are open.

## 1. What the host needs

- Docker with the Compose plugin.
- A domain name (for TLS and for the dashboard origin).
- Outbound network access to Supabase and to the configured engines.

The control plane is Supabase. Do not run PostgreSQL on this host: it would be a
second source of truth and it is not where the RLS policies are proven to run.

## 2. Create the control plane

1. Create a Supabase project. Note the project URL, the anon key and the
   service-role key.
2. Apply the migrations in `supabase/migrations/` **in numeric order**, but only
   those that apply to a real Supabase project. Migrations `0001`–`0008` are the
   schema and its RLS; `tests/isolation/rls/00_auth_shim.sql` is a test-only
   shim and must **not** be applied to Supabase — real Supabase already provides
   `auth.uid()` and the roles the policies reference.

   ```bash
   for f in supabase/migrations/*.sql; do
     psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
   done
   ```

3. Confirm the isolation policies are in place before trusting the deployment:

   ```bash
   CLOUDWAI_RLS_DSN="$SUPABASE_DB_URL" bash scripts/verify-rls.sh
   ```

   This runs the same probes CI runs. A failure here means tenant isolation is
   not in place; stop and fix it.

## 3. Configure the deployment

Copy `.env.example` to `.env` on the host and fill in every value. The keys that
decide whether the deployment is real:

| Key | Why it matters |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Session verification. Without these the API exits non-zero. |
| `SUPABASE_SERVICE_ROLE_KEY` | The control-plane store and the job queue. Service-role only; it never reaches a browser. |
| `HOST=0.0.0.0`, `PORT=8787` | Bind inside the container. The API is not published directly. |
| `CLOUD_WAI_ALLOWED_ORIGINS` | Leave **empty** for this topology: the dashboard and API share an origin through nginx. |
| `CLOUD_WAI_USE_FAKE_ENGINES=false` | `true` is refused when `NODE_ENV=production`. Never enable it on a host. |
| `COOLIFY_URL`, `COOLIFY_TOKEN__<orgId>`, … | Per-organization Coolify credentials. One team per tenant. |
| `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY__<orgId>`, … | MinIO/S3 credentials. |
| `SECURITY_EDGE_URL`, `SECURITY_EDGE_ORIGIN`, `SECURITY_EDGE_TOKEN__<orgId>`, `EDGE_HOSTNAME` | The edge. The API and worker build the real adapter when the URL, a **private** origin and a per-org token are set; `EDGE_HOSTNAME` is what a domain CNAMEs to. Without the URL/origin/token the edge stays honestly `not_configured`. |
| `BUILDER_TOKEN`, `BUILD_ENGINE_URL__<orgId>`, `BUILD_ENGINE_TOKEN__<orgId>` | The build plane (ADR-0018). The builder runs as its own container with the Docker socket; the per-org endpoint/token point the adapter at it. Unset leaves builds honestly `not_configured`. See [`build-plane.md`](build-plane.md). |
| `RUNTIME_URL`, `RUNTIME_TOKEN__<orgId>` | The self-hosted runtime (ADR-0020): this deployment's own container engine, the piece Coolify otherwise supplies. The one-command deploy generates `RUNTIME_TOKEN` and wires every organization automatically; set these by hand only when the runtime runs on another host. Unset, with no Coolify, leaves the container engine honestly `not_configured`. |
| `ROUTER_TOKEN`, `ROUTER_URL`, `ROUTER_ACME_EMAIL` | The router (ADR-0021): this deployment's own front door, which maps a verified hostname to a deployed app and terminates TLS with an automatically issued certificate. `deploy.sh` generates `ROUTER_TOKEN` and starts it under the `edge` profile. Without `ROUTER_ACME_EMAIL` it serves a self-signed certificate and records why; without the router a verified domain is recorded but not reachable. |

An engine left unset is not an error: its adapter reports `not_configured` and
the dashboard shows that honestly. That is the intended state until the engine
exists.

## 4. Build and start

```bash
docker compose -f infra/deployment/docker-compose.yml up -d --build
docker compose -f infra/deployment/docker-compose.yml ps
```

To include the build plane, add the `build` profile — it starts the builder
container, which mounts the Docker socket in its own image:

```bash
docker compose -f infra/deployment/docker-compose.yml --profile build up -d --build
```

To include the self-hosted runtime — the container engine that runs what the
build plane produces — add the `runtime` profile. It mounts the Docker socket
too, in its own image, for the same reason the builder does:

```bash
docker compose -f infra/deployment/docker-compose.yml --profile build --profile runtime up -d --build
```

On a single host, `./infra/deployment/deploy.sh` does all of the above and wires
every organization to the runtime, so the two profiles are only named by hand
when the services are managed independently.

The dashboard listens on `:8080`. The API and worker have no published port.

Set the dashboard's build-time values through the environment so the bundle
points at the right Supabase project:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... \
  docker compose -f infra/deployment/docker-compose.yml up -d --build web
```

## 5. Put TLS in front

The dashboard and API containers speak plain HTTP. There are two ways to serve
custom domains over HTTPS, and the choice is which process terminates TLS.

**Option A — the router (ADR-0021).** Preferred on a single host that owns its
own front door. The router runs under the `edge` profile and does two jobs: it
maps a verified hostname to a deployed app's loopback port, and it obtains and
renews a Let's Encrypt certificate for it over ACME HTTP-01. It shares the host
loopback with the runtime, so the app ports the runtime publishes are reachable
to it. Start it with the runtime:

```bash
docker compose -f infra/deployment/docker-compose.yml \
  --profile build --profile runtime --profile edge up -d --build
```

`./infra/deployment/deploy.sh` generates `ROUTER_TOKEN` and starts it
automatically. Set `ROUTER_ACME_EMAIL` to the address Let's Encrypt should
contact; without it the router serves a self-signed certificate and records why,
rather than serving plaintext. Point each app domain's A/AAAA record at this
host — HTTP-01 needs the name reachable on `:80`. The dashboard itself can be
fronted too by setting `ROUTER_DEFAULT_UPSTREAM=http://127.0.0.1:8080`.

While testing issuance, set
`ROUTER_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory`
so a mistake does not consume the production rate limit; clear it — and delete
the `router-data` volume — to switch to real certificates.

**Option B — your own proxy.** On a host that already terminates TLS (an
ALB/ingress, or an existing nginx), leave the router off and configure that proxy
as below. A load balancer that terminates TLS upstream is also the case where
HTTP-01 is impossible, so the router is not used and the balancer holds
certificates (ADR-0015). Forward the dashboard to `:8080`:

```nginx
server {
  listen 443 ssl http2;
  server_name app.example.com;
  ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Either way, redirect `:80` to `:443`, and set HSTS once TLS is confirmed working.
The browser must reach the dashboard over HTTPS, because the Supabase session is
a bearer token.

## 6. Verify the deployment

1. **Liveness:** `curl -fsS https://app.example.com/healthz` returns
   `{"ok":true,...}`. It reveals no configuration.
2. **Sign-up:** create an account in the dashboard, then sign in. The session is
   Supabase's.
3. **Tenant isolation (gate 1):** create a second account. It must see **zero**
   organizations, projects, deployments and API keys — not the first account's.
   This is the property `tests/isolation/rls/10_isolation_probe.sql` proves at
   the database layer; step 2 of this runbook re-ran it against this project.
4. **Engines:** open Security → Engine status. An unset engine reads
   "Not configured". That is correct until you configure it.
5. **Logs:** open a deployment and read its logs. With a configured Coolify and
   a deployed application, real lines appear; without one, the drawer says the
   engine is not configured rather than showing an empty or invented log.
6. **Container engine (self-hosted runtime):** with the `runtime` profile up and
   `RUNTIME_URL`/`RUNTIME_TOKEN__<orgId>` set, Security → Engine status reads
   `selfhosted: ready` and `coolify: not_configured` — the two share one port and
   only the engine that answered is reported ready. Deploy a container project and
   confirm a new container appears (`docker ps` shows `cw-app-<id>`) and its url
   answers. On a Coolify-backed host the same step reads `coolify: ready` and
   `selfhosted: not_configured`.
7. **Domain reachability (router):** with the `edge` profile up, add a domain,
   point its A record at this host, and verify it. The result reports two facts —
   the DNS record was confirmed, and the route was published. Then
   `curl -fsS https://<the-domain>/` reaches the deployed app over HTTPS. If the
   route did not publish, the response says so with the engine's own reason
   instead of a silent success. With the router off, the domain is still recorded
   and reported as not yet routable.

## 7. Operating it

- **Migrations:** apply new files in `supabase/migrations/` in order, then re-run
  the RLS probes. Never edit an applied migration.
- **Rollback:** redeploy the previous image tag. The control plane's schema is
  additive; a rollback does not undo a migration.
- **Backups and disaster recovery:** `docs/runbooks/backup-and-dr.md`.
- **The router (public domains and TLS):** `docs/runbooks/router.md`.
- **Incidents:** `docs/runbooks/incident-response.md`.
- **SLOs:** `docs/runbooks/slos.md`.

## What this deployment does not prove

Gate 6 (deny direct origin), gate 7 (CRS fixtures blocked), gate 8 (tenant
runtime isolation) and gate 9 (verified backup restore) require live engines.
Until each is configured and its probe passes, they stay open in
`docs/release-gates.md`. Configuring them — pointing `SECURITY_EDGE_URL` at a
real Envoy/Coraza pair and wiring the edge adapter, or adding a MinIO backup
destination — is what closes them, and the evidence in that file changes in the
same commit.

The self-hosted runtime (ADR-0020) makes a container project deployable on the
host itself, but it is a *process* boundary, not a *machine* boundary: every
tenant's container runs on the same daemon as every other's. Gate 8 stays open
until each tenant is pointed at its own runtime (`RUNTIME_URL`/
`RUNTIME_TOKEN__<orgId>` per tenant, one runtime per trust boundary), which is
what turns the shared runtime into a per-tenant one.
