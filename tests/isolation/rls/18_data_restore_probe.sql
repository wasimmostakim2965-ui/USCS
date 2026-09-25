-- Probe: a data restore's record (matrix B5 / gate 9).
--
-- `data_restores` names both the backup it read and the resource it wrote into.
-- Two things must hold and only a real database can prove them:
--
--   1. A client reads only its own organization's restores, and cannot write one
--      at all. A restore is destructive, so its history must be the API's to
--      write and a member's to read — there is deliberately no client
--      INSERT/UPDATE policy.
--
--   2. The engine-observed columns (`status`, `provider_resource_id`,
--      `finished_at`) are frozen against a client write, exactly as on
--      `data_backups`: a member cannot mark a restore `succeeded` even through
--      PostgREST, because only the adapter's answer may do that.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate data_restores, data_backups, data_resources, organization_members,
         organizations, profiles cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com');

insert into profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', 'Carol'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com', 'Dave');

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Org B', 'org-b', '44444444-4444-4444-4444-444444444444');

insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'owner');

-- A database resource per tenant, a completed backup of each, and one restore of
-- each. The engine handles are invented here: the probe is about the row's
-- visibility and its frozen columns, not about the engine.
insert into data_resources (id, organization_id, kind, name, state, provider, provider_resource_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'postgres', 'alpha-db', 'ready', 'postgres', 'db-alpha'),
  ('bbbbbbbb-0000-0000-0000-0000000000e2', 'bbbbbbbb-0000-0000-0000-00000000000b',
   'postgres', 'beta-db', 'ready', 'postgres', 'db-beta');

insert into data_backups (id, organization_id, data_resource_id, provider, provider_resource_id, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-0000000000e1', 'postgres', 'db-alpha/bk-1', 'succeeded'),
  ('bbbbbbbb-0000-0000-0000-0000000000f2', 'bbbbbbbb-0000-0000-0000-00000000000b',
   'bbbbbbbb-0000-0000-0000-0000000000e2', 'postgres', 'db-beta/bk-2', 'succeeded');

insert into data_restores (id, organization_id, backup_id, data_resource_id, provider, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'postgres', 'succeeded'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-00000000000b',
   'bbbbbbbb-0000-0000-0000-0000000000f2', 'bbbbbbbb-0000-0000-0000-0000000000e2', 'postgres', 'succeeded');

-- ===========================================================================
-- 1. A member of A sees only A's restores.
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
declare
  a_count integer;
  b_count integer;
begin
  select count(*) into a_count from data_restores
  where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  select count(*) into b_count from data_restores
  where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if a_count <> 1 then
    raise exception 'FAIL: a member of A saw % of A''s restores (expected 1)', a_count;
  end if;
  if b_count <> 0 then
    raise exception 'FAIL: a member of A saw % of B''s restores (expected 0)', b_count;
  end if;
end;
$$;

-- ===========================================================================
-- 2. A client cannot write a restore at all.
-- ===========================================================================

do $$
begin
  begin
    insert into data_restores (organization_id, backup_id, data_resource_id, status)
    values ('aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-0000000000f1',
            'aaaaaaaa-0000-0000-0000-0000000000e1', 'pending');
    raise exception 'INTEGRITY FAIL: a client inserted a restore row directly';
  exception
    when insufficient_privilege then
      null; -- expected: no client INSERT policy on data_restores
  end;
end;
$$;

-- ===========================================================================
-- 3. A client cannot rewrite the engine-observed status.
--
-- Unlike the tables that carry an UPDATE policy, `data_restores` has none, so
-- RLS denies the statement by matching no row rather than by raising. The proof
-- is therefore that the row is still `succeeded`: the client's `failed` did not
-- reach it.
-- ===========================================================================

do $$
declare
  seen integer;
  before_status engine_status;
begin
  select count(*) into seen from data_restores
  where id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
  if seen <> 1 then
    raise exception 'FAIL: the member could not even see their restore (saw %)', seen;
  end if;

  update data_restores set status = 'failed'
  where id = 'aaaaaaaa-0000-0000-0000-0000000000a1';

  select status into before_status from data_restores
  where id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
  if before_status <> 'succeeded' then
    raise exception
      'INTEGRITY FAIL: a client rewrote a restore''s engine-observed status (now %)',
      before_status;
  end if;
end;
$$;

reset role;

select 'data restore probe passed: history is the tenant''s, the row is the API''s, the status is the engine''s' as result;
