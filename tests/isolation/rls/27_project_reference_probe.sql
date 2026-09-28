-- Probe: a row's project_id must name a project in the same organization
-- (migration 0029).
--
-- `environment_insert` and `deployments_insert` (0002) already carried this
-- check. Four tables did not, and the gap was reachable by a browser holding
-- only the anon key, writing through PostgREST directly:
--
--   * data_resources    — `data_resources_insert`
--   * domains           — `domains_insert`
--   * project_git_links — `project_git_links_insert`
--   * project_env_vars  — `project_env_vars_insert`
--
-- The row stays inside the writer's own organization (RLS's `organization_id`
-- check holds), so this is not a read of another tenant's data. It is an
-- integrity break: a foreign key pointing across the tenant boundary that any
-- future join or cascade trusting the pair would follow into the wrong
-- organization.
--
-- Each table is tested in its own block with its own fixture, because a
-- cross-organization insert that is *refused* raises `insufficient_privilege`
-- and would otherwise abort the transaction and abort every later block. A
-- block that reaches "ACCEPTED" is the finding; a block that catches
-- `insufficient_privilege` is the fix working — and, in the same block, the
-- in-organization control proves the rule did not over-block.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate audit_logs, usage_records, orchestration_jobs, api_keys,
         security_policies, security_rules, security_events, security_incidents,
         security_trusted_sources, security_rate_limits, domains, data_backups, data_restores,
         data_resources, project_git_links, preview_targets, project_env_vars,
         organization_budgets, deployments, environments, projects,
         organization_members, organizations, profiles cascade;
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

-- Org A gets project A1; org B gets project B1 (the foreign target Alice will
-- name) and project B2 (so org B has an environment of its own to name).
insert into projects (id, organization_id, name, slug, created_by) values
  ('aaaaaaa1-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Alpha', 'alpha', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbb1-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Beta',  'beta',  '22222222-2222-2222-2222-222222222222'),
  ('bbbbbbb2-0000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Beta2', 'beta2', '22222222-2222-2222-2222-222222222222');

-- Org B's project B1 gets its production/preview environments from the
-- `projects_create_environments` trigger (0024). The probe needs B1's
-- environment id, but reading it as Alice would be *hidden* by
-- `environments_select` (she is not a member of B) — an empty subquery would
-- make the insert touch zero rows and pass vacuously. So the id is captured
-- now, as the service role, into a session GUC the `do` blocks read. (A psql
-- `:'var'` cannot be used: it does not interpolate inside a dollar-quoted body.)
select set_config(
  'probe.b1env',
  (select id::text from environments
    where project_id = 'bbbbbbb1-0000-0000-0000-0000000000b1' and kind = 'production'
    limit 1),
  false
) is not null as b1env_captured;

-- Org A's own production environment, for the in-organization control.
select set_config(
  'probe.a1env',
  (select id::text from environments
    where project_id = 'aaaaaaa1-0000-0000-0000-0000000000a1' and kind = 'production'
    limit 1),
  false
) is not null as a1env_captured;

-- ===========================================================================
-- Probe 1: data_resources cannot reference another organization's project
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  -- The gap: org id A, project_id B.
  insert into data_resources (organization_id, project_id, kind, name)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'bbbbbbb1-0000-0000-0000-0000000000b1', 'postgres', 'cross');
  raise exception 'INTEGRITY FAIL: data_resources accepted a cross-org project_id';
exception
  when insufficient_privilege then
    null; -- expected: the new row violates data_resources_insert
end;
$$;

do $$
begin
  -- The control: the same insert inside org A must still be allowed.
  insert into data_resources (organization_id, project_id, kind, name)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaa1-0000-0000-0000-0000000000a1', 'postgres', 'same-org');
exception
  when insufficient_privilege then
    raise exception 'FAIL: data_resources over-blocked an in-organization insert';
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: domains cannot reference another organization's project
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  insert into domains (organization_id, project_id, hostname)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'bbbbbbb1-0000-0000-0000-0000000000b1', 'cross.example.com');
  raise exception 'INTEGRITY FAIL: domains accepted a cross-org project_id';
exception
  when insufficient_privilege then
    null; -- expected
end;
$$;

do $$
begin
  -- A domain with no project is legitimate and must still be allowed.
  insert into domains (organization_id, project_id, hostname)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', null, 'apex.example.com');
exception
  when insufficient_privilege then
    raise exception 'FAIL: domains over-blocked an unassigned hostname';
end;
$$;

do $$
begin
  insert into domains (organization_id, project_id, hostname)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaa1-0000-0000-0000-0000000000a1', 'own.example.com');
exception
  when insufficient_privilege then
    raise exception 'FAIL: domains over-blocked an in-organization insert';
end;
$$;

reset role;

-- ===========================================================================
-- Probe 3: project_git_links cannot reference another organization's project
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  insert into project_git_links
    (organization_id, project_id, provider, repository, secret_encrypted, secret_prefix, created_by)
  values
    ('aaaaaaaa-0000-0000-0000-00000000000a', 'bbbbbbb1-0000-0000-0000-0000000000b1',
     'github', 'acme/cross', 'v1:aa:bb:cc', 'whsec_x', '11111111-1111-1111-1111-111111111111');
  raise exception 'INTEGRITY FAIL: project_git_links accepted a cross-org project_id';
exception
  when insufficient_privilege then
    null; -- expected
end;
$$;

do $$
begin
  insert into project_git_links
    (organization_id, project_id, provider, repository, secret_encrypted, secret_prefix, created_by)
  values
    ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaa1-0000-0000-0000-0000000000a1',
     'github', 'acme/own', 'v1:aa:bb:cc', 'whsec_y', '11111111-1111-1111-1111-111111111111');
exception
  when insufficient_privilege then
    raise exception 'FAIL: project_git_links over-blocked an in-organization insert';
end;
$$;

reset role;

-- ===========================================================================
-- Probe 4: project_env_vars cannot reference another organization's project
--            or another project's environment
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  -- The gap: org id A, project_id B, environment B.
  insert into project_env_vars
    (organization_id, project_id, environment_id, key, value_encrypted, value_prefix, updated_by)
  values
    ('aaaaaaaa-0000-0000-0000-00000000000a', 'bbbbbbb1-0000-0000-0000-0000000000b1', current_setting('probe.b1env')::uuid,
     'CROSS_ORG', 'v1:aa:bb:cc', 'p', '11111111-1111-1111-1111-111111111111');
  raise exception 'INTEGRITY FAIL: project_env_vars accepted a cross-org project_id';
exception
  when insufficient_privilege then
    null; -- expected
end;
$$;

do $$
begin
  -- A same-organization project, but an environment that belongs to a
  -- *different* project: also refused.
  insert into project_env_vars
    (organization_id, project_id, environment_id, key, value_encrypted, value_prefix, updated_by)
  values
    ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaa1-0000-0000-0000-0000000000a1', current_setting('probe.b1env')::uuid,
     'WRONG_ENV', 'v1:aa:bb:cc', 'p', '11111111-1111-1111-1111-111111111111');
  raise exception 'INTEGRITY FAIL: project_env_vars accepted an environment from another project';
exception
  when insufficient_privilege then
    null; -- expected
end;
$$;

do $$
begin
  -- The control: org A's own project and its own environment still records.
  insert into project_env_vars
    (organization_id, project_id, environment_id, key, value_encrypted, value_prefix, updated_by)
  values
    ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaa1-0000-0000-0000-0000000000a1',
     current_setting('probe.a1env')::uuid,
     'OWN_KEY', 'v1:aa:bb:cc', 'p', '11111111-1111-1111-1111-111111111111');
exception
  when insufficient_privilege then
    raise exception 'FAIL: project_env_vars over-blocked an in-organization insert';
end;
$$;

reset role;

-- ===========================================================================
-- Probe 5: the UPDATE path is covered too
-- ===========================================================================

-- A row inserted legitimately must not be movable to another tenant's project.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare changed int;
begin
  update data_resources
     set project_id = 'bbbbbbb1-0000-0000-0000-0000000000b1'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and name = 'same-org';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'INTEGRITY FAIL: data_resources UPDATE moved a row across the tenant boundary (% rows)', changed;
  end if;
exception
  when insufficient_privilege then
    null; -- expected: the new row violates the WITH CHECK
end;
$$;

reset role;
