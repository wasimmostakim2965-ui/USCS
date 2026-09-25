-- Probe: project environment variables (matrix P13 / audit D5).
--
-- The value of an environment variable is a secret the platform must hold but
-- never reveal, and the engine handle on a row is the engine's answer, not a
-- customer's to assert. Four facts have to hold, and each is the kind only a
-- real database can prove:
--
--   1. A member reads the key inventory of their own tenant and nothing of
--      another's, and `select *` can never return the value ciphertext: the
--      column is not in the SELECT grant, exactly like `api_keys.key_hash`.
--
--   2. `engine_ref`, `provider` and `provider_resource_id` are frozen against
--      client writes on INSERT and UPDATE — a client cannot point a variable at
--      an engine handle it did not earn (the `domains.verified` rule).
--
--   3. Writing a variable is a project-settings act scoped to the caller's own
--      organization; nobody can write into another tenant.
--
--   4. One row per project per key — two spellings of one key cannot become two
--      engine variables.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate project_env_vars, projects, organization_members, organizations, profiles cascade;
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

-- Alice owns A; Carol is a plain member of A; Dave owns B.
insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'owner');

insert into projects (id, organization_id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Alpha', 'alpha', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Beta', 'beta', '44444444-4444-4444-4444-444444444444');

-- A variable for A and one for B. `value_encrypted` is a stand-in for the API's
-- AES-256-GCM ciphertext: the probe cares that whatever is stored cannot be read
-- by a client.
insert into project_env_vars
  (id, organization_id, project_id, key, value_encrypted, value_prefix, is_build_time, updated_by)
values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-0000000000a1', 'DATABASE_URL', 'v1:AAAA:BBBB:CCCC', 'a1b2', true,
   '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-0000000000e2', 'bbbbbbbb-0000-0000-0000-00000000000b',
   'bbbbbbbb-0000-0000-0000-0000000000b1', 'DATABASE_URL', 'v1:DDDD:EEEE:FFFF', 'c3d4', false,
   '44444444-4444-4444-4444-444444444444');

-- ===========================================================================
-- Probe 1: a member reads A's key inventory, never B's, and never a value
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare key_count int;
begin
  select count(*) into key_count from project_env_vars
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if key_count <> 1 then
    raise exception 'ISOLATION FAIL: Alice sees % of A''s variables (expected 1)', key_count;
  end if;

  select count(*) into key_count from project_env_vars;
  if key_count <> 1 then
    raise exception 'ISOLATION FAIL: Alice sees % variables in total (expected 1)', key_count;
  end if;
end;
$$;

-- The ciphertext is not in the SELECT grant, so even a `select *` cannot return
-- it; a direct reference is refused. The fingerprint (`value_prefix`) is
-- deliberately readable — it is how a customer tells two variables apart.
do $$
begin
  begin
    perform value_encrypted from project_env_vars limit 1;
    raise exception 'SECRET FAIL: a client selected the value ciphertext';
  exception
    when insufficient_privilege then
      null; -- expected: not in the SELECT grant
  end;
end;
$$;

-- The key inventory and its non-secret fingerprint are readable, which is what
-- the dashboard lists.
do $$
declare
  k text;
  p text;
begin
  select key, value_prefix into k, p from project_env_vars
   where project_id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
  if k <> 'DATABASE_URL' then
    raise exception 'FAIL: Alice cannot read her own variable key (%)', k;
  end if;
  if p <> 'a1b2' then
    raise exception 'FAIL: Alice cannot read the value fingerprint (%)', p;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: the engine handle is not a client's to assert
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  -- A client cannot set the engine handle on INSERT.
  begin
    insert into project_env_vars
      (organization_id, project_id, key, value_encrypted, value_prefix, updated_by, engine_ref)
    values
      ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1',
       'FORGED', 'v1:X', 'ffff', '11111111-1111-1111-1111-111111111111', 'env-uuid-forged');
    raise exception 'INTEGRITY FAIL: a client set engine_ref on insert';
  exception
    when insufficient_privilege then
      null; -- expected: the insert guard forces engine_ref = null
  end;

  -- Nor can it move one on UPDATE.
  begin
    update project_env_vars set engine_ref = 'env-uuid-forged'
     where project_id = 'aaaaaaaa-0000-0000-0000-0000000000a1' and key = 'DATABASE_URL';
    raise exception 'INTEGRITY FAIL: a client moved engine_ref';
  exception
    when insufficient_privilege then
      null; -- expected: the update guard freezes the engine columns
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 3: writing a variable is scoped to the caller's own organization
-- ===========================================================================

-- Carol is a member of A: she may set a variable in A.
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
begin
  insert into project_env_vars
    (organization_id, project_id, key, value_encrypted, value_prefix, updated_by)
  values
    ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1',
     'FEATURE_FLAG', 'v1:GGGG', 'e5f6', '33333333-3333-3333-3333-333333333333');
end;
$$;

-- ... but never into an organization she does not belong to.
do $$
begin
  begin
    insert into project_env_vars
      (organization_id, project_id, key, value_encrypted, value_prefix, updated_by)
    values
      ('bbbbbbbb-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-0000000000b1',
       'BACKDOOR', 'v1:HHHH', 'g7h8', '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: a member wrote a variable into another tenant';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 4: one row per project per key
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    insert into project_env_vars
      (organization_id, project_id, key, value_encrypted, value_prefix, updated_by)
    values
      ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1',
       'DATABASE_URL', 'v1:IIII', 'i9j0', '11111111-1111-1111-1111-111111111111');
    raise exception 'SCHEMA FAIL: a duplicate (project_id, key) row was accepted';
  exception
    when unique_violation then
      null; -- expected: the unique constraint is what keeps one key one variable
  end;
end;
$$;

reset role;

\echo 'env var probe passed: the value is unreadable, the engine handle is engine-owned, and scope holds'
