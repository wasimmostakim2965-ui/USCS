-- USCS tenant/auth foundation
-- Apply through Supabase migrations. No service-role key or database password belongs here.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer', 'billing', 'security')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  slug text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, slug)
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (char_length(action) between 1 and 120),
  resource_type text,
  resource_id uuid,
  result text not null default 'success' check (result in ('success', 'failure')),
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists organization_members_user_idx on public.organization_members(user_id);
create index if not exists projects_organization_idx on public.projects(organization_id);
create index if not exists audit_logs_organization_created_idx on public.audit_logs(organization_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at before update on public.organizations
for each row execute function public.set_updated_at();

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at before update on public.projects
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_name text;
  organization_id uuid;
  organization_slug text;
begin
  profile_name := coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(coalesce(new.email, 'user'), '@', 1));

  insert into public.profiles (id, email, display_name, avatar_url)
  values (new.id, new.email, profile_name, new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do update set
    email = excluded.email,
    display_name = coalesce(excluded.display_name, profiles.display_name),
    avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url);

  organization_slug := regexp_replace(lower(coalesce(profile_name, 'workspace')), '[^a-z0-9]+', '-', 'g');
  organization_slug := trim(both '-' from organization_slug);
  organization_slug := left(coalesce(nullif(organization_slug, ''), 'workspace'), 52) || '-' || substr(replace(new.id::text, '-', ''), 1, 10);

  insert into public.organizations (name, slug, created_by)
  values (coalesce(nullif(profile_name, ''), 'Personal workspace'), organization_slug, new.id)
  returning id into organization_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (organization_id, new.id, 'owner')
  on conflict (organization_id, user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.projects enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select using (id = auth.uid());
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists organizations_member_select on public.organizations;
create policy organizations_member_select on public.organizations for select using (
  exists (select 1 from public.organization_members m where m.organization_id = organizations.id and m.user_id = auth.uid())
);

drop policy if exists organization_members_member_select on public.organization_members;
create policy organization_members_member_select on public.organization_members for select using (
  user_id = auth.uid() or exists (
    select 1 from public.organization_members own where own.organization_id = organization_members.organization_id and own.user_id = auth.uid()
  )
);

drop policy if exists projects_member_select on public.projects;
create policy projects_member_select on public.projects for select using (
  exists (select 1 from public.organization_members m where m.organization_id = projects.organization_id and m.user_id = auth.uid())
);
drop policy if exists projects_member_insert on public.projects;
create policy projects_member_insert on public.projects for insert with check (
  created_by = auth.uid() and exists (
    select 1 from public.organization_members m where m.organization_id = projects.organization_id and m.user_id = auth.uid() and m.role in ('owner', 'admin', 'member')
  )
);
drop policy if exists projects_admin_update on public.projects;
create policy projects_admin_update on public.projects for update using (
  exists (select 1 from public.organization_members m where m.organization_id = projects.organization_id and m.user_id = auth.uid() and m.role in ('owner', 'admin'))
) with check (
  exists (select 1 from public.organization_members m where m.organization_id = projects.organization_id and m.user_id = auth.uid() and m.role in ('owner', 'admin'))
);

drop policy if exists audit_logs_member_select on public.audit_logs;
create policy audit_logs_member_select on public.audit_logs for select using (
  exists (select 1 from public.organization_members m where m.organization_id = audit_logs.organization_id and m.user_id = auth.uid() and m.role in ('owner', 'admin', 'security'))
);

revoke all on public.profiles, public.organizations, public.organization_members, public.projects, public.audit_logs from anon;
grant select, update on public.profiles to authenticated;
grant select on public.organizations, public.organization_members, public.projects, public.audit_logs to authenticated;
grant insert on public.projects to authenticated;
