-- Probe: per-route request rate limits (matrix X12 / audit S8).
--
-- The deny list answers "what must the edge block". This is the neighbouring
-- question: what may the edge *throttle* so a scraper walking a catalogue is
-- made uneconomic while a normal visitor, a crawler and a customer's own webhook
-- sender are untouched. Five facts are proved here, each the kind only a real
-- database can prove:
--
--   1. A member reads their own organization's limits and nothing of another's.
--      A limit is the route's budget, so leaking one across tenants would let a
--      tenant see (and reason about) another's traffic shape.
--
--   2. Only an admin may set a limit, and it is always attributed. A limit so
--      low it denies everyone is a self-inflicted outage, so it is a deliberate
--      admin action, the same threshold the deny list sets.
--
--   3. The key/header pairing and the numeric bounds hold at the table even when
--      the API is bypassed: a half-specified header rule and an absurd limit are
--      both refused, so a bad value can never reach the compiler.
--
--   4. A limit is set-or-remove, never silently edited: there is no UPDATE
--      grant, so the limit that throttled a request is the limit recorded.
--
--   5. The recorded-decision stages the compiler emits (`allow-trusted-ip`,
--      `ratelimit`) are accepted by `security_events.stage`, which they were not
--      before `0018` — an edge reporting either decision had its insert rejected
--      and the decision was silently unrecordable.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate security_rate_limits, security_events, organizations, organization_members,
         profiles cascade;
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

-- One limit for each organization, written by its admin.
insert into security_rate_limits
  (organization_id, key, header_name, limit_count, window_seconds, note, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'ip', null, 120, 60, 'Catalogue crawl budget',
   '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'header', 'x-api-key', 600, 60, 'Partner API',
   '44444444-4444-4444-4444-444444444444');

-- ===========================================================================
-- Probe 1: a member reads only their own organization's limits
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare visible int;
begin
  select count(*) into visible from security_rate_limits
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B rate limits';
  end if;

  select count(*) into visible from security_rate_limits
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read her own rate limit (% rows)', visible;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: only an admin sets a limit, and it is always attributed
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
begin
  begin
    insert into security_rate_limits (organization_id, key, limit_count, window_seconds, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'global', 10, 60,
            '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: a member set a rate limit';
  exception
    when insufficient_privilege then
      null; -- expected: set is admin-only
  end;

  begin
    insert into security_rate_limits (organization_id, key, limit_count, window_seconds, created_by)
    values ('bbbbbbbb-0000-0000-0000-00000000000b', 'global', 10, 60,
            '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: Carol set a rate limit on org B';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end;
$$;

reset role;

-- An admin cannot attribute a limit to someone else: created_by must be the
-- caller, so the audit reader can trust who set the budget.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    insert into security_rate_limits (organization_id, key, limit_count, window_seconds, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'global', 10, 60,
            '33333333-3333-3333-3333-333333333333');
    raise exception 'INTEGRITY FAIL: an admin attributed a rate limit to another user';
  exception
    when insufficient_privilege then
      null; -- expected: created_by = auth.uid() is enforced
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 3: the pairing and the numeric bounds hold at the table
-- ===========================================================================

do $$
begin
  -- key='header' with no header_name is half-specified, and key='ip' with a
  -- header_name is contradictory. Both must be refused.
  begin
    insert into security_rate_limits (organization_id, key, limit_count, window_seconds, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'header', 10, 60,
            '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a header-keyed limit without a header name was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  begin
    insert into security_rate_limits
      (organization_id, key, header_name, limit_count, window_seconds, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'ip', 'x-api-key', 10, 60,
            '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: an ip-keyed limit carrying a header name was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  -- The bounds are the compiler's backstop: a zero limit would deny everyone,
  -- and an unbounded window is not a rate limit.
  begin
    insert into security_rate_limits (organization_id, key, limit_count, window_seconds, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'global', 0, 60,
            '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a zero-count rate limit was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  begin
    insert into security_rate_limits (organization_id, key, limit_count, window_seconds, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'global', 10, 999999,
            '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: an out-of-range window was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  -- A header name that could close a Coraza argument must never be stored.
  begin
    insert into security_rate_limits
      (organization_id, key, header_name, limit_count, window_seconds, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'header', 'x-api-key" SecRuleEngine Off',
            10, 60, '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a multi-token header name was accepted';
  exception
    when check_violation then
      null; -- expected
  end;
end;
$$;

-- A duplicate key/header pair is a no-op, not two competing limits.
do $$
declare affected int;
begin
  begin
    insert into security_rate_limits (organization_id, key, limit_count, window_seconds, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'ip', 999, 60,
            '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a duplicate key/header pair was accepted';
  exception
    when unique_violation then
      null; -- expected
  end;
end;
$$;

-- ===========================================================================
-- Probe 4: a limit is set-or-remove, never silently edited
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

-- There is no UPDATE policy, so the statement matches zero rows rather than
-- raising: the limit that was set is the limit that stays recorded.
do $$
declare affected int;
begin
  update security_rate_limits set limit_count = 5
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'INTEGRITY FAIL: a rate limit was edited in place (% rows)', affected;
  end if;
end;
$$;

reset role;

-- Read back on the service role: the fixture value is untouched.
do $$
declare v int;
begin
  select limit_count into v from security_rate_limits
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if v <> 120 then
    raise exception 'INTEGRITY FAIL: the rate limit drifted to %', v;
  end if;
end;
$$;

-- ===========================================================================
-- Probe 5: the stages the compiler emits are recordable
-- ===========================================================================

-- Before `0018` widened the check, an edge reporting an allow-trusted-ip or a
-- ratelimit decision had the insert rejected, so the decision existed only in
-- the engine. Both must now be accepted.
insert into security_events
  (organization_id, host, stage, action, client_ip, observed_at)
values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'app.example.com', 'allow-trusted-ip', 'allow',
   '198.51.100.7', now()),
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'app.example.com', 'ratelimit', 'quarantine',
   '203.0.113.9', now());

do $$
declare n int;
begin
  select count(*) into n from security_events
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and stage in ('allow-trusted-ip', 'ratelimit');
  if n <> 2 then
    raise exception 'INTEGRITY FAIL: % of 2 new decision stages were recordable', n;
  end if;
end;
$$;

select 'rate limit probe passed' as result;
