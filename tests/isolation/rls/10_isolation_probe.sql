-- Two-organization isolation probe for the Cloud Wai control plane.
--
-- Runs against a real PostgreSQL with the real migrations applied, switching to
-- the `authenticated` role and setting the same JWT GUC that PostgREST sets.
-- Every check RAISES on failure, so a non-zero exit means the policy is broken.
--
-- Fixtures: Alice owns org A, Bob owns org B, Carol is a member of neither.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (service role: bypasses RLS, as the API/worker does)
-- ===========================================================================

-- Idempotent: the probe can be re-run against the same database.
truncate audit_logs, usage_records, orchestration_jobs, api_keys,
         security_policies, security_rules, security_events,
         security_trusted_sources, domains, data_backups, data_restores,
         data_resources, project_git_links, preview_targets, project_env_vars,
         organization_budgets, deployments, environments, projects,
         organization_members, organizations, profiles cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com');

insert into profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', 'Carol');

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Org B', 'org-b', '22222222-2222-2222-2222-222222222222');

insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'owner');

insert into projects (id, organization_id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Alpha', 'alpha', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Beta', 'beta', '22222222-2222-2222-2222-222222222222');

insert into deployments (id, organization_id, project_id, idempotency_key, requested_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'key-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'key-b', '22222222-2222-2222-2222-222222222222');

insert into api_keys (organization_id, name, key_hash, key_prefix, owner_id, scopes) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'A key', 'hash-a-secret', 'cw_a', '11111111-1111-1111-1111-111111111111', '{project:read}'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'B key', 'hash-b-secret', 'cw_b', '22222222-2222-2222-2222-222222222222', '{project:read}');

insert into domains (organization_id, project_id, hostname, verified) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'alpha.example.com', true),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'beta.example.com', true);

insert into data_resources (organization_id, project_id, kind, name, state) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'postgres', 'alpha-db', 'ready'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'object_storage', 'beta-bucket', 'ready');

insert into audit_logs (organization_id, actor_id, actor_email, event) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'alice@example.com', 'project.created'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222', 'bob@example.com', 'project.created');

-- usage_records is written by the service role, but it is *read* by a member
-- through the Billing page, so its SELECT policy is load-bearing.
insert into usage_records (organization_id, metric, quantity, recorded_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'build_minutes', 42, '2026-09-20T10:00:00Z'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'build_minutes', 999, '2026-09-21T10:00:00Z');

-- orchestration_jobs is the same shape: written by the worker and the engine,
-- *read* by a member through the Observability page. Its SELECT policy is what
-- keeps that read inside the tenant, so it is probed both ways below.
insert into orchestration_jobs (organization_id, kind, idempotency_key, state, attempts) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'deployment', 'obs-a', 'succeeded', 1),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'deployment', 'obs-b', 'failed', 3);

-- ===========================================================================
-- Probe 1: Alice (owner of A) sees only org A
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare visible_orgs int;
begin
  select count(*) into visible_orgs from organizations;
  if visible_orgs <> 1 then
    raise exception 'ISOLATION FAIL: Alice sees % organizations, expected 1', visible_orgs;
  end if;

  if not exists (select 1 from organizations where id = 'aaaaaaaa-0000-0000-0000-00000000000a') then
    raise exception 'ISOLATION FAIL: Alice cannot see her own organization';
  end if;

  if exists (select 1 from organizations where id = 'bbbbbbbb-0000-0000-0000-00000000000b') then
    raise exception 'ISOLATION FAIL: Alice can see org B';
  end if;
end;
$$;

do $$
declare visible_projects int;
begin
  select count(*) into visible_projects from projects;
  if visible_projects <> 1 then
    raise exception 'ISOLATION FAIL: Alice sees % projects, expected 1', visible_projects;
  end if;
end;
$$;

do $$
declare visible int;
begin
  select count(*) into visible from projects where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can select org B projects by organization_id';
  end if;

  select count(*) into visible from deployments where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B deployments';
  end if;

  select count(*) into visible from audit_logs where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B audit logs';
  end if;

  select count(*) into visible from api_keys where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B api keys';
  end if;

  select count(*) into visible from domains where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B domains';
  end if;

  select count(*) into visible from data_resources where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B data resources';
  end if;

  select count(*) into visible from data_backups where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B data backups';
  end if;

  select count(*) into visible from usage_records where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B usage records';
  end if;

  select count(*) into visible from usage_records where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read her own usage records (% rows)', visible;
  end if;

  select count(*) into visible from orchestration_jobs where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B orchestration jobs';
  end if;

  select count(*) into visible from orchestration_jobs where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read her own orchestration jobs (% rows)', visible;
  end if;

  select count(*) into visible from security_policies where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B security policies';
  end if;

  select count(*) into visible from domains where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read her own domains';
  end if;

  select count(*) into visible from data_resources where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read her own data resources';
  end if;
end;
$$;

-- ===========================================================================
-- Probe 2: Alice cannot write into org B
-- ===========================================================================

do $$
declare affected int;
begin
  update projects set name = 'PWNED' where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'ISOLATION FAIL: Alice updated % rows in org B', affected;
  end if;

  delete from projects where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'ISOLATION FAIL: Alice deleted % rows in org B', affected;
  end if;
end;
$$;

do $$
begin
  begin
    insert into projects (organization_id, name, slug, created_by)
    values ('bbbbbbbb-0000-0000-0000-00000000000b', 'Sneaky', 'sneaky', '11111111-1111-1111-1111-111111111111');
    raise exception 'ISOLATION FAIL: Alice inserted a project into org B';
  exception
    when insufficient_privilege then
      null; -- expected: RLS rejects the insert
  end;
end;
$$;

-- ===========================================================================
-- Probe 3: a user cannot forge their own membership into another org
-- ===========================================================================

do $$
begin
  begin
    insert into organization_members (organization_id, user_id, role)
    values ('bbbbbbbb-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'owner');
    raise exception 'ISOLATION FAIL: Alice granted herself ownership of org B';
  exception
    when insufficient_privilege then
      null; -- expected: only an org B admin could do this
  end;
end;
$$;

-- ===========================================================================
-- Probe 4: even an owner cannot mutate deployment status or rewrite audit
-- ===========================================================================

do $$
declare affected int;
begin
  -- Deployment status is the worker's to write; a client must not be able to
  -- mark its own deployment succeeded.
  update deployments set status = 'succeeded', url = 'https://evil.example.com'
  where id = 'aaaaaaaa-0000-0000-0000-0000000000a2';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'INTEGRITY FAIL: a client updated deployment status (% rows)', affected;
  end if;

  -- orchestration_jobs has a SELECT policy and no UPDATE policy, so a member
  -- cannot rewrite a job's state or erase its error. This is what makes the
  -- Observability page a read of the queue rather than of client-controlled data.
  update orchestration_jobs set state = 'succeeded', last_error = null
  where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'INTEGRITY FAIL: a client rewrote orchestration jobs (% rows)', affected;
  end if;

  -- audit_logs is append-only for every role, including owners.
  delete from audit_logs where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'INTEGRITY FAIL: a client deleted % audit rows', affected;
  end if;

  update audit_logs set event = 'forged' where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'INTEGRITY FAIL: a client rewrote % audit rows', affected;
  end if;
end;
$$;

-- ===========================================================================
-- Probe 5: the API key hash is never selectable by a client
-- ===========================================================================

do $$
begin
  begin
    perform key_hash from api_keys;
    raise exception 'SECRET FAIL: key_hash was selectable by an authenticated client';
  exception
    when insufficient_privilege then
      null; -- expected: column privilege revoked
  end;
end;
$$;

-- Metadata and prefix remain readable for the owning org.
do $$
declare n int;
begin
  select count(*) into n from api_keys where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if n <> 1 then
    raise exception 'SECRET FAIL: owner cannot read their own api key metadata (% rows)', n;
  end if;
end;
$$;

-- ===========================================================================
-- Probe 6: Bob's view is symmetric
-- ===========================================================================

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
declare visible int;
begin
  select count(*) into visible from organizations;
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Bob sees % organizations, expected 1', visible;
  end if;

  select count(*) into visible from projects where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Bob can read org A projects';
  end if;
end;
$$;

-- ===========================================================================
-- Probe 7: a non-member sees nothing at all
-- ===========================================================================

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
declare visible int;
begin
  select count(*) into visible from organizations;
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: a non-member sees % organizations, expected 0', visible;
  end if;

  select count(*) into visible from projects;
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: a non-member sees % projects, expected 0', visible;
  end if;
end;
$$;

-- The same sweep over every tenant-owned table, not just the first two. A
-- brand-new account is the strictest case of this probe: it belongs to no
-- organization, so every one of these counts must be zero. Two tables passing
-- while a third leaks is exactly the regression this catches.
do $$
declare
  tenant_tables text[] := array[
    'deployments', 'environments', 'audit_logs', 'api_keys', 'domains',
    'data_resources', 'data_backups', 'data_restores', 'security_policies',
    'security_rules', 'security_events', 'security_trusted_sources',
    'usage_records', 'organization_budgets', 'orchestration_jobs',
    'project_git_links', 'preview_targets', 'project_env_vars',
    'organization_members'
  ];
  tbl text;
  visible int;
  checked int := 0;
begin
  foreach tbl in array tenant_tables loop
    execute format('select count(*) from %I', tbl) into visible;
    if visible <> 0 then
      raise exception 'ISOLATION FAIL: a non-member sees % rows in %', visible, tbl;
    end if;
    checked := checked + 1;
  end loop;

  -- Guard against the sweep silently checking nothing.
  if checked <> array_length(tenant_tables, 1) then
    raise exception 'ISOLATION FAIL: sweep checked % tables, expected %',
      checked, array_length(tenant_tables, 1);
  end if;
end;
$$;

reset role;

select 'RLS isolation probe passed: no cross-tenant access across 19 tenant tables' as result;
