-- ---------------------------------------------------------------------------
-- 0012 — restoring a database from a backup (matrix B5 / gate 9)
--
-- The database adapter has had `restore` since the beginning and
-- `tests/adapters/honesty.test.ts` proves it refuses an unknown backup — but no
-- procedure reached it, so the capability was **contract-only**: built and
-- unreachable. This is the data half of wiring it, following the backup path
-- (`0001`, `apps/api/src/procedures/data.ts`) exactly.
--
-- One new table:
--
--   * `data_restores` — one row per restore attempt. It names the backup it read
--     (`backup_id`) and the resource it wrote into (`data_resource_id`). Like
--     `data_backups`, it is organization-scoped with RLS, a client may read but
--     never write, and every engine-observed column (`status`, `provider`,
--     `provider_resource_id`, `finished_at`) is frozen against a client write by
--     `guard_engine_columns` — the same rule as `0006`/`0009`.
--
-- The restore is destructive: it overwrites the target database's current
-- contents with the backup's. The API therefore requires an explicit
-- confirmation token from the caller (see `restoreDataResource`), and the
-- adapter's own answer — never the request — decides the row's status. A
-- `not_configured` engine leaves the restore honestly non-successful.
-- ---------------------------------------------------------------------------

create table if not exists data_restores (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations (id) on delete cascade,
  -- The backup that is being read.
  backup_id         uuid not null references data_backups (id) on delete cascade,
  -- The resource that is being overwritten. Kept alongside `backup_id` so a
  -- restore is auditable even if the backup is later pruned.
  data_resource_id  uuid not null references data_resources (id) on delete cascade,
  provider          text,
  provider_resource_id text,
  status            engine_status not null default 'pending',
  created_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index if not exists data_restores_org_idx
  on data_restores (organization_id, created_at desc);
create index if not exists data_restores_resource_idx
  on data_restores (data_resource_id, created_at desc);

alter table data_restores enable row level security;

-- A member reads a resource's restore history. A restore is requested through
-- the API but the row is written by the API and updated by the worker with the
-- service role, so there is deliberately no client INSERT/UPDATE policy — the
-- default is deny, following `data_backups`.
create policy data_restores_select on data_restores for select to authenticated
using (public.is_org_member(organization_id));

-- Engine observations are not a client's to assert. `provider_resource_id` and
-- `finished_at` change only from the adapter's answer; `status` likewise.
create trigger data_restores_guard_engine_columns
  before update on data_restores
  for each row execute function public.guard_engine_columns(
    'status', 'provider', 'provider_resource_id', 'finished_at'
  );

create trigger data_restores_guard_engine_columns_insert
  before insert on data_restores
  for each row execute function public.guard_engine_columns_on_insert(
    'status=pending', 'provider_resource_id=null', 'finished_at=null'
  );
