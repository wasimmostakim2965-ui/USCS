#!/usr/bin/env bash
#
# Cloud Wai — one-command deploy.
#
# This is the "click deploy" entry point. It brings up the whole control plane
# on a single Linux host: the Supabase stack (identity + control-plane Postgres),
# the API, the worker, and the two public origins the browser needs. It is the
# script form of the Vercel-style "deploy this repository" button — nothing here
# is a placeholder, and a step that cannot complete stops the deploy instead of
# printing a success it did not earn.
#
#   ./infra/deployment/deploy.sh              # full deploy
#   ./infra/deployment/deploy.sh status       # what is up, right now
#   ./infra/deployment/deploy.sh down         # stop the Cloud Wai processes
#
# Ports (override with env):
#   DASHBOARD_PORT=12000   public dashboard + API proxy
#   GATEWAY_PORT=12001     public Supabase gateway (Auth)
#   API_PORT=8787          API loopback
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DASHBOARD_PORT="${DASHBOARD_PORT:-12000}"
GATEWAY_PORT="${GATEWAY_PORT:-12001}"
API_PORT="${API_PORT:-8787}"
SUPABASE_PORT="${SUPABASE_PORT:-54321}"
RUNTIME_PORT="${RUNTIME_PORT:-8095}"
ROUTER_ADMIN_PORT="${ROUTER_ADMIN_PORT:-8096}"
RUN_DIR="$ROOT/.deploy"
LOG_DIR="$RUN_DIR/logs"

# The Supabase CLI is not always on PATH; fall back to the pinned project
# dependency or npx so the deploy does not depend on a global install.
if command -v supabase >/dev/null 2>&1; then
  SUPABASE_BIN="supabase"
elif [[ -x "$ROOT/node_modules/.bin/supabase" ]]; then
  SUPABASE_BIN="$ROOT/node_modules/.bin/supabase"
else
  SUPABASE_BIN="npx --yes supabase@2"
fi

# `pnpm` may only be present through the repository's shim (a wrapper around
# corepack) rather than a global install. Put that on PATH before deciding.
if ! command -v pnpm >/dev/null 2>&1 && [[ -x "$ROOT/.bin/pnpm" ]]; then
  PATH="$ROOT/.bin:$PATH"
fi

# Or it may only be reachable through corepack's shims directory, which a global
# npm install of corepack places next to `corepack` itself. That directory is not
# on PATH in every shell — notably a non-login shell in a container — so a deploy
# used to die with "pnpm: command not found" *after* the stack was already up.
# Derive the directory from `corepack` rather than assuming a global prefix.
if ! command -v pnpm >/dev/null 2>&1; then
  corepack_bin="$(command -v corepack 2>/dev/null || true)"
  if [[ -n "$corepack_bin" ]]; then
    PATH="$(dirname "$corepack_bin"):$PATH"
  fi
fi

mkdir -p "$LOG_DIR"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  xx\033[0m %s\n' "$*" >&2; exit 1; }

# Read a key from `.env`, falling back to a default, for values the build needs
# but the shell does not export.
env_value() {
  local key="$1" fallback="$2" line
  line="$(grep "^${key}=" .env 2>/dev/null | tail -1)"
  if [[ -n "$line" ]]; then printf '%s' "${line#*=}"; else printf '%s' "$fallback"; fi
}

wait_for_http() {
  local url="$1" tries="${2:-60}" i=0
  while (( i < tries )); do
    if curl -s -m 3 -o /dev/null "$url"; then return 0; fi
    sleep 2; i=$((i + 1))
  done
  return 1
}

# Which process owns a listening TCP port, read from /proc so it works where
# `ss`/`lsof` are absent (they are not installed on every host). Parsing the
# hex socket table is exact: the listen state is 0A, `ss -ltnp` semantics.
# Prints the pid, `?` when a listener exists that this user may not inspect
# (a root-owned process: its /proc/<pid>/fd is unreadable), or nothing when the
# port is free. The distinction matters -- "held by someone I cannot see" is a
# different fact from "nobody is on it", and only the latter is safe to start on.
port_holder() {
  local port="$1" hex inode pid fd
  printf -v hex '%04X' "$port"
  inode="$(awk -v h=":$hex" '$2 ~ h"$" && $4 == "0A" {print $10; exit}' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null)"
  [[ -n "$inode" ]] || return 0
  for fd in /proc/[0-9]*/fd/*; do
    if [[ "$(readlink "$fd" 2>/dev/null)" == "socket:[$inode]" ]]; then
      pid="${fd#/proc/}"; printf '%s' "${pid%%/*}"; return 0
    fi
  done
  printf '?'
}

# Prove the process that is answering a loopback port is the one we just
# started, not a stale copy still holding it. Two failures conspired to make the
# deploy lie: a service that could not bind (EADDRINUSE) dies, while the health
# probe answers from the *old* process on the same port -- so `wait_for_http`
# passed and the deploy printed `ok`. When the holder is root-owned, `pkill`
# cannot signal it either, so it survives every restart. This check reads the
# truth: the port's owner must be the started pid (or its child).
assert_port_owner() {
  local name="$1" port="$2" holder started
  holder="$(port_holder "$port")"
  started="$(cat "$RUN_DIR/$name.pid" 2>/dev/null)"
  if [[ -z "$holder" ]]; then
    # The service may take a moment to bind after its health answer (a proxy can
    # answer while its own listener is still coming up); retry briefly.
    local i=0
    while [[ -z "$holder" ]] && (( i < 10 )); do
      sleep 0.3; holder="$(port_holder "$port")"; i=$((i + 1))
    done
  fi
  if [[ -z "$holder" ]]; then
    warn "no process is listening on :$port for $name"
    return 0
  fi
  if [[ "$holder" == "$started" || "$holder" == "$(awk '{print $4}' "/proc/$started/stat" 2>/dev/null)" ]]; then
    ok "$name owns :$port (pid $holder)"
    return 0
  fi
  die "$name did not take :$port -- pid $holder is holding it (this user cannot read its command line, which means it is another user's, and pkill cannot signal it). Stop that process and redeploy."
}

# --- 1. Docker ---------------------------------------------------------------
ensure_docker() {
  if docker info >/dev/null 2>&1; then ok "docker is running"; return; fi
  # The daemon may be up while this user cannot read its socket (not in the
  # `docker` group -- the normal state on a fresh host). Reaching it is the real
  # question, so probe the socket and, with passwordless sudo, grant access
  # rather than trying to start a second daemon that would fail on the same
  # socket.
  if sudo -n true 2>/dev/null && sudo test -S /var/run/docker.sock 2>/dev/null; then
    say "the Docker socket is not readable by $(id -un); granting access"
    sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
    if docker info >/dev/null 2>&1; then ok "docker is reachable"; return; fi
  fi
  say "starting the Docker daemon"
  if ! sudo -n true 2>/dev/null; then
    die "The Docker daemon is not running and sudo needs a password. Start it, then re-run."
  fi
  sudo nohup dockerd >"$LOG_DIR/dockerd.log" 2>&1 &
  for _ in $(seq 1 30); do
    sleep 1
    if docker info >/dev/null 2>&1; then ok "docker started"; return; fi
  done
  sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
  if docker info >/dev/null 2>&1; then ok "docker started"; return; fi
  die "The Docker daemon did not come up. See $LOG_DIR/dockerd.log"
}

# --- 2. Environment ----------------------------------------------------------
ensure_env() {
  if [[ -f .env ]]; then ok ".env already present"; else
    say "creating .env from .env.example"
    cp .env.example .env
  fi

  # The control plane is the local Supabase stack unless the operator pointed
  # SUPABASE_URL somewhere else. The keys below are the stack's public demo keys,
  # which are correct for a local deployment and are not secrets in that context.
  local url="${SUPABASE_URL:-http://127.0.0.1:${SUPABASE_PORT}}"
  set_env() {
    local key="$1" val="$2"
    if grep -q "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${val}|" .env
    else
      printf '%s=%s\n' "$key" "$val" >>.env
    fi
  }

  # `supabase status -o env` prints JSON on recent CLI versions and KEY="value"
  # lines on older ones. Parse whichever comes back.
  # `supabase status` loads .env as a dotenv file and refuses keys it deems
  # invalid — the per-organization keys this product uses carry a UUID suffix
  # (`COOLIFY_TOKEN__<organizationId>`), whose hyphens an upstream dotenv parser
  # rejects, so status would fail on an otherwise valid .env. Read it from a
  # directory that symlinks config/ but has no .env, so the keys are still read.
  local status_dir="" status_out svc_key anon_key
  if [[ -d supabase ]] && [[ -z "${SUPABASE_CONFIG_DIR:-}" ]]; then
    status_dir="$(mktemp -d)"
    ln -s "$PWD/supabase" "$status_dir/supabase"
  fi
  status_out="$(cd "${SUPABASE_CONFIG_DIR:-${status_dir:-$PWD}}" && $SUPABASE_BIN status -o env 2>/dev/null)"
  [[ -n "$status_dir" ]] && rm -rf "$status_dir"
  svc_key="$(printf '%s' "$status_out" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      const trimmed=d.trim();
      if (trimmed.startsWith("{")) { try { console.log(JSON.parse(trimmed).SERVICE_ROLE_KEY||""); return; } catch {} }
      const line=trimmed.split("\n").find(l=>l.startsWith("SERVICE_ROLE_KEY="));
      console.log(line ? line.slice(line.indexOf("=")+1).replace(/"/g,"") : "");
    });')"
  anon_key="$(printf '%s' "$status_out" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      const trimmed=d.trim();
      if (trimmed.startsWith("{")) { try { console.log(JSON.parse(trimmed).ANON_KEY||""); return; } catch {} }
      const line=trimmed.split("\n").find(l=>l.startsWith("ANON_KEY="));
      console.log(line ? line.slice(line.indexOf("=")+1).replace(/"/g,"") : "");
    });')"
  [[ -z "$svc_key" ]] && die "Could not read the Supabase keys. Is the stack running (supabase start)?"

  set_env SUPABASE_URL "$url"
  set_env SUPABASE_ANON_KEY "$anon_key"
  set_env SUPABASE_SERVICE_ROLE_KEY "$svc_key"
  set_env HOST "127.0.0.1"
  set_env PORT "$API_PORT"
  set_env NODE_ENV "production"

  # No key means no encrypted secret is storable, so env vars and git webhooks
  # would answer engine_unavailable. Generate one once and keep it stable.
  local existing
  existing="$(grep '^CLOUD_WAI_SECRET_ENCRYPTION_KEY=' .env | cut -d= -f2- || true)"
  if [[ -z "$existing" ]]; then
    set_env CLOUD_WAI_SECRET_ENCRYPTION_KEY \
      "$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")"
    ok "generated CLOUD_WAI_SECRET_ENCRYPTION_KEY"
  fi
  ok ".env configured for $url"
}

# --- 3. Control plane --------------------------------------------------------
ensure_supabase() {
  if curl -s -m 3 -o /dev/null "http://127.0.0.1:${SUPABASE_PORT}/auth/v1/health"; then
    ok "supabase is already up"
    return
  fi
  say "starting the Supabase stack (first run pulls images; this can take a while)"
  # `supabase start` loads `.env` as a dotenv file too, and rejects it for the
  # same reason `status` does: the per-organization keys this product writes
  # there carry a UUID suffix (`COOLIFY_TOKEN__<organizationId>`) whose hyphens
  # an upstream parser refuses. The stack does not read those keys — the control
  # plane does, from the real `.env` — so start it from a directory that has
  # `supabase/` but no `.env`, exactly as the status probe below does.
  local start_dir="" start_cwd
  if [[ -d supabase ]] && [[ -z "${SUPABASE_CONFIG_DIR:-}" ]] && [[ -f .env ]]; then
    start_dir="$(mktemp -d)"
    ln -s "$PWD/supabase" "$start_dir/supabase"
  fi
  start_cwd="${SUPABASE_CONFIG_DIR:-${start_dir:-$PWD}}"
  setsid nohup bash -c "cd '$start_cwd' && exec $SUPABASE_BIN start" \
    >"$LOG_DIR/supabase.log" 2>&1 </dev/null &
  if ! wait_for_http "http://127.0.0.1:${SUPABASE_PORT}/auth/v1/health" 180; then
    tail -20 "$LOG_DIR/supabase.log" >&2
    die "Supabase did not become healthy. See $LOG_DIR/supabase.log"
  fi
  ok "supabase is up"
}

ensure_container_network() {
  # Containers egress onto this host's overlay uplink. When the host MTU is
  # below the 1500 a fresh Docker network assumes, packets larger than the
  # path MTU are blackholed instead of fragmented, so `git clone` of any
  # non-trivial repository dies at `Recv failure: Connection reset by peer`.
  # Clamping the TCP MSS to the path MTU keeps the connection alive without
  # changing container settings or recreating networks that hold live state.
  sudo -n true 2>/dev/null || { warn "no passwordless sudo; skipping the container MTU fix"; return; }
  if sudo iptables -t mangle -C FORWARD -p tcp --tcp-flags SYN,RST SYN \
      -j TCPMSS --clamp-mss-to-pmtu >/dev/null 2>&1; then
    ok "container MSS clamp already present"
    return
  fi
  sudo iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN \
    -j TCPMSS --clamp-mss-to-pmtu \
    && ok "clamped container MSS to the path MTU" \
    || warn "could not add the container MSS clamp"
}

ensure_builder() {
  # The build plane (ADR-0018) runs as a container because it needs the Nixpacks
  # binary and the Docker socket; the API and worker run as host processes. It is
  # optional: with no BUILDER_TOKEN the build adapter stays `not_configured` and
  # a serverless deploy stops honestly rather than inventing an artifact.
  local token
  token="$(grep '^BUILDER_TOKEN=' .env | cut -d= -f2- || true)"
  if [[ -z "$token" ]]; then
    token="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
    # `set_env` is scoped to ensure_env; write the key here directly.
    if grep -q '^BUILDER_TOKEN=' .env; then
      sed -i "s|^BUILDER_TOKEN=.*|BUILDER_TOKEN=${token}|" .env
    else
      printf 'BUILDER_TOKEN=%s\n' "$token" >>.env
    fi
    ok "generated BUILDER_TOKEN"
  fi
  say "starting the build plane"
  if ! docker compose -f infra/deployment/docker-compose.yml --profile build up -d --build builder \
      >>"$LOG_DIR/builder.log" 2>&1; then
    warn "the builder did not start; continuing without a build plane (builds stay not_configured)"
    return
  fi
  if ! wait_for_http "http://127.0.0.1:8090/healthz" 60; then
    warn "the builder did not become healthy; builds stay not_configured until it does"
    return
  fi
  ok "builder on 127.0.0.1:8090"
  # Wire the builder to every organization already in the control plane, so an
  # existing tenant gains the build engine. New organizations are wired the same
  # way after they are created (see docs/runbooks/build-plane.md).
  local orgs
  # `</dev/null`: the command is inside a pipeline substitution, but `docker
  # exec -i` still opens the controlling terminal for its own stdin. A deploy
  # started in the background has none, so the read raises SIGTTIN and the whole
  # deploy is *suspended* indefinitely -- the build plane never returns. Redirect
  # stdin from /dev/null so the exec never tries to read the terminal.
  orgs="$(docker exec -i "$(docker ps --filter name=supabase_db_ --format '{{.Names}}' 2>/dev/null | head -1)" \
    psql -U postgres -d postgres -tAc "select id from organizations" </dev/null 2>/dev/null | tr -d ' ' || true)"
  local org wired=0
  for org in $orgs; do
    [[ -n "$org" ]] || continue
    if ! grep -q "^BUILD_ENGINE_TOKEN__${org}=" .env; then
      printf 'BUILD_ENGINE_URL__%s=http://127.0.0.1:8090\nBUILD_ENGINE_TOKEN__%s=%s\n' "$org" "$org" "$token" >>.env
      wired=$((wired + 1))
    fi
  done
  [[ "$wired" -gt 0 ]] && ok "wired the builder to $wired organization(s)"
  return 0
}

ensure_runtime() {
  # The self-hosted runtime engine: this deployment's own container runtime. It
  # is what makes a `container` project actually deploy — it drives the build
  # plane and runs the resulting image, the piece Coolify used to provide. It
  # needs the Docker socket for the same reason the builder does, so both run as
  # containers while the API and worker stay host processes.
  #
  # Its credential is per organization (RUNTIME_TOKEN__<orgId>), reached at
  # RUNTIME_URL. The token is the boundary; a deployment that needs a hard
  # runtime boundary runs one runtime per tenant and points each org at its own.
  local token
  token="$(grep '^RUNTIME_TOKEN=' .env | cut -d= -f2- || true)"
  if [[ -z "$token" ]]; then
    token="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
    if grep -q '^RUNTIME_TOKEN=' .env; then
      sed -i "s|^RUNTIME_TOKEN=.*|RUNTIME_TOKEN=${token}|" .env
    else
      printf 'RUNTIME_TOKEN=%s\n' "$token" >>.env
    fi
    ok "generated RUNTIME_TOKEN"
  fi
  # The runtime drives the build plane, so it needs the same token the builder
  # accepts. Read it back from .env (ensure_builder wrote it) so the two agree.
  local builder_token
  builder_token="$(grep '^BUILDER_TOKEN=' .env | cut -d= -f2- || true)"

  say "starting the self-hosted runtime engine"
  local runtime_url="http://127.0.0.1:${RUNTIME_PORT}"
  if ! docker compose -f infra/deployment/docker-compose.yml --profile runtime up -d --build runtime \
      >>"$LOG_DIR/runtime.log" 2>&1; then
    warn "the runtime did not start; container deploys stay not_configured"
    return
  fi
  if ! wait_for_http "${runtime_url}/healthz" 60; then
    warn "the runtime did not become healthy; container deploys stay not_configured until it does"
    return
  fi
  ok "runtime on ${runtime_url}"
  if grep -q '^RUNTIME_URL=' .env; then
    sed -i "s|^RUNTIME_URL=.*|RUNTIME_URL=${runtime_url}|" .env
  else
    printf 'RUNTIME_URL=%s\n' "$runtime_url" >>.env
  fi
  # The hostname an app URL carries. The runtime's own default is 127.0.0.1,
  # which is right only when a browser runs on the host itself; behind a public
  # host it is unreachable. Prefer an explicit override, then the host's own
  # public URL, then loopback.
  if ! grep -q '^RUNTIME_PUBLIC_HOST=' .env; then
    local public_host="${CLOUD_WAI_PUBLIC_HOST:-}"
    if [[ -z "$public_host" && -n "${PUBLIC_SUPABASE_URL:-}" ]]; then
      public_host="${PUBLIC_SUPABASE_URL#*://}"
      public_host="${public_host%%/*}"
      public_host="${public_host%%:*}"
    fi
    [[ -z "$public_host" ]] && public_host="127.0.0.1"
    printf 'RUNTIME_PUBLIC_HOST=%s\n' "$public_host" >>.env
    ok "runtime app URLs will use ${public_host}"
  fi
  # The suffix a deployed app's default hostname is minted under, the way Vercel
  # gives every deployment a `<project>.vercel.app` address. It is written only
  # when the operator names a domain whose wildcard already resolves to this
  # host (`CLOUD_WAI_APP_DOMAIN=apps.example.com`); without one the runtime mints
  # no default hostname, so it never advertises a name that does not resolve.
  if ! grep -q '^RUNTIME_DEFAULT_DOMAIN_SUFFIX=' .env; then
    local app_domain="${CLOUD_WAI_APP_DOMAIN:-}"
    if [[ -n "$app_domain" ]]; then
      printf 'RUNTIME_DEFAULT_DOMAIN_SUFFIX=%s\n' "$app_domain" >>.env
      ok "deployed apps will be reachable at <app>.${app_domain}"
    fi
  fi
  # Wire the runtime to every organization already in the control plane, so an
  # existing tenant gains the container engine. New organizations are wired the
  # same way after they are created.
  local orgs org wired=0
  orgs="$(docker exec -i "$(docker ps --filter name=supabase_db_ --format '{{.Names}}' 2>/dev/null | head -1)" \
    psql -U postgres -d postgres -tAc "select id from organizations" </dev/null 2>/dev/null | tr -d ' ' || true)"
  for org in $orgs; do
    [[ -n "$org" ]] || continue
    if ! grep -q "^RUNTIME_TOKEN__${org}=" .env; then
      printf 'RUNTIME_TOKEN__%s=%s\n' "$org" "$token" >>.env
      wired=$((wired + 1))
    fi
  done
  [[ "$wired" -gt 0 ]] && ok "wired the runtime to $wired organization(s)"
  return 0
}

ensure_router() {
  # The router — this deployment's own front door (ADR-0021). It maps a verified
  # hostname to a deployed app's loopback port and terminates TLS, so a domain
  # that verifies is actually reachable. It shares the host's loopback with the
  # runtime (compose `network_mode: host`), so the `127.0.0.1:<port>` upstreams
  # the runtime publishes are addresses the router can reach.
  #
  # It runs under the `edge` profile and is optional: a host that fronts its apps
  # with another proxy (or HTTP-01 is impossible behind a TLS-terminating load
  # balancer) leaves it off, and the runtime still deploys — its domains are then
  # reported as not yet routable, never as reachable.
  local token
  token="$(grep '^ROUTER_TOKEN=' .env | cut -d= -f2- || true)"
  if [[ -z "$token" ]]; then
    token="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
    if grep -q '^ROUTER_TOKEN=' .env; then
      sed -i "s|^ROUTER_TOKEN=.*|ROUTER_TOKEN=${token}|" .env
    else
      printf 'ROUTER_TOKEN=%s\n' "$token" >>.env
    fi
    ok "generated ROUTER_TOKEN"
  fi

  say "starting the router"
  local router_url="http://127.0.0.1:${ROUTER_ADMIN_PORT:-8096}"
  if ! docker compose -f infra/deployment/docker-compose.yml --profile edge up -d --build router \
      >>"$LOG_DIR/router.log" 2>&1; then
    warn "the router did not start; verified domains stay unreachable until it does"
    return
  fi
  if ! wait_for_http "${router_url}/healthz" 60; then
    warn "the router did not become healthy; verified domains stay unreachable until it does"
    return
  fi
  ok "router on ${router_url}"
  if grep -q '^ROUTER_URL=' .env; then
    sed -i "s|^ROUTER_URL=.*|ROUTER_URL=${router_url}|" .env
  else
    printf 'ROUTER_URL=%s\n' "$router_url" >>.env
  fi
  return 0
}


apply_migrations() {
  # `supabase start` already applies supabase/migrations on a fresh stack, so this
  # only catches migrations added since. It never resets, so a redeploy does not
  # destroy control-plane data.
  say "applying any migrations added since the stack started"
  if $SUPABASE_BIN migration up >>"$LOG_DIR/supabase.log" 2>&1; then
    ok "migrations applied"
    return
  fi
  # The CLI talks to the database over the host-published 54322 port, which a
  # container restart can leave unmapped while the stack itself is healthy. Fall
  # back to the database container's own psql, applying only the files whose
  # version is not yet recorded, so a redeploy of an unchanged schema is a no-op.
  local db_container
  db_container="$(docker ps --filter name=supabase_db_ --format '{{.Names}}' 2>/dev/null | head -1)"
  [[ -n "$db_container" ]] || die "Migrations failed and no Supabase DB container was found. See $LOG_DIR/supabase.log"

  warn "CLI could not reach the database port; applying migrations through $db_container"
  local applied file version
  applied="$(docker exec "$db_container" psql -U postgres -d postgres -tAc \
    'select version from supabase_migrations.schema_migrations' 2>/dev/null | tr -d ' ')"
  for file in supabase/migrations/*.sql; do
    [[ -e "$file" ]] || continue
    version="$(basename "$file")"
    version="${version%%_*}"
    if printf '%s\n' "$applied" | grep -qx "$version"; then continue; fi
    say "  applying $(basename "$file")"
    docker exec -i "$db_container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
      <"$file" >>"$LOG_DIR/supabase.log" 2>&1 \
      || die "Migration $(basename "$file") failed. See $LOG_DIR/supabase.log"
    docker exec "$db_container" psql -U postgres -d postgres -tAc \
      "insert into supabase_migrations.schema_migrations(version) values ('$version') on conflict do nothing" \
      </dev/null >>"$LOG_DIR/supabase.log" 2>&1
  done
  ok "migrations applied"
}

# --- 4. Build ----------------------------------------------------------------
build() {
  say "installing dependencies"
  # A deploy is non-interactive: there is no TTY to answer pnpm's "remove and
  # reinstall node_modules?" prompt, and the answer it never gets aborts the
  # install with EBADF. CI=1 makes pnpm take the affirmative path itself.
  CI=1 pnpm install --frozen-lockfile >"$LOG_DIR/install.log" 2>&1 || die "pnpm install failed. See $LOG_DIR/install.log"

  say "building the workspaces"
  pnpm build >"$LOG_DIR/build.log" 2>&1 || die "Build failed. See $LOG_DIR/build.log"

  say "building the dashboard with public values"
  # The browser reaches Supabase through the gateway proxy origin, so that is the
  # URL compiled into the bundle. The API stays same-origin, so its base URL is
  # left empty and the edge server proxies /rpc.
  local anon public_supabase
  anon="$(grep '^SUPABASE_ANON_KEY=' .env | cut -d= -f2-)"
  public_supabase="${PUBLIC_SUPABASE_URL:-$(env_value PUBLIC_SUPABASE_URL "http://127.0.0.1:${GATEWAY_PORT}")}"
  # Temporary no-login bypass. Only the *flag* is compiled into the bundle; the
  # demo email and password stay in the API process's environment and are never
  # shipped to a browser. Read from the shell first, then `.env`, so a plain
  # `deploy.sh deploy` honours the values the operator already wrote there
  # instead of silently building with the bypass off.
  local demo_autologin
  demo_autologin="${DEMO_AUTOLOGIN:-$(env_value DEMO_AUTOLOGIN 0)}"
  VITE_SUPABASE_URL="$public_supabase" \
  VITE_SUPABASE_ANON_KEY="$anon" \
  VITE_CLOUD_WAI_API_URL="" \
  VITE_CLOUD_WAI_DEMO_AUTOLOGIN="$demo_autologin" \
    pnpm --filter @cloud-wai/web build:web >"$LOG_DIR/webbuild.log" 2>&1 \
    || die "Dashboard build failed. See $LOG_DIR/webbuild.log"
  ok "build complete"
}

# Export every key in .env over the ambient environment.
#
# Node's `--env-file` (and docker compose's `${VAR}` interpolation) let a
# variable that already exists in the environment win over the file. A host is
# free to define any name we do — this deployment's own sandbox exports
# `RUNTIME_URL` to mean "the OpenHands runtime", a different thing from our
# self-hosted container engine — so `RUNTIME_URL=http://127.0.0.1:8095` in .env
# was silently shadowed by the host's `https://<host>` and every deploy asked
# the wrong server for `/apps` (404). Read the file back with the file winning,
# so what the operator wrote is what the processes get.
export_env_authoritative() {
  local key val
  while IFS= read -r line; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="${line#*=}"
    export "$key=$val"
  done <.env
}

# Generate the shared service tokens once, before any container starts, and
# export them.
#
# Compose resolves `environment: ROUTER_TOKEN: ${ROUTER_TOKEN:-}` against the
# *shell*, and a key written to .env after compose runs is invisible to it, so
# the empty default overrode the file and the router refused to boot
# unauthenticated. Generate here so every service's interpolation sees the token.
ensure_infra_tokens() {
  local name token
  for name in BUILDER_TOKEN RUNTIME_TOKEN ROUTER_TOKEN; do
    token="$(grep "^${name}=" .env | cut -d= -f2- || true)"
    if [[ -z "$token" ]]; then
      token="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
      if grep -q "^${name}=" .env; then
        sed -i "s|^${name}=.*|${name}=${token}|" .env
      else
        printf '%s=%s\n' "$name" "$token" >>.env
      fi
      ok "generated ${name}"
    fi
    export "$name=$token"
  done
}

# --- 5. Processes ------------------------------------------------------------
# setsid detaches each process from this shell, so a deploy started over SSH
# survives the session that started it.
#
# A setsid child is *not* the process we want to track. `setsid` forks a new
# session leader and the parent exits, so `$!` names a process that may already
# be gone (or, on some hosts, a different one entirely) while the real service
# runs on. Recording it made `status` report a live service as "down" and left
# `down`/restart unable to stop it — the pid the shell could signal was not the
# pid the service held. The wrapper writes *its own* pid — the setsid child,
# which `exec`s the service so the two are one process — to the pidfile.
start_process() {
  local name="$1"; shift
  stop_process "$name"
  local pidfile="$RUN_DIR/$name.pid" quoted
  printf -v quoted ' %q' "$@"
  setsid nohup bash -c "echo \$\$ >'$pidfile'; exec${quoted}" \
    >"$LOG_DIR/$name.log" 2>&1 </dev/null &
  local i=0
  while [[ ! -s "$pidfile" ]] && (( i < 50 )); do sleep 0.1; i=$((i + 1)); done
}

# Stop by the recorded pid, and if it survives (or the pidfile is stale), sweep
# the exact command line so a deploy cannot leave a second copy holding a port.
stop_process() {
  local name="$1" pid i=0
  [[ -f "$RUN_DIR/$name.pid" ]] || { sweep_process "$name"; return 0; }
  pid="$(cat "$RUN_DIR/$name.pid")"
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null
    while kill -0 "$pid" 2>/dev/null && (( i < 40 )); do sleep 0.25; i=$((i + 1)); done
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$RUN_DIR/$name.pid"
  sweep_process "$name"
}

# A last resort for a process whose pidfile was lost: match the service's own
# command line, never a broad keyword, so an unrelated `node` is never killed.
sweep_process() {
  local name="$1" pattern
  case "$name" in
    api)     pattern="apps/api/dist/main.js" ;;
    worker)  pattern="apps/worker/dist/main.js" ;;
    edge)    pattern="infra/deployment/edge-server.mjs" ;;
    gateway) pattern="infra/deployment/gateway-proxy.mjs" ;;
    *) return 0 ;;
  esac
  # Only this user's own processes. A `sudo pkill` here would reach a process
  # the caller never started -- including, when the test suite runs the real
  # snippet, the live deployment on the host. A leftover owned by another user
  # is left for `assert_port_owner` to name and the operator to remove.
  pkill -f "$pattern" 2>/dev/null || true
}

start_all() {
  say "starting the API and worker"
  start_process api node --env-file=.env apps/api/dist/main.js
  wait_for_http "http://127.0.0.1:${API_PORT}/healthz" 30 \
    || { tail -20 "$LOG_DIR/api.log" >&2; die "The API did not become healthy."; }
  assert_port_owner api "$API_PORT"

  start_process worker node --env-file=.env apps/worker/dist/main.js
  ok "worker draining the orchestration queue"

  say "starting the public origins"
  EDGE_PORT="$DASHBOARD_PORT" API_UPSTREAM="http://127.0.0.1:${API_PORT}" \
    start_process edge node infra/deployment/edge-server.mjs
  assert_port_owner edge "$DASHBOARD_PORT"
  GATEWAY_PORT="$GATEWAY_PORT" SUPABASE_UPSTREAM="http://127.0.0.1:${SUPABASE_PORT}" \
    start_process gateway node infra/deployment/gateway-proxy.mjs
  assert_port_owner gateway "$GATEWAY_PORT"

  wait_for_http "http://127.0.0.1:${DASHBOARD_PORT}/healthz" 20 \
    || die "The dashboard origin did not come up."
  wait_for_http "http://127.0.0.1:${GATEWAY_PORT}/auth/v1/health" 20 \
    || die "The gateway origin did not come up."
  ok "dashboard + api on :${DASHBOARD_PORT}"
  ok "supabase gateway on :${GATEWAY_PORT}"
}

# --- Demo tenant -------------------------------------------------------------
# The pre-launch no-login bypass (DEMO_AUTOLOGIN=1) signs the visitor in with
# `demo.session`, which performs a real password grant for DEMO_EMAIL. On a
# fresh stack that account does not exist, so the grant fails, `demo.session`
# answers 502 and the dashboard sits on "Connecting to Cloud Wai…" forever --
# the bypass silently does not work on the very host it was built for. Seed the
# account and a demo organization here so the one-command deploy leaves a
# working product. It is idempotent: an existing user or organization is left
# alone.
ensure_demo_tenant() {
  local enabled email password role
  enabled="$(env_value DEMO_AUTOLOGIN 0)"
  [[ "$enabled" == "1" ]] || return 0
  email="$(env_value DEMO_EMAIL "")"
  password="$(env_value DEMO_PASSWORD "")"
  if [[ -z "$email" || -z "$password" ]]; then
    warn "DEMO_AUTOLOGIN=1 but DEMO_EMAIL/DEMO_PASSWORD are unset; the dashboard will not auto-enter"
    return 0
  fi
  # The demo membership is a *viewer* by default, deliberately not an owner.
  # `demo.session` hands a session to any unauthenticated caller, so the seeded
  # account must not carry authority a stranger could use: an owner demo account
  # is a full tenant takeover behind a courtesy rate limit. A viewer sees every
  # screen and can change nothing. An operator who wants the demo to *show* a
  # deploy sets `DEMO_MEMBER_ROLE=member` (never `owner`).
  role="$(env_value DEMO_MEMBER_ROLE viewer)"
  case "$role" in
    viewer | member | admin) ;;
    *)
      warn "DEMO_MEMBER_ROLE='$role' is not a role; using viewer"
      role="viewer"
      ;;
  esac
  if [[ "$role" == "owner" ]]; then
    warn "DEMO_MEMBER_ROLE=owner would hand an owner session to any caller; using viewer"
    role="viewer"
  fi

  local svc uid
  svc="$(env_value SUPABASE_SERVICE_ROLE_KEY "")"
  [[ -n "$svc" ]] || { warn "no service-role key; cannot seed the demo tenant"; return 0; }

  say "seeding the demo tenant"
  # Create the user if it is absent. A duplicate is fine: the admin endpoint
  # answers 422 and we fall through to look the id up.
  uid="$(curl -s -X POST "http://127.0.0.1:${SUPABASE_PORT}/auth/v1/admin/users" \
    -H "apikey: ${svc}" -H "Authorization: Bearer ${svc}" -H 'content-type: application/json' \
    -d "{\"email\":\"${email}\",\"password\":\"${password}\",\"email_confirm\":true,\"user_metadata\":{\"display_name\":\"Demo Owner\"}}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.id||"")}catch{console.log("")}})')"
  if [[ -z "$uid" ]]; then
    uid="$(curl -s "http://127.0.0.1:${SUPABASE_PORT}/auth/v1/admin/users?per_page=200" \
      -H "apikey: ${svc}" -H "Authorization: Bearer ${svc}" \
      | EMAIL="$email" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const u=(j.users||[]).find(x=>x.email===process.env.EMAIL);console.log(u?u.id:"")}catch{console.log("")}})')"
  fi
  [[ -n "$uid" ]] || { warn "could not create or find the demo user"; return 0; }

  # The organization and the owner membership. Written through the database
  # container's own psql so the seed does not depend on PostgREST's RLS or a
  # published port.
  local db
  db="$(docker ps --filter name=supabase_db_ --format '{{.Names}}' 2>/dev/null | head -1)"
  [[ -n "$db" ]] || { warn "no Supabase database container; demo tenant not seeded"; return 0; }
  docker exec -i "$db" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v uid="$uid" -v role="$role" </dev/null \
    >>"$LOG_DIR/supabase.log" 2>&1 <<'SQL' \
    || { warn "demo tenant seed failed; see $LOG_DIR/supabase.log"; return 0; }
insert into organizations (id, name, slug, created_by)
values ('11111111-1111-1111-1111-111111111111', 'Demo Organization', 'demo-org', :'uid')
on conflict (id) do nothing;
insert into organization_members (organization_id, user_id, role)
values ('11111111-1111-1111-1111-111111111111', :'uid', :'role')
on conflict (organization_id, user_id) do update set role = excluded.role;
SQL
  ok "demo tenant ready ($email, role $role)"
}

# --- Commands ----------------------------------------------------------------
# `kill -0` succeeds against a zombie: a process whose parent was reaped by init
# still answers the zero signal, so `status` called a dead service "up". A pid
# in the Z state is dead for every purpose we care about, so it is reported as
# down. This is the same failure the pidfile bug produced, reached from the
# other side.
process_is_live() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ "$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)" != "Z" ]]
}

cmd_status() {
  printf 'processes\n'
  for name in api worker edge gateway; do
    if process_is_live "$(cat "$RUN_DIR/$name.pid" 2>/dev/null)"; then
      printf '  %-8s up (pid %s)\n' "$name" "$(cat "$RUN_DIR/$name.pid")"
    else
      printf '  %-8s down\n' "$name"
    fi
  done
  printf 'origins\n'
  for probe in "dashboard http://127.0.0.1:${DASHBOARD_PORT}/" \
               "api       http://127.0.0.1:${DASHBOARD_PORT}/healthz" \
               "gateway   http://127.0.0.1:${GATEWAY_PORT}/auth/v1/health"; do
    set -- $probe
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$2")"
    printf '  %-8s %s\n' "$1" "$code"
  done
  # An origin can answer from a process this user did not start (a stale,
  # root-owned copy), which is exactly the lie `status` used to tell. Name the
  # real owner so "up" is never assumed from a probe alone.
  printf 'ports\n'
  for probe in "api ${API_PORT}" "edge ${DASHBOARD_PORT}" "gateway ${GATEWAY_PORT}"; do
    set -- $probe
    holder="$(port_holder "$2")"
    started="$(cat "$RUN_DIR/$1.pid" 2>/dev/null)"
    if [[ -z "$holder" ]]; then
      printf '  %-8s :%s free\n' "$1" "$2"
    elif [[ "$holder" == "?" ]]; then
      printf '  %-8s :%s held by a process this user cannot inspect\n' "$1" "$2"
    elif [[ "$holder" == "$started" ]]; then
      printf '  %-8s :%s pid %s (ours)\n' "$1" "$2" "$holder"
    else
      printf '  %-8s :%s pid %s (not the recorded pid %s)\n' "$1" "$2" "$holder" "${started:-none}"
    fi
  done
}

cmd_down() {
  for name in edge gateway worker api; do
    stop_process "$name" && ok "stopped $name"
  done
  warn "Supabase left running; stop it with 'supabase stop' if you want it gone."
}

cmd_deploy() {
  say "Cloud Wai deploy"
  ensure_docker
  ensure_container_network
  ensure_supabase
  ensure_env
  export_env_authoritative
  ensure_infra_tokens
  apply_migrations
  ensure_builder
  ensure_runtime
  ensure_router
  build
  start_all
  ensure_demo_tenant
  echo
  cmd_status
  echo
  say "Done. The dashboard is live on port ${DASHBOARD_PORT}; Supabase gateway on ${GATEWAY_PORT}."
  echo "  In this environment the public URLs are the work hosts mapped to those ports."
}

case "${1:-deploy}" in
  deploy) cmd_deploy ;;
  status) cmd_status ;;
  down)   cmd_down ;;
  *) die "Usage: $0 [deploy|status|down]" ;;
esac
