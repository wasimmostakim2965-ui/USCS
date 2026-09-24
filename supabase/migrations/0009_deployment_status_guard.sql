-- ---------------------------------------------------------------------------
-- 0009 — a deployment's status is the engine's answer, not a client's claim
--
-- 0006 brought every engine-observed column under `guard_engine_columns()` —
-- domains, data_resources, security_policies, projects — but not `deployments`.
-- That table looked safe because it has *no client-facing UPDATE policy*: the
-- comment in 0002 says status transitions are the worker's alone. Half of that
-- is true, and the half that is not is the half that matters.
--
-- RLS has no UPDATE policy, so a client cannot change an existing row. But
-- `deployments_insert` with `with check (role_at_least(...))` places no
-- constraint on the *columns* of a new row, and the table's defaults are exactly
-- the claims a dishonest writer wants to skip: `status` defaults to `pending`,
-- but nothing stops a client from supplying `status = 'succeeded'` and a
-- `url` on the INSERT itself. A deployment that is never deployed can therefore
-- be born green. `tests/isolation/rls/15_deployment_status_probe.sql`
-- reproduces it against the migrations before this file existed.
--
-- The fix is the same mechanism as 0006, for the same reason: RLS cannot say
-- "these columns are not a client's", and a column REVOKE does not compose with
-- the table-level INSERT grant the policy relies on. The trigger is per-column
-- accurate and names the invariant it protects.
--
-- Only *observations* are frozen. `id`, `idempotency_key`, `requested_by`,
-- `environment_id` and (on insert) `provider` stay a client's: they are the
-- request, not the engine's answer. `provider` is frozen on UPDATE, because
-- which engine hosts a deployment is recorded from the engine, never reassigned
-- by a browser after the fact.
-- ---------------------------------------------------------------------------

-- The engine's *deployment* handle — the uuid `GET /deployments/{uuid}` and the
-- build log are addressed by. Distinct from `provider_resource_id` (the
-- application), which is why the build-log path needs its own column: the
-- application endpoint returns the container's runtime tail, not the build.
alter table deployments
  add column if not exists deployment_resource_id text;

comment on column deployments.deployment_resource_id is
  'The hosting engine''s deployment uuid for this run, written only from the engine''s answer. Addresses the build/deploy log.';

create trigger deployments_guard_engine_columns
  before update on deployments
  for each row execute function public.guard_engine_columns(
    'status', 'url', 'provider', 'provider_resource_id', 'deployment_resource_id',
    'failure_reason', 'started_at', 'finished_at'
  );

-- On INSERT a client may name the project and its own request id, but must not
-- supply the outcome: a row is born `pending` with no url, no failure and no
-- engine handle. The API's service-role session bypasses this trigger and sets
-- `provider` to the intended engine, which is why `provider` is not listed here.
create trigger deployments_guard_engine_columns_insert
  before insert on deployments
  for each row execute function public.guard_engine_columns_on_insert(
    'status=pending', 'url=null', 'provider_resource_id=null',
    'deployment_resource_id=null', 'failure_reason=null'
  );
