-- Probe: member management is bounded by rank (migration 0020).
--
-- `organizations.members.list` proved membership can be read. This is the write
-- half, and the interesting facts are the ones a buggy policy would get wrong:
--
--   1. A member reads their own organization's members and nothing of another's.
--
--   2. An owner can change a member's role, and the change is stored.
--
--   3. A member cannot promote themselves. `role = 'owner'` in one statement is
--      the classic self-escalation, and it is refused because the UPDATE policy
--      forbids editing your own row at all.
--
--   4. An admin cannot demote an owner or grant the owner role. Rank is a
--      ceiling, not just a floor: an admin who could mint owners has the
--      organization's ownership.
--
--   5. The last owner cannot be demoted or removed. An organization left with
--      no owner cannot be managed, and neither the UPDATE nor the DELETE policy
--      may allow it.
--
--   6. A member may remove themselves — leaving is a normal action — but not
--      anyone else, and an outsider cannot touch the tenant at all.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate organization_members, organizations, profiles cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com');

insert into profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', 'Carol'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com', 'Dave');

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Org B', 'org-b', '44444444-4444-4444-4444-444444444444');

-- Org A: Alice owner, Bob admin, Carol member. Org B: Dave owner.
insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222', 'admin'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'owner');

-- ===========================================================================
-- Probe 1: a member reads only their own organization's members
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare visible int;
begin
  select count(*) into visible from organization_members
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B members';
  end if;

  select count(*) into visible from organization_members
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if visible <> 3 then
    raise exception 'ISOLATION FAIL: Alice cannot read her own members (% rows)', visible;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 2: an owner can change a member's role
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare changed int;
begin
  update organization_members set role = 'admin'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and user_id = '33333333-3333-3333-3333-333333333333';
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'FAIL: owner could not promote a member (% rows)', changed;
  end if;
end;
$$;

reset role;

-- Put Carol back so the later probes read cleanly.
update organization_members set role = 'member'
 where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
   and user_id = '33333333-3333-3333-3333-333333333333';

-- ===========================================================================
-- Probe 3: a member cannot promote themselves
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
declare changed int;
begin
  update organization_members set role = 'owner'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and user_id = '33333333-3333-3333-3333-333333333333';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ESCALATION FAIL: a member promoted themselves (% rows)', changed;
  end if;
exception
  when insufficient_privilege then
    null; -- expected: the new row would violate the policy
end;
$$;

reset role;

-- ===========================================================================
-- Probe 4: an admin cannot touch an owner, nor grant the owner role
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
declare changed int;
begin
  -- 4a. Demote the owner who appointed them. The USING clause hides the row, so
  --     this matches nothing rather than raising.
  update organization_members set role = 'member'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and user_id = '11111111-1111-1111-1111-111111111111';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ESCALATION FAIL: an admin demoted an owner (% rows)', changed;
  end if;
exception
  when insufficient_privilege then
    null; -- also an acceptable refusal
end;
$$;

do $$
declare changed int;
begin
  -- 4b. Mint a second owner. The row is visible to the admin, but the new row
  --     fails WITH CHECK, which is an error rather than an empty update.
  update organization_members set role = 'owner'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and user_id = '33333333-3333-3333-3333-333333333333';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ESCALATION FAIL: an admin granted the owner role (% rows)', changed;
  end if;
exception
  when insufficient_privilege then
    null; -- expected: new row violates the policy
end;
$$;

reset role;

-- ===========================================================================
-- Probe 5: the last owner cannot be demoted or removed
-- ===========================================================================

-- Org B has exactly one owner, Dave. He may not demote himself...
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);

do $$
declare changed int;
begin
  update organization_members set role = 'member'
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b'
     and user_id = '44444444-4444-4444-4444-444444444444';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'FAIL: the last owner demoted themselves (% rows)', changed;
  end if;

  -- ...nor remove himself, or the organization would have no owner.
  delete from organization_members
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b'
     and user_id = '44444444-4444-4444-4444-444444444444';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'FAIL: the last owner removed themselves (% rows)', changed;
  end if;
exception
  when insufficient_privilege then
    null; -- an error refusal is equally acceptable
end;
$$;

reset role;

-- ===========================================================================
-- Probe 6: a member may leave, but not remove anyone else
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
declare changed int;
begin
  -- Carol cannot remove Bob (an admin).
  delete from organization_members
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and user_id = '22222222-2222-2222-2222-222222222222';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ESCALATION FAIL: a member removed an admin (% rows)', changed;
  end if;

  -- Carol can remove herself: leaving is a normal action.
  delete from organization_members
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and user_id = '33333333-3333-3333-3333-333333333333';
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'FAIL: a member could not leave (% rows)', changed;
  end if;
exception
  when insufficient_privilege then
    raise exception 'FAIL: a member could not leave (policy refused self-removal)';
end;
$$;

reset role;

-- ===========================================================================
-- Probe 7: an outsider cannot touch the tenant
-- ===========================================================================

-- Dave owns B, not A. Every write against A is invisible to him.
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);

do $$
declare changed int;
begin
  update organization_members set role = 'viewer'
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and user_id = '22222222-2222-2222-2222-222222222222';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ISOLATION FAIL: an outsider changed org A members (% rows)', changed;
  end if;

  delete from organization_members
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'ISOLATION FAIL: an outsider deleted org A members (% rows)', changed;
  end if;
exception
  when insufficient_privilege then
    null; -- an error refusal is equally acceptable
end;
$$;

reset role;

-- ===========================================================================
-- Probe 8: the guard does not over-block — a non-last owner may still leave
-- ===========================================================================

-- Give org A a second owner (Bob) and let Carol rejoin as a member, then have
-- Bob leave. Alice is still an owner, so Bob is not the last owner and the
-- removal must succeed. This is the case a too-strict guard would break.
update organization_members set role = 'owner'
 where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
   and user_id = '22222222-2222-2222-2222-222222222222';
insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member')
  on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

do $$
declare changed int;
begin
  delete from organization_members
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a'
     and user_id = '22222222-2222-2222-2222-222222222222';
  get diagnostics changed = row_count;
  if changed <> 1 then
    raise exception 'FAIL: a non-last owner could not leave (% rows)', changed;
  end if;
exception
  when insufficient_privilege then
    raise exception 'FAIL: the last-owner guard over-blocked a non-last owner';
end;
$$;

reset role;
