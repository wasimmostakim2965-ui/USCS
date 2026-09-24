#!/usr/bin/env bash
# Prove the control-plane RLS policies against a real PostgreSQL.
#
# Boots a throwaway Postgres, applies the auth shim (auth.uid() + Supabase
# roles), applies both migrations, then runs the two-organization isolation
# probe. Any cross-tenant read or write, any client-side deployment-status
# change, and any readable API-key hash makes the probe fail.
#
# Requires a working Docker daemon. DOCKER may be overridden, e.g.
# DOCKER="sudo docker" ./scripts/verify-rls.sh in environments where the socket
# is root-owned.
#
# If Docker is unavailable, point the script at an existing empty PostgreSQL
# with CLOUDWAI_RLS_DSN (a libpq connection string). That path is used in CI
# images and sandboxes where a daemon cannot run, and it runs the same SQL, so
# it is the same proof — only the way the server is obtained differs.

set -euo pipefail

DOCKER="${DOCKER:-docker}"
CONTAINER="${CONTAINER:-cw-rls-verify}"
IMAGE="${IMAGE:-postgres:17-alpine}"
PORT="${PORT:-55432}"
DB="${DB:-cloudwai}"
DSN="${CLOUDWAI_RLS_DSN:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "$DSN" ]; then
  # Existing server: every statement is applied with psql, in order.
  run_sql() {
    local label="$1" file="$2"
    echo "== $label =="
    psql "$DSN" -v ON_ERROR_STOP=1 -q -f - <"$file"
  }

  run_sql "auth shim"            "$ROOT/tests/isolation/rls/00_auth_shim.sql"
  run_sql "schema migration"     "$ROOT/supabase/migrations/0001_control_plane.sql"
  run_sql "rls policies"         "$ROOT/supabase/migrations/0002_rls.sql"
  run_sql "job lease/idempotency" "$ROOT/supabase/migrations/0003_jobs_lease_and_idempotency.sql"
  run_sql "security policy events" "$ROOT/supabase/migrations/0004_security_policy_events.sql"
  run_sql "domain verification"  "$ROOT/supabase/migrations/0005_domain_verification.sql"
  run_sql "job queue probe"      "$ROOT/tests/isolation/rls/11_jobs_probe.sql"
  run_sql "isolation probe"      "$ROOT/tests/isolation/rls/10_isolation_probe.sql"

  echo
  echo "RLS verification complete: migrations applied, isolation probe passed."
  exit 0
fi

cleanup() {
  $DOCKER rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
echo "== booting $IMAGE =="
$DOCKER run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="$DB" \
  -p "$PORT:5432" "$IMAGE" >/dev/null

echo "== waiting for postgres =="
# pg_isready alone is racy: it can report "rejecting connections" for a moment
# while the server finishes starting up. Wait for a real query instead.
ready=0
for _ in $(seq 1 90); do
  if $DOCKER exec "$CONTAINER" psql -U postgres -d "$DB" -tAc 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: postgres did not become ready" >&2
  exit 1
fi

run_sql() {
  local label="$1" file="$2"
  echo "== $label =="
  $DOCKER exec -i "$CONTAINER" psql -U postgres -d "$DB" \
    -v ON_ERROR_STOP=1 -q -f - <"$file"
}

run_sql "auth shim"          "$ROOT/tests/isolation/rls/00_auth_shim.sql"
run_sql "schema migration"   "$ROOT/supabase/migrations/0001_control_plane.sql"
run_sql "rls policies"       "$ROOT/supabase/migrations/0002_rls.sql"
run_sql "job lease/idempotency" "$ROOT/supabase/migrations/0003_jobs_lease_and_idempotency.sql"
run_sql "security policy events" "$ROOT/supabase/migrations/0004_security_policy_events.sql"
run_sql "domain verification" "$ROOT/supabase/migrations/0005_domain_verification.sql"
run_sql "job queue probe"    "$ROOT/tests/isolation/rls/11_jobs_probe.sql"
run_sql "isolation probe"    "$ROOT/tests/isolation/rls/10_isolation_probe.sql"

echo
echo "RLS verification complete: migrations applied, isolation probe passed."
