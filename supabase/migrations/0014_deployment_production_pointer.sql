-- ---------------------------------------------------------------------------
-- 0014 — the production pointer (matrix P10/P11)
--
-- This is the data half of the model Vercel's whole deployment story rests on,
-- and the piece Cloud Wai was missing.
--
-- A deployment is an *immutable build record*. What a domain serves is a
-- *pointer* to one of those records, and "promote", "roll back" and "the live
-- deployment" are all just moving that pointer. They are not redeploys: the
-- artifact is already built, so the switch is instant and cannot produce a
-- different result than the one that was verified.
--
-- Two additions:
--
--   * `projects.production_deployment_id` — the deployment the project's
--     domains are currently served from. NULL means a project that has never
--     had a production deployment succeed. It is written only by the API/worker
--     through the service role (guarded below), because it is what the edge
--     routes to: a client asserting it would be a client choosing what is live
--     without going through a promote.
--
--   * `deployments.is_current` — a denormalised flag on the deployment rows so
--     the history can show "currently live" without a join. Exactly one
--     production deployment per project may carry it; the partial unique index
--     is the enforcement, not a convention. A preview never carries it.
--
-- Why `is_current` and not "the newest succeeded deployment": a promote can
-- point at an *older* deployment (that is what a rollback is), so "which one is
-- live" is not derivable from `created_at` and must be stored. The flag is the
-- stored answer; the pointer is the authority.
-- ---------------------------------------------------------------------------

alter table projects
  add column if not exists production_deployment_id uuid references deployments (id) on delete set null;

comment on column projects.production_deployment_id is
  'The deployment the project''s domains serve. Set by promote/rollback/the first production success; NULL until one exists. Engine-observed, so guarded against client writes: a client that could set it would choose what is live without a promote.';

alter table deployments
  add column if not exists is_current boolean not null default false;

comment on column deployments.is_current is
  'True for the one production deployment a project currently serves. A denormalised view of projects.production_deployment_id so the history can mark the live row without a join.';

-- Exactly one current production deployment per project. A partial unique index
-- (not a trigger) so the database refuses a second one; the promote path clears
-- the old flag and sets the new in the same transaction the API performs.
create unique index if not exists deployments_current_production_idx
  on deployments (project_id)
  where is_current and kind = 'production';

-- The pointer is engine-owned: written by the service role (the API and the
-- worker), never by a client. Same mechanism as `projects.provider*` in 0006.
create trigger projects_guard_production_pointer
  before update on projects
  for each row execute function public.guard_engine_columns(
    'production_deployment_id'
  );

create trigger projects_guard_production_pointer_insert
  before insert on projects
  for each row execute function public.guard_engine_columns_on_insert(
    'production_deployment_id=null'
  );

-- `is_current` is engine-owned in the same sense: a client that could flip it
-- would be declaring its own preview live. Written by the service role only.
create trigger deployments_guard_is_current
  before update on deployments
  for each row execute function public.guard_engine_columns('is_current');

create trigger deployments_guard_is_current_insert
  before insert on deployments
  for each row execute function public.guard_engine_columns_on_insert('is_current=false');

-- ---------------------------------------------------------------------------
-- The promote transaction
--
-- Moving the production pointer must clear the previous row's flag and set the
-- new one atomically, or a reader between the two writes sees either zero or two
-- live deployments. It also cannot go through PostgREST's generic PATCH: the
-- pointer is engine-owned and the guard trigger only lets a `service_role`
-- session past, which is what this function runs as (SECURITY DEFINER) when
-- called over `/rpc`.
--
-- The function is deliberately narrow: it trusts the API's decision *which*
-- deployment is a promoted production build, and only performs the move. Its
-- where clauses carry `organization_id`, so even a mistaken id cannot reach
-- across a tenant. It returns whether it moved the pointer, not a fabricated
-- success.
-- ---------------------------------------------------------------------------

create or replace function public.promote_deployment(
  p_organization_id uuid,
  p_project_id uuid,
  p_deployment_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  moved boolean := false;
begin
  -- The target must be a succeeded production deployment of this project in
  -- this organization. A preview, an in-flight build, a failed run or a row in
  -- another tenant is not a thing that can be live.
  if not exists (
    select 1 from deployments d
    where d.id = p_deployment_id
      and d.project_id = p_project_id
      and d.organization_id = p_organization_id
      and d.kind = 'production'
      and d.status = 'succeeded'
  ) then
    return false;
  end if;

  -- Clear whatever was live in this project. A partial unique index would refuse
  -- a second current row, so this ordering (clear, then set) matters.
  update deployments
     set is_current = false
   where project_id = p_project_id
     and organization_id = p_organization_id
     and is_current;

  update deployments
     set is_current = true
   where id = p_deployment_id
     and project_id = p_project_id
     and organization_id = p_organization_id;

  update projects
     set production_deployment_id = p_deployment_id
   where id = p_project_id
     and organization_id = p_organization_id;

  moved := true;
  return moved;
end;
$$;

comment on function public.promote_deployment(uuid, uuid, uuid) is
  'Atomically points a project''s production deployment at one of its succeeded production deployments. Returns false when the target is not promotable; never fabricates a success.';

-- Only the service role may call it: it writes an engine-owned column. A client
-- that could call it would be choosing what is live without a promote.
revoke all on function public.promote_deployment(uuid, uuid, uuid) from public, authenticated, anon;
grant execute on function public.promote_deployment(uuid, uuid, uuid) to service_role;
