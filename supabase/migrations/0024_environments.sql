-- ---------------------------------------------------------------------------
-- 0024 — environments are real (matrix P14 / audit C3)
--
-- `environments` has existed since `0001_control_plane.sql` and every RLS
-- policy for it has existed since `0002`, but nothing read or wrote the table:
-- there was no way to say that a project has a production and a preview
-- environment, and `deployments.environment_id` was always null. That made the
-- per-environment vocabulary — the thing Vercel's Environment Variables dialog
-- is built on — impossible to express, which is why `0025` (env-var scoping)
-- could not be written before this file.
--
-- What an environment is here:
--
--   * `kind` classifies it. Vercel ships exactly two long-lived environments —
--     Production and Preview — and a per-project "Development" that lives on a
--     laptop rather than on the platform, so it is deliberately absent: the
--     control plane has nothing to store for a local environment. `custom` is
--     the honest default for a row a customer names themselves, so an old row
--     (or a future one) is never silently claimed to be Production.
--   * `is_default` (from `0001`) marks the environment a deployment uses when it
--     names none. Production is the default, matching Vercel: a plain `vercel
--     deploy` is a production deployment.
--   * One row per project per kind, for the two platform kinds. A partial unique
--     index enforces that, so "the project's preview environment" is a
--     well-defined row and `getEnvironment(project, 'preview')` cannot return
--     two. A `custom` environment is not constrained, because a customer may
--     name as many as they like.
--
-- Every project gets both rows, and the way it gets them is a trigger rather
-- than an API call. A project created by the API, by a future import path, or by
-- a client session all end up with the same two environments, so the invariant
-- lives in the schema instead of in one caller. Existing projects are backfilled
-- below, in the same migration, so the table is complete the moment it becomes
-- read-write.
--
-- The rows are not engine state: they are a Cloud Wai-owned classification of a
-- project's deployments. Nothing here is guarded by `guard_engine_columns`,
-- because no engine reports an environment — the control plane owns this model.
-- ---------------------------------------------------------------------------

alter table environments
  add column if not exists kind text not null default 'custom';

-- Classify any pre-existing row by its reserved name before the unique index is
-- built, so a project that already had a row named `production` is recognised
-- rather than duplicated. `unique (project_id, name)` from 0001 means at most one
-- row per project can carry each reserved name, so this cannot collide.
update environments set kind = 'production' where kind = 'custom' and name = 'production';
update environments set kind = 'preview'    where kind = 'custom' and name = 'preview';

-- Backfill the two platform environments for every project that predates this
-- migration. `on conflict (project_id, name)` targets the 0001 constraint, so a
-- project that already had a row of that name keeps it and no duplicate is made.
insert into environments (organization_id, project_id, name, is_default, kind)
select p.organization_id, p.id, 'production', true, 'production'
  from projects p
on conflict (project_id, name) do nothing;

insert into environments (organization_id, project_id, name, is_default, kind)
select p.organization_id, p.id, 'preview', false, 'preview'
  from projects p
on conflict (project_id, name) do nothing;

-- Exactly one production and one preview per project. Built after the backfill
-- so it validates real data, not an empty table.
create unique index if not exists environments_project_kind_idx
  on environments (project_id, kind)
  where kind in ('production', 'preview');

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'environments_kind_check'
  ) then
    alter table environments
      add constraint environments_kind_check
      check (kind in ('production', 'preview', 'custom'));
  end if;
end;
$$;

-- A deployment is looked up by its environment often enough (the env-var
-- resolver, the deployments list) that the foreign key deserves its index.
create index if not exists deployments_environment_idx
  on deployments (environment_id);

comment on column environments.kind is
  'production | preview | custom. The two platform environments exist for every project; custom is a customer-named row and the default for a row that predates this classification.';

-- ---------------------------------------------------------------------------
-- A project is born with its two environments
--
-- AFTER INSERT, not BEFORE: the `environments_insert` policy (0002) requires the
-- project row to exist, so a BEFORE trigger's inserts would be rejected for a
-- client session. The trigger runs as the inserting session, so a client's own
-- project creation is covered by the same policy as the API's service-role
-- write, and neither path has to remember to create the rows.
-- ---------------------------------------------------------------------------

create or replace function public.create_project_environments()
returns trigger
language plpgsql
as $$
begin
  insert into environments (organization_id, project_id, name, is_default, kind)
  values
    (new.organization_id, new.id, 'production', true,  'production'),
    (new.organization_id, new.id, 'preview',    false, 'preview');
  return new;
end;
$$;

comment on function public.create_project_environments() is
  'Creates the production and preview environments for a newly inserted project, so the two platform environments exist for every path that creates a project.';

drop trigger if exists projects_create_environments on projects;
create trigger projects_create_environments
  after insert on projects
  for each row execute function public.create_project_environments();
