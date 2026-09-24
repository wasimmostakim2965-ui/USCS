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
| `SECURITY_EDGE_URL`, `EDGE_HOSTNAME` | The edge. Without a built edge adapter wired to `buildEngines`, the edge stays `not_configured`. |

An engine left unset is not an error: its adapter reports `not_configured` and
the dashboard shows that honestly. That is the intended state until the engine
exists.

## 4. Build and start

```bash
docker compose -f infra/deployment/docker-compose.yml up -d --build
docker compose -f infra/deployment/docker-compose.yml ps
```

The dashboard listens on `:8080`. The API and worker have no published port.

Set the dashboard's build-time values through the environment so the bundle
points at the right Supabase project:

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... \
  docker compose -f infra/deployment/docker-compose.yml up -d --build web
```

## 5. Put TLS in front

The containers speak plain HTTP. Terminate TLS at the host's reverse proxy and
forward to `:8080`. The browser must reach the dashboard over HTTPS, because the
Supabase session is a bearer token.

An nginx example for the host:

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

Redirect `:80` to `:443`, and set HSTS once TLS is confirmed working.

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

## 7. Operating it

- **Migrations:** apply new files in `supabase/migrations/` in order, then re-run
  the RLS probes. Never edit an applied migration.
- **Rollback:** redeploy the previous image tag. The control plane's schema is
  additive; a rollback does not undo a migration.
- **Backups and disaster recovery:** `docs/runbooks/backup-and-dr.md`.
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
