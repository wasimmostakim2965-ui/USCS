-- Probe: a client must not be able to be born with a green deployment.
--
-- `deployments` has no client-facing UPDATE policy, which reads as "status is
-- the worker's". That covers the mutation of an existing row but not the
-- creation of one: `deployments_insert` constrains *who* may insert (a member,
-- for their own project) and *nothing about the columns*, so a client could
-- supply `status = 'succeeded'` and a `url` in the INSERT itself — a deployment
-- that was never deployed, claiming an outcome the engine never reported.
--
-- Migration 0009 holds the table to the same standard 0006 set for every other
-- engine-observed table, with `guard_engine_columns` / `_on_insert`.
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
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Alpha', 'alpha', '11111111-1111-1111-1111-111111111111');

-- The seed row is written as the service role, so the guards pass: it is the
-- legitimate shape the worker and API use, and later probes update against it.
insert into deployments (id, organization_id, project_id, idempotency_key, requested_by, provider) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-a', '11111111-1111-1111-1111-111111111111', 'coolify');

-- ===========================================================================
-- Probe 1: a client cannot create a deployment already claiming success
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  -- The row can be born green: status supplied on INSERT.
  begin
    insert into deployments (id, organization_id, project_id, idempotency_key, requested_by, status)
    values ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-forged-status',
            '11111111-1111-1111-1111-111111111111', 'succeeded');
    raise exception 'INTEGRITY FAIL: a client inserted a deployment already succeeded';
  exception
    when insufficient_privilege then null; -- expected: guard_engine_columns_on_insert
  end;

  -- Nor a url the engine did not issue.
  begin
    insert into deployments (id, organization_id, project_id, idempotency_key, requested_by, url)
    values ('aaaaaaaa-0000-0000-0000-0000000000f3', 'aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-forged-url',
            '11111111-1111-1111-1111-111111111111', 'https://evil.example.com');
    raise exception 'INTEGRITY FAIL: a client inserted a deployment with its own url';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- Nor an engine handle, which is what addresses the build log.
  begin
    insert into deployments (id, organization_id, project_id, idempotency_key, requested_by, provider_resource_id)
    values ('aaaaaaaa-0000-0000-0000-0000000000f4', 'aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-forged-handle',
            '11111111-1111-1111-1111-111111111111', 'engine-uuid');
    raise exception 'INTEGRITY FAIL: a client inserted a deployment with an engine handle';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- The honest request still works: a member may ask for a deployment and the row
  -- is born `pending`, with no outcome attached.
  insert into deployments (id, organization_id, project_id, idempotency_key, requested_by)
  values ('aaaaaaaa-0000-0000-0000-0000000000f5', 'aaaaaaaa-0000-0000-0000-00000000000a',
          'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-honest',
          '11111111-1111-1111-1111-111111111111');

  if not exists (
    select 1 from deployments
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f5'
      and status = 'pending' and url is null and failure_reason is null
  ) then
    raise exception 'REGRESSION FAIL: an honest deployment request did not land pending';
  end if;
end;
$$;

-- ===========================================================================
-- Probe 2: mutating an existing row's status is still refused by RLS
-- ===========================================================================

do $$
declare affected int;
begin
  update deployments set status = 'succeeded', url = 'https://evil.example.com'
  where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'INTEGRITY FAIL: a client updated deployment status (% rows)', affected;
  end if;
end;
$$;

-- ===========================================================================
-- Probe 3: the same holds for another tenant, and the service role still works
-- ===========================================================================

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
begin
  -- Bob is an owner of org B, but may not create a deployment in org A at all —
  -- and certainly not one claiming success.
  begin
    insert into deployments (id, organization_id, project_id, idempotency_key, requested_by, status)
    values ('bbbbbbbb-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-00000000000a',
            'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-cross-tenant',
            '22222222-2222-2222-2222-222222222222', 'succeeded');
    raise exception 'ISOLATION FAIL: Bob inserted into org A deployments';
  exception
    when insufficient_privilege then null; -- expected: guard fires first
    when others then
      -- RLS `with check` may also refuse; either refusal is correct.
      if sqlstate = '42501' then null; else raise; end if;
  end;
end;
$$;

-- Regression: the service role is not blocked by the guard. This is the path the
-- API and worker use to report the engine's answer.
reset role;
set role service_role;

update deployments set status = 'succeeded', url = 'https://alpha.example.com',
       provider_resource_id = 'engine-deploy-uuid', finished_at = now()
where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';

do $$
begin
  if not exists (
    select 1 from deployments
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f1' and status = 'succeeded'
  ) then
    raise exception 'REGRESSION FAIL: the service role could not record a deployment outcome';
  end if;
end;
$$;

reset role;

select 'deployment status guard probe passed' as result;
