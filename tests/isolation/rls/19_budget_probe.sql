-- Probe: a spend cap (matrix W9).
--
-- `organization_budgets` is the object that makes a cap a control. Three things
-- must hold, and only a real database can prove them:
--
--   1. A member reads only its own organization's caps. A cap names a spend
--      ceiling, which is organization-private even though it is not a secret.
--
--   2. Only an owner sets a cap. The capability matrix keeps `billing:manage`
--      from every other role, and the policy mirrors it: neither a plain member
--      nor an admin may raise the ceiling on their own spend.
--
--   3. Removing a cap is likewise an owner action.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate organization_budgets, organization_members, organizations, profiles cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com'),
  ('55555555-5555-5555-5555-555555555555', 'erin@example.com');

insert into profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', 'Carol'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com', 'Dave'),
  ('55555555-5555-5555-5555-555555555555', 'erin@example.com', 'Erin');

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Org B', 'org-b', '44444444-4444-4444-4444-444444444444');

-- Alice owns A; Bob is an admin; Carol is a plain member; Dave owns B.
insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'admin'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'owner');

insert into organization_budgets (organization_id, metric, limit_quantity, hard_cap) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'deployments', 5, true),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'deployments', 99, false);

-- ===========================================================================
-- 1. A member of A sees A's cap and not B's.
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
declare
  a_count integer;
  b_count integer;
begin
  select count(*) into a_count from organization_budgets
  where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  select count(*) into b_count from organization_budgets
  where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if a_count <> 1 then
    raise exception 'FAIL: a member of A saw % of A''s budgets (expected 1)', a_count;
  end if;
  if b_count <> 0 then
    raise exception 'FAIL: a member of A saw % of B''s budgets (expected 0)', b_count;
  end if;
end;
$$;

-- ===========================================================================
-- 2. A plain member cannot set a cap.
-- ===========================================================================

do $$
begin
  begin
    insert into organization_budgets (organization_id, metric, limit_quantity, hard_cap)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'backups', 100, true);
    raise exception 'INTEGRITY FAIL: a plain member inserted a budget row';
  exception
    when insufficient_privilege then
      null; -- expected: the insert policy requires admin or owner
  end;
end;
$$;

-- An admin also cannot set a cap.
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
begin
  begin
    insert into organization_budgets (organization_id, metric, limit_quantity, hard_cap)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'backups', 100, true);
    raise exception 'INTEGRITY FAIL: an admin inserted a budget row';
  exception
    when insufficient_privilege then
      null; -- expected: the insert policy requires owner
  end;
end;
$$;

-- ===========================================================================
-- 3. Only an owner sets or removes a cap.
-- ===========================================================================

-- The owner sets one.
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  insert into organization_budgets (organization_id, metric, limit_quantity, hard_cap)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'backups', 3, true)
  on conflict (organization_id, metric) do update
    set limit_quantity = excluded.limit_quantity;
end;
$$;

-- An admin cannot remove it.
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
declare
  remaining integer;
begin
  delete from organization_budgets
  where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and metric = 'backups';

  select count(*) into remaining from organization_budgets
  where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and metric = 'backups';
  if remaining <> 1 then
    raise exception 'INTEGRITY FAIL: an admin removed a cap (the delete must be owner-only)';
  end if;
end;
$$;

-- The owner can.
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare
  remaining integer;
begin
  delete from organization_budgets
  where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and metric = 'backups';

  select count(*) into remaining from organization_budgets
  where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and metric = 'backups';
  if remaining <> 0 then
    raise exception 'FAIL: the owner''s delete did not remove the cap (saw %)', remaining;
  end if;
end;
$$;

reset role;

select 'budget probe passed: a cap is the tenant''s to read, and the owner''s alone to set or remove' as result;
