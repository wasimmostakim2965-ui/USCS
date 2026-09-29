-- ---------------------------------------------------------------------------
-- 0031 — a serverless deployment's build log becomes addressable
--
-- The gap this closes is the Phase C acceptance in `docs/plans/vercel-roadmap.md`:
-- "each stage is visible in the dashboard; a failure at any stage is reported
-- honestly." The container engine builds for itself, so a failed build there is
-- written to the engine's own *deployment* log and is addressable through
-- `deployments.deployment_resource_id` (0009). A serverless deploy is different:
-- the build runs on a separate builder engine (`BuildEngine`, ADR-0018) and only
-- the deploy runs on the runtime, so the failure lives in the *builder's* log —
-- and nothing recorded that builder handle. A customer saw the builder's one-line
-- reason and no addressable build log, which is the honest-but-incomplete state
-- the roadmap calls a visible stage gap.
--
-- One column, one *engine observation*:
--
--   * `deployments.build_provider_resource_id` — the builder's own job id
--     (`BuildEngine.build` returns an `OperationRef` whose `providerRef` this
--     is). Written only from the builder's answer, never by a client.
--   * `deployments.build_provider` — which builder engine issued it
--     (`railpack`/`nixpacks`). Recorded per row rather than assumed from config,
--     because the builder a deployment used is a fact about that deployment.
--
-- Both are frozen by `guard_engine_columns` (0006/0009): they are the engine's
-- answer about a build it ran, not the request. The request attributes a client
-- owns are untouched. `tests/isolation/rls/12_domain_verification_probe.sql` is
-- the model for the probes that keep this honest.
-- ---------------------------------------------------------------------------

alter table deployments
  add column if not exists build_provider_resource_id text,
  add column if not exists build_provider text;

comment on column deployments.build_provider_resource_id is
  'The builder engine''s own job id for this deployment''s build, written only from the builder''s answer. Addresses the build log when the deploy itself runs on a different engine (serverless).';
comment on column deployments.build_provider is
  'Which build engine issued build_provider_resource_id (railpack/nixpacks). Recorded per row because the builder a deployment used is a fact about that deployment, not a config default.';

-- Frozen on UPDATE and INSERT: both are engine observations, so a client cannot
-- claim a build it did not run or point a row at another build's log.
create trigger deployments_guard_build_columns
  before update on deployments
  for each row execute function public.guard_engine_columns(
    'build_provider_resource_id', 'build_provider'
  );

create trigger deployments_guard_build_columns_insert
  before insert on deployments
  for each row execute function public.guard_engine_columns_on_insert(
    'build_provider_resource_id=null', 'build_provider=null'
  );
