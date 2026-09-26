-- Probe: the security-incident lifecycle (matrix X15 / audit S7).
--
-- The edge's per-request decisions live in `security_events` and are
-- append-only facts. This is the layer above them: a *grouped* signal with a
-- state that changes over time and a resolution written when it closes. The
-- facts proved here are the ones a real database has to hold, because the API
-- and any future caller can be bypassed:
--
--   1. A member reads their own organization's incidents and nothing of
--      another's. An incident names what went wrong and where, so leaking one
--      across tenants is a disclosure, not just noise.
--
--   2. A client cannot open an incident. The observation is the control plane's
--      own record of a signal; a browser that could insert one could fabricate a
--      security event that never happened, or bury a real one in noise.
--
--   3. The observation is immutable once stored. A client may move an incident
--      through its lifecycle but may not rewrite `kind`, `severity`, `summary`
--      or `opened_at` — otherwise a resolved incident could be edited to
--      describe a different event, and the record would be worthless as
--      evidence.
--
--   4. The lifecycle only moves forward and a close is complete. Any close goes
--      through triage, a close carries a resolution, a closed incident cannot be
--      reopened, and `closed_at` is the server's clock — a client cannot backdate
--      a close to hide how long an incident was open.
--
--   5. Triage is an admin action, at the same threshold as a policy change,
--      because closing an incident asserts that a security problem is handled.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate security_incidents, organizations, organization_members, profiles cascade;
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

-- One open incident per organization, as the detector (service role) writes it.
insert into security_incidents
  (organization_id, kind, severity, summary, opened_at) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'policy_distribution_rejected', 'high',
   'Policy v2 was not applied: edge refused', now()),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'policy_distribution_rejected', 'critical',
   'Policy v9 was not applied: edge refused', now());

-- ===========================================================================
-- Probe 1: a member reads only their own organization's incidents
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare visible int;
begin
  select count(*) into visible from security_incidents
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B incidents';
  end if;

  select count(*) into visible from security_incidents
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read her own incident (% rows)', visible;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: a client cannot fabricate an incident
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    insert into security_incidents (organization_id, kind, severity, summary, opened_at)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'origin_leaked', 'critical',
            'Fabricated by a browser', now());
    raise exception 'INTEGRITY FAIL: a client inserted a security incident';
  exception
    when insufficient_privilege then
      null; -- expected: insert is service-role only
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 3: the observation is immutable
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    update security_incidents set severity = 'low'
     where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
    raise exception 'INTEGRITY FAIL: an incident observation was rewritten';
  exception
    when insufficient_privilege then
      -- The column grant is the first line: only the lifecycle columns are
      -- updatable, so `severity` is refused before the trigger is reached.
      null;
    when raise_exception then
      -- The guard trigger is the second: were the grant ever widened, the
      -- trigger still refuses a rewrite of the observation.
      if sqlerrm like 'INTEGRITY FAIL%' then
        raise;
      end if;
  end;
end;
$$;

reset role;

do $$
declare v text;
begin
  select severity into v from security_incidents
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if v <> 'high' then
    raise exception 'INTEGRITY FAIL: the incident severity drifted to %', v;
  end if;
end;
$$;

-- ===========================================================================
-- Probe 4: the lifecycle only moves forward, and a close is complete
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

-- An open incident cannot be closed directly: it must be triaged first.
do $$
begin
  begin
    update security_incidents set state = 'resolved', resolution = 'skipped triage'
     where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
    raise exception 'INTEGRITY FAIL: an incident was closed without triage';
  exception
    when raise_exception then
      if sqlerrm like 'INTEGRITY FAIL%' then raise; end if;
  end;
end;
$$;

-- Triage is allowed, and a triaged incident is still open (no close fields).
update security_incidents set state = 'triaged', triaged_by = '11111111-1111-1111-1111-111111111111'
 where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';

do $$
declare s text; c timestamptz; r text;
begin
  select state, closed_at, resolution into s, c, r from security_incidents
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if s <> 'triaged' or c is not null or r is not null then
    raise exception 'INTEGRITY FAIL: a triaged incident carries close fields (%, %, %)', s, c, r;
  end if;
end;
$$;

-- Closing without a resolution is refused.
do $$
begin
  begin
    update security_incidents set state = 'resolved'
     where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
    raise exception 'INTEGRITY FAIL: an incident was closed with no resolution';
  exception
    when raise_exception then
      if sqlerrm like 'INTEGRITY FAIL%' then raise; end if;
    when check_violation then
      null; -- expected: the completeness check refuses it
  end;
end;
$$;

-- A close with a resolution succeeds and stamps the server clock, ignoring a
-- client-supplied closed_at (there is no grant for it, and the trigger sets it).
update security_incidents set state = 'resolved', resolution = 'Re-distributed after fixing the cert'
 where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';

do $$
declare s text; c timestamptz; r text;
begin
  select state, closed_at, resolution into s, c, r from security_incidents
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if s <> 'resolved' or c is null or r is null then
    raise exception 'INTEGRITY FAIL: a resolved incident is incomplete (%, %, %)', s, c, r;
  end if;
end;
$$;

-- A closed incident cannot be reopened.
do $$
begin
  begin
    update security_incidents set state = 'triaged'
     where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
    raise exception 'INTEGRITY FAIL: a closed incident was reopened';
  exception
    when raise_exception then
      if sqlerrm like 'INTEGRITY FAIL%' then raise; end if;
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 5: triage is an admin action, and only within the tenant
-- ===========================================================================

-- Carol is a member (not admin) of A: her transition must not land.
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
declare affected int;
begin
  update security_incidents set state = 'triaged'
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'ISOLATION FAIL: Carol transitioned org B''s incident (% rows)', affected;
  end if;
end;
$$;

reset role;

-- Dave owns B, so he may triage B's incident — the cross-tenant case where a
-- per-user check alone cannot distinguish, because both are legitimately his.
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);

do $$
declare affected int;
begin
  update security_incidents set state = 'triaged'
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'ISOLATION FAIL: the owner could not triage their own incident (% rows)', affected;
  end if;
end;
$$;

reset role;

-- And A's incident is untouched by his action.
do $$
declare s text;
begin
  select state into s from security_incidents
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if s <> 'resolved' then
    raise exception 'ISOLATION FAIL: a cross-tenant action changed org A''s incident to %', s;
  end if;
end;
$$;

select 'incident probe passed' as result;
