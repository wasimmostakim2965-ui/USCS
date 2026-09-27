-- ---------------------------------------------------------------------------
-- 0026 — inserting a membership is bounded by rank, like every other write
--
-- Migration 0020 fixed the UPDATE and DELETE policies on `organization_members`
-- so rank is a ceiling as well as a floor: an admin may not demote an owner, nor
-- promote anyone into owner, and nobody edits their own role. It left the INSERT
-- policy as the first-cut version in 0002, and that policy has the same hole 0020
-- closed for UPDATE:
--
--     with check (public.role_at_least(organization_id, 'admin') or ...)
--
-- An admin satisfies `role_at_least(...,'admin')` for *any* row shape, so an
-- admin could `insert into organization_members (..., role) values (...,'owner')`
-- and mint a second owner — and then, being an owner, rewrite the organization
-- they were only appointed to administer. That is the exact escalation 0020
-- forbids on the UPDATE path, reachable instead through INSERT. A caller who
-- bypasses the API and talks PostgREST with their own JWT is the threat: the API
-- re-checks rank in `organizations.members.*`, this is the layer that holds
-- underneath it.
--
-- The rank rule restated for INSERT, matching 0020's UPDATE policy:
--
--   * an owner may add anyone, including another owner;
--   * an admin may add a non-owner (admin / member / viewer — the roles the
--     UPDATE policy also lets an admin grant), but never an owner;
--   * the creator may still claim the first membership of an organization they
--     just created (`role = 'owner'`, `user_id = auth.uid()`, on an org whose
--     `created_by` is them) — the one owner insert that is not an escalation.
-- ---------------------------------------------------------------------------

drop policy organization_members_insert on organization_members;

create policy organization_members_insert on organization_members for insert to authenticated
with check (
  -- The creator claims ownership of the organization they just created. Not an
  -- escalation: the row is their own, on their own organization.
  (
    user_id = auth.uid()
    and role = 'owner'
    and exists (
      select 1 from organizations o
       where o.id = organization_id and o.created_by = auth.uid()
    )
  )
  -- An owner may add any role, including another owner: ownership is theirs to
  -- extend, exactly as the UPDATE policy says.
  or public.role_in(organization_id) = 'owner'
  -- An admin may add a non-owner. `role <> 'owner'` is the ceiling that stops an
  -- admin from minting an owner — the same rule the UPDATE policy's `with check`
  -- applies, so the two write paths cannot disagree.
  or (public.role_at_least(organization_id, 'admin') and role <> 'owner')
);
