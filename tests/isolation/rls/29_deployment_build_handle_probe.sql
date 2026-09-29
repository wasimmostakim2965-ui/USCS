-- Probe: a build handle is the builder's answer, not a client's claim.
--
-- `deployments.build_provider_resource_id` and `build_provider` (0031) address a
-- serverless deploy's build log. The build runs on a separate builder engine, so
-- before 0031 that log was unreachable and a failed build was a one-line reason
-- with nowhere to look.
--
-- The columns are **engine observations**, so 0006's `guard_engine_columns` /
-- `_on_insert` freeze them exactly as they freeze `status` and `url`:
--
--   1. A client cannot INSERT a row naming a build handle it did not run. That
--      is what stops a browser from pointing a deployment's log at another
--      build's log — or at a fabricated one — through PostgREST.
--
--   2. A client cannot UPDATE the handle either. RLS has no client UPDATE policy
--      on `deployments`, but the trigger is the per-column rule that survives a
--      future policy change, the same reasoning as 0009.
--
--   3. The service role (the worker, which *is* the builder's caller) can write
--      it, so the honest path still works. A guard that also blocked the engine's
--      own answer would be as wrong as one that blocked nothing.
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
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob')
on conflict (id) do update set display_name = excluded.display_name, email = excluded.email;

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Org B', 'org-b', '22222222-2222-2222-2222-222222222222');

insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'owner');

insert into projects (id, organization_id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Alpha', 'alpha', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Beta', 'beta', '22222222-2222-2222-2222-222222222222');

-- ===========================================================================
-- Probe 1: a client cannot claim a build handle on INSERT
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  -- Naming a builder handle on a row the client inserts is refused: the handle is
  -- the builder's answer, and the client never spoke to the builder.
  begin
    insert into deployments
      (id, organization_id, project_id, idempotency_key, requested_by, kind,
       build_provider, build_provider_resource_id)
    values ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-forged-build',
            '11111111-1111-1111-1111-111111111111', 'production',
            'railpack', 'forged-build-1');
    raise exception 'INTEGRITY FAIL: a client inserted a deployment naming a build handle';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- Naming only the builder, without a handle, is refused too.
  begin
    insert into deployments
      (id, organization_id, project_id, idempotency_key, requested_by, kind, build_provider)
    values ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-forged-provider',
            '11111111-1111-1111-1111-111111111111', 'production', 'nixpacks');
    raise exception 'INTEGRITY FAIL: a client inserted a deployment naming a build provider';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- A plain row with no build claim is accepted, and both columns default null.
  insert into deployments
    (id, organization_id, project_id, idempotency_key, requested_by, kind)
  values ('aaaaaaaa-0000-0000-0000-0000000000f3', 'aaaaaaaa-0000-0000-0000-00000000000a',
          'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-plain',
          '11111111-1111-1111-1111-111111111111', 'production');
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: the service role (the builder's caller) may write the handle
-- ===========================================================================

set role service_role;

do $$
declare
  handle text;
  builder text;
begin
  update deployments
  set build_provider = 'railpack',
      build_provider_resource_id = 'build-1'
  where id = 'aaaaaaaa-0000-0000-0000-0000000000f3';

  select build_provider_resource_id, build_provider
    into handle, builder
  from deployments where id = 'aaaaaaaa-0000-0000-0000-0000000000f3';

  if handle is distinct from 'build-1' or builder is distinct from 'railpack' then
    raise exception 'REGRESSION FAIL: the service role could not record the builder handle (%, %)', builder, handle;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 3: a client cannot rewrite the handle on an existing row
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  -- RLS denies the UPDATE outright (there is no client UPDATE policy), and the
  -- row is untouched. The point of the trigger is that the column rule holds even
  -- if a policy is ever relaxed; here both layers agree.
  update deployments
  set build_provider_resource_id = 'someone-elses-build'
  where id = 'aaaaaaaa-0000-0000-0000-0000000000f3';
end;
$$;

reset role;

do $$
declare handle text;
begin
  select build_provider_resource_id into handle
  from deployments where id = 'aaaaaaaa-0000-0000-0000-0000000000f3';
  if handle is distinct from 'build-1' then
    raise exception 'INTEGRITY FAIL: a client rewrote the builder handle to %', handle;
  end if;
end;
$$;

-- ===========================================================================
-- Probe 4: the guard is per-column, not a blanket freeze
-- ===========================================================================

-- The request attributes a client owns still work: an engine observation being
-- frozen must not make the whole row unwritable to the service role.
set role service_role;

do $$
begin
  insert into deployments
    (id, organization_id, project_id, idempotency_key, requested_by, kind, staged, git_branch,
     git_repository)
  values ('aaaaaaaa-0000-0000-0000-0000000000f4', 'aaaaaaaa-0000-0000-0000-00000000000a',
          'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-request-attrs',
          '11111111-1111-1111-1111-111111111111', 'preview', true, 'feature-x',
          'https://github.com/acme/alpha.git');

  if not exists (
    select 1 from deployments
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f4'
      and staged and git_branch = 'feature-x'
      and build_provider_resource_id is null and build_provider is null
  ) then
    raise exception 'REGRESSION FAIL: the request attributes did not survive the build guard';
  end if;
end;
$$;

reset role;

\echo 'deployment build handle probe passed'
