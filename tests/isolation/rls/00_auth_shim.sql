-- Minimal Supabase-compatible auth shim for local RLS verification.
--
-- The real Supabase deployment provides `auth.users` and `auth.uid()`. This
-- file recreates just enough of that contract to run the control-plane
-- migrations and prove the RLS policies behave correctly off-platform.
--
-- `auth.uid()` reads the same GUC that PostgREST sets per request
-- (`request.jwt.claim.sub`), so the predicate under test is the real one.

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text not null unique
);

-- Supabase pre-creates these roles. `authenticated` is subject to RLS;
-- `service_role` bypasses it, which is how the worker writes deployment status.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants table privileges to `authenticated` by default. Recreating
-- that here means the RLS policies - not a missing GRANT - are what the probe
-- exercises.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
alter default privileges in schema public
  grant execute on functions to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;

-- Mirrors GoTrue/PostgREST behaviour: the current request's subject.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
