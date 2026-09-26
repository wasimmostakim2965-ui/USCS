-- ---------------------------------------------------------------------------
-- 0020 — member role changes and removal are bounded by rank
--
-- The first-cut policies in 0002 gated both UPDATE and DELETE on
-- `role_at_least(organization_id, 'admin')` and nothing else. That is not
-- enough, and the holes are privilege escalation, not cosmetics:
--
--   1. An *admin* could rewrite an owner's membership. `using` only asked that
--      the caller be an admin, so an admin could demote the owner who appointed
--      them, or promote a second owner, and the organization's ownership would
--      be theirs to move.
--
--   2. A member could rewrite *their own* row, because their own row was in the
--      same organization and the caller's rank was read from that same row. A
--      viewer could set `role = 'owner'` in one statement — self-promotion with
--      no second party.
--
--   3. The last owner could be removed or demoted, leaving the organization
--      with nobody who can manage it. The DELETE policy guarded the *last*
--      owner but the UPDATE policy guarded nothing, so demotion was the way in.
--
-- This migration restates both policies so rank is a ceiling as well as a
-- floor: an owner may act on anyone, an admin only on non-owners, and nobody
-- may edit their own role. A member may still remove *themselves* (leaving an
-- organization is a normal action and today it is impossible). The last-owner
-- guard is a shared helper so the two policies cannot drift apart.
--
-- The API re-checks all of this in `organizations.members.*`; this is the layer
-- that holds even when a caller talks to PostgREST with their own JWT.
-- ---------------------------------------------------------------------------

-- The last-owner test, named once. `security definer` for the same reason the
-- other scope helpers are: it reads `organization_members`, and an invoker-side
-- function inside a policy on that table would recurse into the policy.
create or replace function public.is_last_owner(target_org uuid, target_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    (select role from organization_members
      where organization_id = target_org and user_id = target_user) = 'owner'
    and not exists (
      select 1 from organization_members other
       where other.organization_id = target_org
         and other.role = 'owner'
         and other.user_id <> target_user
    );
$$;

comment on function public.is_last_owner(uuid, uuid) is
  'True when the user is the only owner of the organization. Guards the last-owner invariant for both member UPDATE and DELETE.';

drop policy organization_members_update on organization_members;
drop policy organization_members_delete on organization_members;

-- A role change. `using` sees the OLD row, `with check` the NEW one, so an
-- owner→member demotion and an admin→owner promotion are each judged on the
-- side of the change where the danger lives.
create policy organization_members_update on organization_members for update to authenticated
using (
  -- Nobody edits their own membership: promotion and demotion both need a
  -- second party, which is what makes "an admin cannot escalate" true.
  user_id <> auth.uid()
  and (
    public.role_in(organization_id) = 'owner'
    -- An admin may change a non-owner's role, but not into or out of owner.
    or (public.role_at_least(organization_id, 'admin') and role <> 'owner')
  )
)
with check (
  user_id <> auth.uid()
  and (
    public.role_in(organization_id) = 'owner'
    or (public.role_at_least(organization_id, 'admin') and role <> 'owner')
  )
  -- Never leave the organization ownerless. An owner demoting another owner
  -- always has a second owner left (themselves), so this only bites the
  -- last-owner case, but it is stated where a reader will look for it.
  and not public.is_last_owner(organization_id, user_id)
);

-- Removal. Self-removal is allowed so a member can leave; anyone else needs to
-- outrank the row they are removing.
create policy organization_members_delete on organization_members for delete to authenticated
using (
  (
    user_id = auth.uid()
    or public.role_in(organization_id) = 'owner'
    or (public.role_at_least(organization_id, 'admin') and role <> 'owner')
  )
  and not public.is_last_owner(organization_id, user_id)
);
