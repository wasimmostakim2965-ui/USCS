-- Keep Supabase Auth account creation independent from optional tenant provisioning.
-- A failed workspace insert must never roll back a valid OAuth user.

create or replace function public.ensure_user_workspace(
  target_user_id uuid,
  target_email text,
  target_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_name text;
  organization_id uuid;
  organization_slug text;
begin
  if target_user_id is null then
    return;
  end if;
  if auth.uid() is not null and target_user_id <> auth.uid() then
    raise exception 'user provisioning target mismatch';
  end if;

  profile_name := coalesce(
    target_metadata->>'full_name',
    target_metadata->>'name',
    split_part(coalesce(target_email, 'user'), '@', 1),
    'User'
  );
  profile_name := left(nullif(trim(profile_name), ''), 120);

  insert into public.profiles (id, email, display_name, avatar_url)
  values (target_user_id, target_email, profile_name, target_metadata->>'avatar_url')
  on conflict (id) do update set
    email = excluded.email,
    display_name = coalesce(excluded.display_name, public.profiles.display_name),
    avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
    updated_at = now();

  select om.organization_id
    into organization_id
    from public.organization_members om
   where om.user_id = target_user_id
   limit 1;

  if organization_id is not null then
    return;
  end if;

  organization_slug := regexp_replace(lower(coalesce(profile_name, 'workspace')), '[^a-z0-9]+', '-', 'g');
  organization_slug := trim(both '-' from organization_slug);
  organization_slug := left(coalesce(nullif(organization_slug, ''), 'workspace'), 48)
    || '-' || substr(replace(target_user_id::text, '-', ''), 1, 12);

  insert into public.organizations (name, slug, created_by)
  values (coalesce(nullif(profile_name, ''), 'Personal workspace'), organization_slug, target_user_id)
  returning id into organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (organization_id, target_user_id, 'owner')
  on conflict (organization_id, user_id) do nothing;
exception when others then
  -- Auth must remain successful even if a tenant-side object is temporarily
  -- unavailable. The authenticated client can retry this function after login.
  raise warning 'USCS user provisioning deferred for %: %', target_user_id, sqlerrm;
end;
$$;

revoke all on function public.ensure_user_workspace(uuid, text, jsonb) from public;
grant execute on function public.ensure_user_workspace(uuid, text, jsonb) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_user_workspace(new.id, new.email, new.raw_user_meta_data);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();
