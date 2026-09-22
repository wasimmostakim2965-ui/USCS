-- Control-plane metadata for self-operated tenant data services.
-- Credentials and customer data never live in these records.
do $$ begin
  create type public.data_resource_status as enum ('pending', 'provisioning', 'ready', 'failed', 'deleting');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.backup_status as enum ('pending', 'running', 'completed', 'failed');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.backup_resource_type as enum ('database', 'storage');
exception when duplicate_object then null;
end $$;

create table if not exists public.database_instances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  name text not null check (char_length(trim(name)) between 1 and 120),
  engine text not null default 'postgres' check (engine = 'postgres'),
  status public.data_resource_status not null default 'pending',
  tenant_identifier text,
  adapter_ref text,
  error_message text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint database_instances_tenant_identifier_length check (tenant_identifier is null or char_length(tenant_identifier) <= 255),
  constraint database_instances_error_length check (error_message is null or char_length(error_message) <= 4000)
);

create table if not exists public.storage_buckets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  name text not null check (char_length(trim(name)) between 1 and 120),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  status public.data_resource_status not null default 'pending',
  region text,
  adapter_ref text,
  error_message text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storage_buckets_region_length check (region is null or char_length(region) between 1 and 80),
  constraint storage_buckets_error_length check (error_message is null or char_length(error_message) <= 4000)
);

create table if not exists public.backups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  resource_type public.backup_resource_type not null,
  database_instance_id uuid references public.database_instances(id) on delete cascade,
  storage_bucket_id uuid references public.storage_buckets(id) on delete cascade,
  status public.backup_status not null default 'pending',
  adapter_ref text,
  size_bytes bigint,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint backups_one_resource check (
    (resource_type = 'database' and database_instance_id is not null and storage_bucket_id is null)
    or (resource_type = 'storage' and storage_bucket_id is not null and database_instance_id is null)
  ),
  constraint backups_size_nonnegative check (size_bytes is null or size_bytes >= 0),
  constraint backups_error_length check (error_message is null or char_length(error_message) <= 4000)
);

create index if not exists database_instances_organization_id_idx on public.database_instances(organization_id, created_at desc);
create index if not exists database_instances_project_id_idx on public.database_instances(project_id);
create index if not exists storage_buckets_organization_id_idx on public.storage_buckets(organization_id, created_at desc);
create index if not exists storage_buckets_project_id_idx on public.storage_buckets(project_id);
create index if not exists backups_organization_id_idx on public.backups(organization_id, created_at desc);
create index if not exists backups_database_instance_id_idx on public.backups(database_instance_id);
create index if not exists backups_storage_bucket_id_idx on public.backups(storage_bucket_id);

alter table public.database_instances enable row level security;
alter table public.storage_buckets enable row level security;
alter table public.backups enable row level security;

drop policy if exists database_instances_member_select on public.database_instances;
create policy database_instances_member_select on public.database_instances
for select to authenticated
using ((select private.is_organization_member(organization_id)));

drop policy if exists database_instances_member_insert on public.database_instances;
create policy database_instances_member_insert on public.database_instances
for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.is_organization_member(organization_id))
  and exists (
    select 1 from public.organization_members
    where organization_members.organization_id = database_instances.organization_id
      and organization_members.user_id = (select auth.uid())
      and organization_members.role = any (array['owner','admin','member'])
  )
);

drop policy if exists database_instances_admin_update on public.database_instances;
create policy database_instances_admin_update on public.database_instances
for update to authenticated
using (exists (
  select 1 from public.organization_members
  where organization_members.organization_id = database_instances.organization_id
    and organization_members.user_id = (select auth.uid())
    and organization_members.role = any (array['owner','admin'])
))
with check ((select private.is_organization_member(organization_id)));

drop policy if exists storage_buckets_member_select on public.storage_buckets;
create policy storage_buckets_member_select on public.storage_buckets
for select to authenticated
using ((select private.is_organization_member(organization_id)));

drop policy if exists storage_buckets_member_insert on public.storage_buckets;
create policy storage_buckets_member_insert on public.storage_buckets
for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.is_organization_member(organization_id))
  and exists (
    select 1 from public.organization_members
    where organization_members.organization_id = storage_buckets.organization_id
      and organization_members.user_id = (select auth.uid())
      and organization_members.role = any (array['owner','admin','member'])
  )
);

drop policy if exists storage_buckets_admin_update on public.storage_buckets;
create policy storage_buckets_admin_update on public.storage_buckets
for update to authenticated
using (exists (
  select 1 from public.organization_members
  where organization_members.organization_id = storage_buckets.organization_id
    and organization_members.user_id = (select auth.uid())
    and organization_members.role = any (array['owner','admin'])
))
with check ((select private.is_organization_member(organization_id)));

drop policy if exists backups_member_select on public.backups;
create policy backups_member_select on public.backups
for select to authenticated
using ((select private.is_organization_member(organization_id)));

drop policy if exists backups_member_insert on public.backups;
create policy backups_member_insert on public.backups
for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.is_organization_member(organization_id))
  and exists (
    select 1 from public.organization_members
    where organization_members.organization_id = backups.organization_id
      and organization_members.user_id = (select auth.uid())
      and organization_members.role = any (array['owner','admin','member'])
  )
);

drop policy if exists backups_admin_update on public.backups;
create policy backups_admin_update on public.backups
for update to authenticated
using (exists (
  select 1 from public.organization_members
  where organization_members.organization_id = backups.organization_id
    and organization_members.user_id = (select auth.uid())
    and organization_members.role = any (array['owner','admin'])
))
with check ((select private.is_organization_member(organization_id)));
