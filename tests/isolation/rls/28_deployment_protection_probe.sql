-- Probe: deployment protection (matrix P12 / audit D7).
--
-- Deployment protection is what keeps a preview URL from being a public URL.
-- Five facts are proved here, each the kind only a real database can prove:
--
--   1. A member reads their own organization's posture and nothing of another's.
--      A posture is a control record, so leaking one across tenants would tell a
--      tenant that another has left a preview open.
--
--   2. Only an admin may set protection, and it is always attributed. Enabling
--      or disabling protection, or rewriting its password or allow-list, is an
--      admin act — a mis-set allow-list is a self-inflicted lockout or an
--      accidental exposure, and neither is a member's routine click.
--
--   3. The mode decides which fields are present. A `password` row names a user
--      and a hash; an `ip` row names at least one address; a `none` row names
--      neither. A half-specified posture is refused at the table, so it can never
--      be stored and read back as if it worked — the class of bug ADR-0006/0009
--      record as "there is no UPDATE policy is not the same as the column is
--      protected".
--
--   4. The password hash is never selectable by a client, exactly as an API key
--      hash is not (`0002`). A leaked digest would let an attacker verify guesses
--      offline, so a browser may read the mode and the user, never the digest.
--
--   5. The edge's own handle (`engine_ref`, `provider`) is engine-observed, not a
--      client's assertion: a client cannot claim a protection was applied by an
--      edge, and cannot move it to another resource.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate project_deployment_protection, projects, organizations, organization_members,
         profiles cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com');

insert into profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', 'Carol'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com', 'Dave')
on conflict (id) do update set display_name = excluded.display_name, email = excluded.email;

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Org B', 'org-b', '44444444-4444-4444-4444-444444444444');

-- Alice owns A; Carol is only a member of A; Dave owns B.
insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'owner');

insert into projects (id, organization_id, name, slug, created_by) values
  ('00000000-0000-0000-0000-00000000a001', 'aaaaaaaa-0000-0000-0000-00000000000a', 'App A', 'app-a',
   '11111111-1111-1111-1111-111111111111'),
  ('00000000-0000-0000-0000-00000000b001', 'bbbbbbbb-0000-0000-0000-00000000000b', 'App B', 'app-b',
   '44444444-4444-4444-4444-444444444444');

-- One protected project in each organization. A's is password-protected; B's is
-- IP-restricted. The hash is a real 64-hex digest, so the table's check is met.
insert into project_deployment_protection
  (organization_id, project_id, mode, basic_user, basic_password_hash, allowed_cidrs, updated_by)
values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001', 'password',
   'preview', repeat('a', 64), '{}', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000b001', 'ip',
   null, null, array['203.0.113.0/24', '198.51.100.7/32'], '44444444-4444-4444-4444-444444444444');

-- ===========================================================================
-- Probe 1: a member reads only their own organization's posture
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare visible int;
begin
  select count(*) into visible from project_deployment_protection
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B deployment protection';
  end if;

  select count(*) into visible from project_deployment_protection
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice cannot read her own protection row (% rows)', visible;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: only an admin sets protection, and it is always attributed
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
begin
  begin
    insert into project_deployment_protection
      (organization_id, project_id, mode, updated_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001', 'none',
            '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: a member set deployment protection';
  exception
    when insufficient_privilege then
      null; -- expected: set is admin-only
  end;

  begin
    insert into project_deployment_protection
      (organization_id, project_id, mode, updated_by)
    values ('bbbbbbbb-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000b001', 'none',
            '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: Carol set protection on org B';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end;
$$;

reset role;

-- An admin cannot attribute a protection change to someone else: updated_by must
-- be the caller, so the audit reader can trust who changed the posture.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    insert into project_deployment_protection
      (organization_id, project_id, mode, updated_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001', 'none',
            '33333333-3333-3333-3333-333333333333');
    raise exception 'INTEGRITY FAIL: an admin attributed protection to another user';
  exception
    when insufficient_privilege then
      null; -- expected: updated_by = auth.uid() is enforced
  end;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 3: the mode decides which fields are present
-- ===========================================================================

do $$
begin
  -- password mode without a user/hash is half-specified.
  begin
    insert into project_deployment_protection (organization_id, project_id, mode, updated_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001',
            'password', '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a password row with no user/hash was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  -- ip mode with no address protects nothing.
  begin
    insert into project_deployment_protection (organization_id, project_id, mode, updated_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001',
            'ip', '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: an ip row with no address was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  -- none mode carrying a password is contradictory.
  begin
    insert into project_deployment_protection
      (organization_id, project_id, mode, basic_user, basic_password_hash, updated_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001',
            'none', 'preview', repeat('b', 64), '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a none row carrying a password was accepted';
  exception
    when check_violation then
      null; -- expected
  end;

  -- A password hash that is not a SHA-256 hex digest must never be stored.
  begin
    insert into project_deployment_protection
      (organization_id, project_id, mode, basic_user, basic_password_hash, updated_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001',
            'password', 'preview', 'not-a-digest', '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a non-digest password hash was accepted';
  exception
    when check_violation then
      null; -- expected
  end;
end;
$$;

-- One posture per project: a second row is a no-op, not a competing setting.
do $$
begin
  begin
    insert into project_deployment_protection
      (organization_id, project_id, mode, allowed_cidrs, updated_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001',
            'ip', array['10.0.0.0/8'], '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a second protection row for one project was accepted';
  exception
    when unique_violation then
      null; -- expected
  end;
end;
$$;

-- ===========================================================================
-- Probe 4: the password hash is never selectable by a client
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    perform basic_password_hash from project_deployment_protection;
    raise exception 'SECURITY FAIL: a client can select the protection password hash';
  exception
    when insufficient_privilege then
      null; -- expected: the digest is not in the client SELECT grant
  end;
end;
$$;

-- The safe columns are readable: the mode and the user, but not the digest.
do $$
declare m text;
begin
  select mode into m from project_deployment_protection
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if m <> 'password' then
    raise exception 'SECURITY FAIL: a client cannot read the protection mode (got %)', m;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 5: the edge's handle is engine-observed, not a client's assertion
-- ===========================================================================

-- A client cannot insert a row that claims an engine already applied it.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    insert into project_deployment_protection
      (organization_id, project_id, mode, engine_ref, provider, updated_by)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000a001',
            'none', 'claimed-ref', 'edge', '11111111-1111-1111-1111-111111111111');
    raise exception 'INTEGRITY FAIL: a client inserted a protection row with engine_ref set';
  exception
    when insufficient_privilege then
      null; -- expected: engine columns cannot be set by a client on INSERT
  end;
end;
$$;

-- Nor can a client update the engine handle on an existing row.
do $$
declare affected int;
begin
  update project_deployment_protection set engine_ref = 'claimed-ref'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  get diagnostics affected = row_count;
  -- If the trigger fired it raised; if it was silently filtered, no row changed.
  if affected > 0 then
    raise exception 'INTEGRITY FAIL: a client set an engine column (% rows)', affected;
  end if;
exception
  when insufficient_privilege then
    null; -- expected: the guard raises rather than silently dropping
end;
$$;

reset role;

-- The service role can write the engine handle, which is how the adapter's
-- answer is recorded after a distribution.
update project_deployment_protection
   set engine_ref = 'edge-ref-1', provider = 'edge', provider_resource_id = 'res-1'
 where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';

do $$
declare r text;
begin
  select engine_ref into r from project_deployment_protection
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if r <> 'edge-ref-1' then
    raise exception 'INTEGRITY FAIL: the service role could not record the engine handle (got %)', r;
  end if;
end;
$$;

select 'deployment protection probe passed' as result;
