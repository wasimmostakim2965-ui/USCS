create table if not exists public.storage_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  storage_bucket_id uuid not null references public.storage_buckets(id) on delete cascade,
  object_key text not null check (char_length(object_key) between 1 and 1024),
  content_type text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed', 'deleted')),
  adapter_ref text,
  error_message text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_bucket_id, object_key)
);

create table if not exists public.backup_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  database_instance_id uuid references public.database_instances(id) on delete cascade,
  storage_bucket_id uuid references public.storage_buckets(id) on delete cascade,
  frequency text not null check (frequency in ('hourly', 'daily', 'weekly')),
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedules_one_resource check ((database_instance_id is not null) <> (storage_bucket_id is not null))
);

alter table public.backups add column if not exists restore_status text not null default 'not_requested' check (restore_status in ('not_requested', 'pending', 'completed', 'failed'));
alter table public.backups add column if not exists restored_at timestamptz;
alter table public.backups add column if not exists restore_error text;

create index if not exists storage_files_bucket_idx on public.storage_files(organization_id, storage_bucket_id, object_key);
create index if not exists backup_schedules_org_idx on public.backup_schedules(organization_id, updated_at desc);
alter table public.storage_files enable row level security;
alter table public.backup_schedules enable row level security;

drop policy if exists storage_files_member_select on public.storage_files;
create policy storage_files_member_select on public.storage_files for select to authenticated using ((select private.is_organization_member(organization_id)));
drop policy if exists storage_files_member_insert on public.storage_files;
create policy storage_files_member_insert on public.storage_files for insert to authenticated with check (created_by = (select auth.uid()) and (select private.is_organization_member(organization_id)) and exists (select 1 from public.storage_buckets where storage_buckets.id = storage_files.storage_bucket_id and storage_buckets.organization_id = storage_files.organization_id));
drop policy if exists storage_files_member_update on public.storage_files;
create policy storage_files_member_update on public.storage_files for update to authenticated using ((select private.is_organization_member(organization_id))) with check ((select private.is_organization_member(organization_id)));

drop policy if exists backup_schedules_member_select on public.backup_schedules;
create policy backup_schedules_member_select on public.backup_schedules for select to authenticated using ((select private.is_organization_member(organization_id)));
drop policy if exists backup_schedules_member_insert on public.backup_schedules;
create policy backup_schedules_member_insert on public.backup_schedules for insert to authenticated with check (created_by = (select auth.uid()) and (select private.is_organization_member(organization_id)));
drop policy if exists backup_schedules_member_update on public.backup_schedules;
create policy backup_schedules_member_update on public.backup_schedules for update to authenticated using ((select private.is_organization_member(organization_id))) with check ((select private.is_organization_member(organization_id)));

grant select, insert, update on public.storage_files to authenticated;
grant select, insert, update on public.backup_schedules to authenticated;
grant update on public.backups to authenticated;
