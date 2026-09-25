-- Probe: trusted source addresses (matrix X13 / audit B7).
--
-- The deny list answers "what must the edge block". This is the other half:
-- an operator's own webhook senders and CI runners must survive attack mode.
-- Four facts are proved here, each the kind only a real database can prove:
--
--   1. A member reads their own organization's trusted sources and nothing of
--      another's — a trusted address is an allow, so leaking one across tenants
--      would let one tenant admit another's sender.
--
--   2. Only an admin may add a trusted source, and it is always attributed.
--      A trusted address an attacker could add is a bypass, so this is the same
--      threshold the deny list sets.
--
--   3. The value grammar holds at the table even when the API is bypassed: a
--      hostname (which would have to be resolved and is attacker-influenced) and
--      a multi-line value (which could close a Coraza argument) are both refused.
--
--   4. A source is add-or-remove, never silently edited: there is no UPDATE
--      grant, so the address that was allowed is the address that was recorded.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate security_trusted_sources, organizations, organization_members, profiles cascade;
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

-- One trusted source for each organization, written by its admin.
insert into security_trusted_sources (organization_id, kind, value, note, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'ip', '198.51.100.7', 'GitHub webhooks', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'cidr', '192.0.2.0/24', 'CI runners', '44444444-4444-4444-4444-444444444444');

-- ===========================================================================
-- Probe 1: a member reads only their own organization's trusted sources
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare visible int;
begin
  select count(*) into visible from security_trusted_sources
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B trusted sources';
  end if;

  select count(*) into visible from security_trusted_sources
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read her own trusted source (% rows)', visible;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: only an admin adds a trusted source, and it is always attributed
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
begin
  begin
    insert into security_trusted_sources (organization_id, kind, value, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'ip', '10.9.9.9',
            '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: a member added a trusted source';
  exception
    when insufficient_privilege then
      null; -- expected: add is admin-only
  end;

  begin
    insert into security_trusted_sources (organization_id, kind, value, created_by)
    values ('bbbbbbbb-0000-0000-0000-00000000000b', 'ip', '10.9.9.9',
            '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: Carol added a trusted source to org B';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end;
$$;

reset role;

-- An admin cannot attribute a source to someone else: created_by must be the
-- caller, so the audit reader can trust who allowed the address.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    insert into security_trusted_sources (organization_id, kind, value, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'ip', '10.9.9.10',
            '33333333-3333-3333-3333-333333333333');
    raise exception 'INTEGRITY FAIL: an admin attributed a trusted source to another user';
  exception
    when insufficient_privilege then
      null; -- expected: created_by = auth.uid() is enforced
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 3: the value grammar holds at the table, even bypassing the API
-- ===========================================================================

do $$
begin
  -- A hostname would have to be resolved, and the DNS answer is
  -- attacker-influenced, so a name must never become an allow.
  begin
    insert into security_trusted_sources (organization_id, kind, value, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'ip', 'hooks.example.com',
            '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a hostname was accepted as a trusted source';
  exception
    when check_violation then
      null; -- expected
  end;

  -- A value with a quote or newline could close a Coraza argument.
  begin
    insert into security_trusted_sources (organization_id, kind, value, created_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'cidr', '1.1.1.1" \nSecRuleEngine Off',
            '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a multi-line trusted value was accepted';
  exception
    when check_violation then
      null; -- expected
  end;
end;
$$;

-- ===========================================================================
-- Probe 4: a source is add-or-remove, never silently edited
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

-- There is no UPDATE policy, so the statement matches zero rows rather than
-- raising: the row that was allowed is the row that stays recorded. The check
-- is that nothing changed, which a zero row count shows.
do $$
declare affected int;
begin
  update security_trusted_sources set value = '10.9.9.11'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'INTEGRITY FAIL: a trusted source was edited in place (% rows)', affected;
  end if;
end;
$$;

reset role;

-- Read back on the service role: the fixture value is untouched.
do $$
declare v text;
begin
  select value into v from security_trusted_sources
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if v <> '198.51.100.7' then
    raise exception 'INTEGRITY FAIL: the trusted source value drifted to %', v;
  end if;
end;
$$;
