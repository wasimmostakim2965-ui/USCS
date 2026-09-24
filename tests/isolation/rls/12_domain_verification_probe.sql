-- Probe: a client must not be able to claim a domain is verified, or write any
-- other column an engine owns.
--
-- `domains.verified` is the same class of fact as a deployment's status: it is
-- the edge's observation, not the customer's assertion. `deployments` has no
-- client-facing UPDATE policy for exactly this reason; migration 0006 holds the
-- other tables to the same standard with `guard_engine_columns`.
--
-- Self-contained: it sets up its own fixtures, so it does not depend on the
-- order another probe ran in.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (as the invoking role: superuser or service_role, so the guard passes)
-- ===========================================================================

truncate domains, security_policies, data_resources, projects, organization_members,
         organizations, profiles cascade;
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

insert into domains (id, organization_id, project_id, hostname, verified, verification_token) values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'alpha.example.com', false, 'cw-original-token'),
  ('bbbbbbbb-0000-0000-0000-0000000000d2', 'bbbbbbbb-0000-0000-0000-00000000000b', null, 'beta.example.com', false, 'cw-original-token');

insert into data_resources (id, organization_id, project_id, kind, name, state) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'postgres', 'alpha-db', 'provisioning');

insert into security_policies (id, organization_id, name, state, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Baseline', 'draft', '11111111-1111-1111-1111-111111111111');

-- ===========================================================================
-- Probe: a client cannot write an engine-observed column
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  -- Alice owns org A. She must not be able to flip her own domain to verified.
  begin
    update domains set verified = true, verified_at = now()
    where id = 'aaaaaaaa-0000-0000-0000-0000000000d1';
    raise exception 'INTEGRITY FAIL: a client set domains.verified';
  exception
    when insufficient_privilege then null; -- expected: guard_engine_columns
  end;

  -- Nor choose her own challenge token, which would let her verify herself.
  begin
    update domains set verification_token = 'attacker-chosen'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000d1';
    raise exception 'INTEGRITY FAIL: a client rewrote domains.verification_token';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- Nor rename to a hostname she does not control.
  begin
    update domains set hostname = 'evil.example.com'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000d1';
    raise exception 'INTEGRITY FAIL: a client renamed a domain';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- Nor claim a data resource is ready when the engine has not said so.
  begin
    update data_resources set state = 'ready'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
    raise exception 'INTEGRITY FAIL: a client set data_resources.state = ready';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- Nor declare a security policy active at the edge.
  begin
    update security_policies set state = 'active'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000e1';
    raise exception 'INTEGRITY FAIL: a client set security_policies.state = active';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- Nor record which engine hosts their project.
  begin
    update projects set provider = 'attacker-engine', provider_resource_id = 'x'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
    raise exception 'INTEGRITY FAIL: a client set projects.provider';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- The rule is not Alice-specific: the same holds for Bob against org B.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
begin
  begin
    update domains set verified = true
    where id = 'bbbbbbbb-0000-0000-0000-0000000000d2';
    raise exception 'INTEGRITY FAIL: Bob set domains.verified';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- ===========================================================================
-- A client cannot get the same result by inserting the row pre-baked
-- ===========================================================================

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  -- An UPDATE is not the only way to assert a fact. If a client can insert a
  -- row that is already verified, the guard on UPDATE is bypassed completely.
  begin
    insert into domains (organization_id, project_id, hostname, verified)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'sneaky.example.com', true);
    raise exception 'INTEGRITY FAIL: a client inserted a pre-verified domain';
  exception
    when insufficient_privilege then null; -- expected
  end;

  begin
    insert into data_resources (organization_id, project_id, kind, name, state)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'postgres', 'sneaky-db', 'ready');
    raise exception 'INTEGRITY FAIL: a client inserted a resource already ready';
  exception
    when insufficient_privilege then null; -- expected
  end;

  begin
    insert into security_policies (organization_id, name, state, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'Sneaky', 'active', '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a client inserted a policy already active';
  exception
    when insufficient_privilege then null; -- expected
  end;

  begin
    insert into projects (organization_id, name, slug, created_by, provider)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'Sneaky', 'sneaky-proj', '11111111-1111-1111-1111-111111111111', 'attacker-engine');
    raise exception 'INTEGRITY FAIL: a client inserted a project with an engine';
  exception
    when insufficient_privilege then null; -- expected
  end;
end;
$$;

-- The honest insert still works: a member may add their own unverified domain.
do $$
begin
  insert into domains (organization_id, project_id, hostname)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'legit.example.com');
end;
$$;

-- ===========================================================================
-- The guard must not break the customer's own writes
-- ===========================================================================

-- A member may still edit the fields that are theirs: a policy's risk level and
-- action are inputs, not engine reports.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare affected int;
begin
  update security_policies set risk_level = 'high', action = 'block'
  where id = 'aaaaaaaa-0000-0000-0000-0000000000e1';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'REGRESSION FAIL: a member could not edit their own policy inputs (% rows)', affected;
  end if;

  -- Removing a domain is still allowed for an admin.
  delete from domains where id = 'aaaaaaaa-0000-0000-0000-0000000000d1';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'REGRESSION FAIL: an admin could not remove a domain (% rows)', affected;
  end if;
end;
$$;

-- ===========================================================================
-- The service role may still write the columns it owns
-- ===========================================================================

reset role;
update domains set verified = true, verified_at = now()
where id = 'bbbbbbbb-0000-0000-0000-0000000000d2';
update data_resources set state = 'ready'
where id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
update security_policies set state = 'active'
where id = 'aaaaaaaa-0000-0000-0000-0000000000e1';

do $$
begin
  if not exists (
    select 1 from domains
    where id = 'bbbbbbbb-0000-0000-0000-0000000000d2' and verified
  ) then
    raise exception 'REGRESSION FAIL: the service role could not verify a domain';
  end if;
  if not exists (
    select 1 from data_resources
    where id = 'aaaaaaaa-0000-0000-0000-0000000000c1' and state = 'ready'
  ) then
    raise exception 'REGRESSION FAIL: the service role could not provision a resource';
  end if;
end;
$$;

select 'engine-column guard probe passed' as result;
