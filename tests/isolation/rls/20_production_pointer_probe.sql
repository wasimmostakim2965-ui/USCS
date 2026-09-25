-- Probe: the production pointer is the server's to move.
--
-- A deployment is an immutable build record; what a domain serves is a pointer
-- to one of them. Three facts have to hold, and only a real database can prove
-- them:
--
--   1. `projects.production_deployment_id` and `deployments.is_current` are
--      engine-owned. A client may not move the pointer with a plain PATCH any
--      more than it may declare its own build `succeeded`.
--
--   2. The pointer is single-valued. The partial unique index refuses a second
--      current production deployment in a project, so "which one is live" has
--      exactly one answer even under concurrent writers.
--
--   3. `promote_deployment` is the only door, it is `service_role`-only, and it
--      carries `organization_id` in every where clause, so a mistaken id cannot
--      reach across a tenant. It returns false — not a fabricated success — when
--      the target is a preview, an in-flight build or a row in another tenant.
--
-- Self-contained: it sets up its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (as the invoking role: superuser or service_role, so the guards pass)
-- ===========================================================================

truncate deployments, projects, organization_members, organizations, profiles cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com');

insert into profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob');

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Org B', 'org-b', '22222222-2222-2222-2222-222222222222');

insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'owner');

insert into projects (id, organization_id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Alpha', 'alpha', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Beta', 'beta', '22222222-2222-2222-2222-222222222222');

-- Two succeeded production deployments of A, one preview of A, and one
-- succeeded production deployment of B (another tenant).
insert into deployments
  (id, organization_id, project_id, idempotency_key, requested_by, provider, kind, status)
values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-1', '11111111-1111-1111-1111-111111111111', 'coolify', 'production', 'succeeded'),
  ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-2', '11111111-1111-1111-1111-111111111111', 'coolify', 'production', 'succeeded'),
  ('aaaaaaaa-0000-0000-0000-0000000000f3', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-3', '11111111-1111-1111-1111-111111111111', 'coolify', 'preview', 'succeeded'),
  ('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-00000000000b',
   'bbbbbbbb-0000-0000-0000-0000000000b1', 'key-b1', '22222222-2222-2222-2222-222222222222', 'coolify', 'production', 'succeeded');

-- ===========================================================================
-- Probe 1: a client may not move the pointer or set is_current
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare affected int;
begin
  -- The pointer itself: engine-owned, so the guard refuses the change.
  begin
    update projects set production_deployment_id = 'aaaaaaaa-0000-0000-0000-0000000000f1'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
    raise exception 'INTEGRITY FAIL: a client moved the production pointer';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- is_current: the same rule, but `deployments` has no client-facing UPDATE
  -- policy at all, so a client's UPDATE is filtered to zero rows rather than
  -- raising. Either refusal is correct; what matters is that no row changed.
  update deployments set is_current = true
  where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'INTEGRITY FAIL: a client set is_current (% rows)', affected;
  end if;

  -- A row cannot be born current either: an INSERT claiming it is refused.
  begin
    insert into deployments
      (id, organization_id, project_id, idempotency_key, requested_by, kind, is_current)
    values ('aaaaaaaa-0000-0000-0000-0000000000f4', 'aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-forged-current',
            '11111111-1111-1111-1111-111111111111', 'production', true);
    raise exception 'INTEGRITY FAIL: a client inserted an already-current deployment';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- And a client may not move the pointer through the RPC either: it is
  -- service_role-only.
  begin
    perform public.promote_deployment(
      'aaaaaaaa-0000-0000-0000-00000000000a',
      'aaaaaaaa-0000-0000-0000-0000000000a1',
      'aaaaaaaa-0000-0000-0000-0000000000f1');
    raise exception 'INTEGRITY FAIL: a client executed promote_deployment';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: the service role's promote is atomic and single-valued
-- ===========================================================================

set role service_role;

do $$
declare
  moved boolean;
  current_count int;
begin
  moved := public.promote_deployment(
    'aaaaaaaa-0000-0000-0000-00000000000a',
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'aaaaaaaa-0000-0000-0000-0000000000f1');
  if moved is not true then
    raise exception 'REGRESSION FAIL: the service role could not promote a succeeded production build';
  end if;

  -- Exactly one current production deployment, and it is the promoted one.
  select count(*) into current_count
  from deployments
  where project_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and is_current;
  if current_count <> 1 then
    raise exception 'INTEGRITY FAIL: % current production deployments rather than 1', current_count;
  end if;

  if not exists (
    select 1 from deployments
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f1' and is_current
  ) then
    raise exception 'INTEGRITY FAIL: the promoted deployment is not the current one';
  end if;

  if not exists (
    select 1 from projects
    where id = 'aaaaaaaa-0000-0000-0000-0000000000a1'
      and production_deployment_id = 'aaaaaaaa-0000-0000-0000-0000000000f1'
  ) then
    raise exception 'INTEGRITY FAIL: the project pointer did not follow the promote';
  end if;

  -- Promoting a second build moves the pointer: still exactly one current row.
  moved := public.promote_deployment(
    'aaaaaaaa-0000-0000-0000-00000000000a',
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'aaaaaaaa-0000-0000-0000-0000000000f2');
  if moved is not true then
    raise exception 'REGRESSION FAIL: the service role could not promote the second build';
  end if;

  select count(*) into current_count
  from deployments
  where project_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and is_current;
  if current_count <> 1 then
    raise exception 'INTEGRITY FAIL: promote left % current rows rather than 1', current_count;
  end if;

  if not exists (
    select 1 from deployments
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f2' and is_current
  ) then
    raise exception 'INTEGRITY FAIL: the second promote did not move the pointer';
  end if;
end;
$$;

-- ===========================================================================
-- Probe 3: promote refuses a preview and another tenant
-- ===========================================================================

do $$
declare moved boolean;
begin
  -- A preview is never promotable.
  moved := public.promote_deployment(
    'aaaaaaaa-0000-0000-0000-00000000000a',
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'aaaaaaaa-0000-0000-0000-0000000000f3');
  if moved is not false then
    raise exception 'INTEGRITY FAIL: a preview was promoted';
  end if;

  -- The preview left the pointer where it was.
  if not exists (
    select 1 from deployments
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f2' and is_current
  ) then
    raise exception 'INTEGRITY FAIL: refusing a preview moved the pointer anyway';
  end if;

  -- A deployment of another tenant, even with an otherwise valid id, is refused
  -- because the where clauses carry organization_id.
  moved := public.promote_deployment(
    'aaaaaaaa-0000-0000-0000-00000000000a',
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'bbbbbbbb-0000-0000-0000-0000000000f1');
  if moved is not false then
    raise exception 'ISOLATION FAIL: promote reached across a tenant';
  end if;
end;
$$;

-- ===========================================================================
-- Probe 4: a failed build is not promotable (the status rule, not the kind rule)
-- ===========================================================================

do $$
declare moved boolean;
begin
  update deployments set status = 'failed'
  where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';

  moved := public.promote_deployment(
    'aaaaaaaa-0000-0000-0000-00000000000a',
    'aaaaaaaa-0000-0000-0000-0000000000a1',
    'aaaaaaaa-0000-0000-0000-0000000000f1');
  if moved is not false then
    raise exception 'INTEGRITY FAIL: a failed build was promoted';
  end if;
end;
$$;

reset role;

select 'production pointer probe passed' as result;
