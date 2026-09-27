-- ---------------------------------------------------------------------------
-- 0027 — a profile exists for every authenticated user, and is joinable
--
-- Two defects this migration closes, both found by running the real API against
-- a real PostgREST rather than the in-process stand-in in the tests.
--
-- 1. `profiles` was never populated.
--
--    0001 created the table and 0002 gave it RLS, but nothing ever inserted a
--    row: not a trigger on `auth.users`, not the API. `organizations.members.*`
--    embeds `profiles(email,display_name)` to show a member's address and name,
--    so every member rendered as an unnamed, addressless row — a silent, total
--    loss of the feature, with no error to notice.
--
--    The fix is the canonical Supabase pattern: a `security definer` trigger on
--    `auth.users` writes one profile row per new user, reading the email and any
--    display name from `raw_user_meta_data`. It is idempotent (`on conflict do
--    nothing`) so re-running it over an existing auth user is a no-op, and it is
--    backfilled below for users that already exist.
--
-- 2. `organization_members` had no foreign key to `profiles`.
--
--    PostgREST resolves an embedded resource through a foreign key. Without one
--    between the two tables it answers PGRST200 ("no matches were found") and
--    the read fails outright. The membership table references `auth.users`, not
--    `profiles`, so the embed `profiles(...)` had no relationship to follow.
--    Adding the key makes `profiles(...)` resolvable; the `auth.users` key is
--    kept because the membership is a fact about the auth user, and the profile
--    key is the same identity surfaced for display.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. One profile per auth user, created on signup.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  display text;
begin
  display := nullif(trim(coalesce(
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    ''
  )), '');

  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, display)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill every auth user that predates the trigger. `on conflict do nothing`
-- keeps this idempotent, and a profile that already carries a display name is
-- left as it is (the insert does not touch an existing row).
insert into public.profiles (id, email, display_name)
select
  u.id,
  u.email,
  nullif(trim(coalesce(
    u.raw_user_meta_data ->> 'display_name',
    u.raw_user_meta_data ->> 'full_name',
    u.raw_user_meta_data ->> 'name',
    ''
  )), '')
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The membership is joinable to the profile PostgREST embeds.
--
-- `on delete cascade`: the profile is keyed by the auth user, so a deleted user
-- removes both rows in the same cascade. `not valid` is deliberately *not* used:
-- the backfill above guarantees every membership has a profile, so the key can
-- be validated and enforced from this point on.
-- ---------------------------------------------------------------------------

alter table public.organization_members
  drop constraint if exists organization_members_user_profile_fkey;

alter table public.organization_members
  add constraint organization_members_user_profile_fkey
  foreign key (user_id) references public.profiles (id) on delete cascade;

-- PostgREST caches the schema; the next request reloads it. No statement here
-- needs to notify it, but a comment records that the embed only resolves once
-- the cache has picked this relationship up.
