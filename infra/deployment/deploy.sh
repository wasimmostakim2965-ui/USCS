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

# --- 1. Docker ---------------------------------------------------------------
ensure_docker() {
  if docker info >/dev/null 2>&1; then ok "docker is running"; return; fi
  say "starting the Docker daemon"
  if ! sudo -n true 2>/dev/null; then
    die "The Docker daemon is not running and sudo needs a password. Start it, then re-run."
  fi
  sudo nohup dockerd >"$LOG_DIR/dockerd.log" 2>&1 &
  for _ in $(seq 1 30); do
    sleep 1
    if docker info >/dev/null 2>&1; then ok "docker started"; return; fi
  done
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
  setsid nohup $SUPABASE_BIN start >"$LOG_DIR/supabase.log" 2>&1 </dev/null &
  if ! wait_for_http "http://127.0.0.1:${SUPABASE_PORT}/auth/v1/health" 180; then
    tail -20 "$LOG_DIR/supabase.log" >&2
    die "Supabase did not become healthy. See $LOG_DIR/supabase.log"
  fi
  ok "supabase is up"
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
      >>"$LOG_DIR/supabase.log" 2>&1
  done
  ok "migrations applied"
}

# --- 4. Build ----------------------------------------------------------------
build() {
  say "installing dependencies"
  pnpm install --frozen-lockfile >"$LOG_DIR/install.log" 2>&1 || die "pnpm install failed. See $LOG_DIR/install.log"

  say "building the workspaces"
  pnpm build >"$LOG_DIR/build.log" 2>&1 || die "Build failed. See $LOG_DIR/build.log"

  say "building the dashboard with public values"
  # The browser reaches Supabase through the gateway proxy origin, so that is the
  # URL compiled into the bundle. The API stays same-origin, so its base URL is
  # left empty and the edge server proxies /rpc.
  local anon public_supabase
  anon="$(grep '^SUPABASE_ANON_KEY=' .env | cut -d= -f2-)"
  public_supabase="${PUBLIC_SUPABASE_URL:-$(env_value PUBLIC_SUPABASE_URL "http://127.0.0.1:${GATEWAY_PORT}")}"
  # Temporary no-login bypass. Read from the shell first, then `.env`, so a
  # plain `deploy.sh deploy` honours the values the operator already wrote there
  # instead of silently building with the bypass off.
  local demo_autologin demo_email demo_password
  demo_autologin="${DEMO_AUTOLOGIN:-$(env_value DEMO_AUTOLOGIN 0)}"
  demo_email="${DEMO_EMAIL:-$(env_value DEMO_EMAIL "")}"
  demo_password="${DEMO_PASSWORD:-$(env_value DEMO_PASSWORD "")}"
  VITE_SUPABASE_URL="$public_supabase" \
  VITE_SUPABASE_ANON_KEY="$anon" \
  VITE_CLOUD_WAI_API_URL="" \
  VITE_CLOUD_WAI_DEMO_AUTOLOGIN="$demo_autologin" \
  VITE_CLOUD_WAI_DEMO_EMAIL="$demo_email" \
  VITE_CLOUD_WAI_DEMO_PASSWORD="$demo_password" \
    pnpm --filter @cloud-wai/web build:web >"$LOG_DIR/webbuild.log" 2>&1 \
    || die "Dashboard build failed. See $LOG_DIR/webbuild.log"
  ok "build complete"
}

# --- 5. Processes ------------------------------------------------------------
# setsid detaches each process from this shell, so a deploy started over SSH
# survives the session that started it.
start_process() {
  local name="$1"; shift
  stop_process "$name"
  setsid nohup "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null &
  echo $! >"$RUN_DIR/$name.pid"
}

stop_process() {
  local name="$1" pid
  [[ -f "$RUN_DIR/$name.pid" ]] || return 0
  pid="$(cat "$RUN_DIR/$name.pid")"
  kill "$pid" 2>/dev/null
  rm -f "$RUN_DIR/$name.pid"
}

start_all() {
  say "starting the API and worker"
  start_process api node --env-file=.env apps/api/dist/main.js
  wait_for_http "http://127.0.0.1:${API_PORT}/healthz" 30 \
    || { tail -20 "$LOG_DIR/api.log" >&2; die "The API did not become healthy."; }
  ok "api on 127.0.0.1:${API_PORT}"

  start_process worker node --env-file=.env apps/worker/dist/main.js
  ok "worker draining the orchestration queue"

  say "starting the public origins"
  EDGE_PORT="$DASHBOARD_PORT" API_UPSTREAM="http://127.0.0.1:${API_PORT}" \
    start_process edge node infra/deployment/edge-server.mjs
  GATEWAY_PORT="$GATEWAY_PORT" SUPABASE_UPSTREAM="http://127.0.0.1:${SUPABASE_PORT}" \
    start_process gateway node infra/deployment/gateway-proxy.mjs

  wait_for_http "http://127.0.0.1:${DASHBOARD_PORT}/healthz" 20 \
    || die "The dashboard origin did not come up."
  wait_for_http "http://127.0.0.1:${GATEWAY_PORT}/auth/v1/health" 20 \
    || die "The gateway origin did not come up."
  ok "dashboard + api on :${DASHBOARD_PORT}"
  ok "supabase gateway on :${GATEWAY_PORT}"
}

# --- Commands ----------------------------------------------------------------
cmd_status() {
  printf 'processes\n'
  for name in api worker edge gateway; do
    if [[ -f "$RUN_DIR/$name.pid" ]] && kill -0 "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null; then
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
  ensure_supabase
  ensure_env
  apply_migrations
  build
  start_all
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
