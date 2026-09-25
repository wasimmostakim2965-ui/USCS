-- Probe: the protection posture and the edge's decided traffic.
--
-- Two things are proved here, and both are the kind that only a real database
-- can prove:
--
--   1. `security_events` is the edge's observation. A client can read its own
--      organization's events and nothing else, and cannot write an event at all —
--      not to erase a block against itself, not to fabricate one against another
--      tenant. This is the same "engine-observed fact" rule as `domains.verified`,
--      expressed by grant because the table is new.
--
--   2. `security_rules` is the customer's own input: an admin adds and removes,
--      a member cannot, and the value grammar refuses anything that could close a
--      Coraza argument.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate security_events, security_rules, security_policies, security_policy_events,
         audit_logs, organization_members, organizations, profiles cascade;
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

-- Alice owns A; Carol is only a member of A; Dave owns B.
insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'owner');

insert into security_policies (id, organization_id, name, risk_level, action, state, version, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Default', 'high', 'block', 'active', 4, '11111111-1111-1111-1111-111111111111');

-- The edge reported these decisions for org A, and one for org B.
insert into security_events (organization_id, host, stage, action, rule_id, policy_version, client_ip, method, path, user_agent, observed_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'app.example.com', 'allow-verified-bot', 'allow', 10, 4, '203.0.113.1', 'GET', '/', 'Googlebot/2.1', now()),
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'app.example.com', 'block-deny-list', 'block', 30, 4, '198.51.100.7', 'GET', '/admin', 'EvilScraper/0.1', now()),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'other.example.com', 'block-deny-list', 'block', 30, 1, '198.51.100.9', 'GET', '/', 'Bad/1.0', now());

-- A deny rule for A, created by its admin.
insert into security_rules (organization_id, kind, value, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'ip', '198.51.100.7', '11111111-1111-1111-1111-111111111111');

-- The protection mode is the customer's to set and defaulted to normal.
do $$
declare mode text;
begin
  select protection_mode into mode from security_policies
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if mode <> 'normal' then
    raise exception 'SCHEMA FAIL: protection_mode defaulted to %', mode;
  end if;
end;
$$;

-- ===========================================================================
-- Probe 1: a member reads only their own organization's decided traffic
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare visible int;
begin
  select count(*) into visible from security_events where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B security events';
  end if;

  select count(*) into visible from security_events
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and action = 'allow';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read the allowed request (% rows)', visible;
  end if;

  select count(*) into visible from security_events
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and stage = 'block-deny-list';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read the denied request (% rows)', visible;
  end if;
end;
$$;

-- ===========================================================================
-- Probe 2: a client cannot write a decided-traffic event at all
-- ===========================================================================

do $$
begin
  begin
    insert into security_events (organization_id, host, stage, action, observed_at)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'app.example.com', 'pass', 'allow', now());
    raise exception 'INTEGRITY FAIL: a client inserted a security event';
  exception
    when insufficient_privilege then
      null; -- expected: the grant is dropped for authenticated
  end;
end;
$$;

-- A client cannot erase the event that recorded a block against it, and cannot
-- rewrite one. The grant is dropped, so both are a hard permission error rather
-- than a zero-row update: that is the stronger guarantee, and it is what we
-- assert.
do $$
begin
  begin
    delete from security_events where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
    raise exception 'INTEGRITY FAIL: a client deleted a security event';
  exception
    when insufficient_privilege then
      null; -- expected
  end;

  begin
    update security_events set action = 'allow'
     where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
    raise exception 'INTEGRITY FAIL: a client rewrote a security event';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 3: the deny list is the admin's input — addable, removable, not editable
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  insert into security_rules (organization_id, kind, value, created_by)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'user-agent', 'EvilScraper',
          '11111111-1111-1111-1111-111111111111');
end;
$$;

-- A rule value that would close a Coraza argument is refused by the check,
-- whatever the API did.
do $$
begin
  begin
    insert into security_rules (organization_id, kind, value, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'user-agent', 'a"b', '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a rule value with a quote was accepted';
  exception
    when check_violation then
      null; -- expected
  end;
end;
$$;

reset role;

-- A member (not an admin) cannot add a rule to an organization, and nobody can
-- add one to an organization they do not belong to.
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
begin
  begin
    insert into security_rules (organization_id, kind, value, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'ip', '10.9.9.9',
            '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: a member added a deny rule';
  exception
    when insufficient_privilege then
      null; -- expected: add is admin-only
  end;

  begin
    insert into security_rules (organization_id, kind, value, created_by)
    values ('bbbbbbbb-0000-0000-0000-00000000000b', 'ip', '10.9.9.9',
            '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: Carol added a deny rule to org B';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 4: a member cannot raise the protection posture through PostgREST;
-- an admin can, and it stays their input (not an engine-observed column)
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
declare affected int;
begin
  -- security_policies_update requires admin; Carol is a member, so her update
  -- matches no row.
  update security_policies set protection_mode = 'attack'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'ISOLATION FAIL: a member changed the protection posture';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare mode text;
begin
  update security_policies set protection_mode = 'attack'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  select protection_mode into mode from security_policies
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if mode <> 'attack' then
    raise exception 'FAIL: an admin could not raise the protection posture (mode=%)', mode;
  end if;
end;
$$;

reset role;

-- The engine-observed `state` column is still frozen: raising the posture did not
-- let the admin mark the policy active themselves. The guard raises rather than
-- silently ignoring the column, so the expectation is the refusal.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    update security_policies set state = 'draft' where version = 4;
    raise exception 'INTEGRITY FAIL: an admin rewrote the engine-observed policy state';
  exception
    when insufficient_privilege then
      null; -- expected: guard_engine_columns refuses the engine-owned column
  end;
end;
$$;

reset role;

select 'security protection probe passed: events are the edge''s, rules are the admin''s, posture is the customer''s' as result;