-- Deployment control-plane records. Runtime execution is delegated to a
-- self-operated HostingAdapter; this schema never fabricates provider state.
create schema if not exists private;

create or replace function private.is_organization_member(target_organization_id uuid, target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members
    where organization_id = target_organization_id
      and user_id = target_user_id
  );
$$;

revoke all on function private.is_organization_member(uuid, uuid) from public;
grant execute on function private.is_organization_member(uuid, uuid) to authenticated;

do $$ begin
  create type public.deployment_environment as enum ('production', 'preview', 'development');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.deployment_status as enum ('pending', 'building', 'ready', 'failed', 'canceled', 'rolled_back');
exception when duplicate_object then null;
end $$;

create table if not exists public.deployments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  environment public.deployment_environment not null default 'preview',
  status public.deployment_status not null default 'pending',
  source_branch text,
  commit_sha text,
  source_repository text,
  deployment_url text,
  provider_ref text,
  error_message text,
  created_by uuid not null references auth.users(id) on delete restrict,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deployments_branch_length check (source_branch is null or char_length(source_branch) between 1 and 255),
  constraint deployments_commit_length check (commit_sha is null or char_length(commit_sha) between 1 and 128),
  constraint deployments_url_length check (deployment_url is null or char_length(deployment_url) <= 2048),
  constraint deployments_error_length check (error_message is null or char_length(error_message) <= 4000)
);

create table if not exists public.deployment_logs (
  id bigint generated always as identity primary key,
  deployment_id uuid not null references public.deployments(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  message text not null check (char_length(message) between 1 and 4000),
  source text not null default 'platform' check (char_length(source) between 1 and 80),
  created_at timestamptz not null default now()
);

create index if not exists deployments_organization_id_idx on public.deployments(organization_id);
create index if not exists deployments_project_id_idx on public.deployments(project_id, created_at desc);
create index if not exists deployments_status_idx on public.deployments(organization_id, status);
create index if not exists deployment_logs_deployment_id_idx on public.deployment_logs(deployment_id, created_at);
create index if not exists deployment_logs_organization_id_idx on public.deployment_logs(organization_id, created_at);

alter table public.deployments enable row level security;
alter table public.deployment_logs enable row level security;

drop policy if exists deployments_member_select on public.deployments;
create policy deployments_member_select on public.deployments
for select to authenticated
using ((select private.is_organization_member(organization_id)));

drop policy if exists deployments_member_insert on public.deployments;
create policy deployments_member_insert on public.deployments
for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.is_organization_member(organization_id))
  and exists (
    select 1 from public.organization_members
    where organization_members.organization_id = deployments.organization_id
      and organization_members.user_id = (select auth.uid())
      and organization_members.role = any (array['owner','admin','member'])
  )
  and exists (
    select 1 from public.projects
    where projects.id = deployments.project_id
      and projects.organization_id = deployments.organization_id
  )
);

drop policy if exists deployments_admin_update on public.deployments;
create policy deployments_admin_update on public.deployments
for update to authenticated
using (
  exists (
    select 1 from public.organization_members
    where organization_members.organization_id = deployments.organization_id
      and organization_members.user_id = (select auth.uid())
      and organization_members.role = any (array['owner','admin','member'])
  )
)
with check ((select private.is_organization_member(organization_id)));

drop policy if exists deployment_logs_member_select on public.deployment_logs;
create policy deployment_logs_member_select on public.deployment_logs
for select to authenticated
using ((select private.is_organization_member(organization_id)));

drop policy if exists deployment_logs_member_insert on public.deployment_logs;
create policy deployment_logs_member_insert on public.deployment_logs
for insert to authenticated
with check (
  (select private.is_organization_member(organization_id))
  and exists (
    select 1 from public.deployments
    where deployments.id = deployment_logs.deployment_id
      and deployments.organization_id = deployment_logs.organization_id
  )
);

drop policy if exists audit_logs_member_insert on public.audit_logs;
create policy audit_logs_member_insert on public.audit_logs
for insert to authenticated
with check (
  actor_id = (select auth.uid())
  and (select private.is_organization_member(organization_id))
  and exists (
    select 1 from public.organization_members
    where organization_members.organization_id = audit_logs.organization_id
      and organization_members.user_id = (select auth.uid())
      and organization_members.role = any (array['owner','admin','member','security'])
  )
);
