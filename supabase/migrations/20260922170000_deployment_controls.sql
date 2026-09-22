create table if not exists public.deployment_protection (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  enabled boolean not null default false,
  require_authentication boolean not null default true,
  preview_access text not null default 'public' check (preview_access in ('public', 'team', 'private')),
  updated_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id)
);

create table if not exists public.deployment_rollback_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  deployment_id uuid not null references public.deployments(id) on delete cascade,
  previous_status public.deployment_status not null,
  result text not null check (result in ('requested', 'completed', 'failed')),
  adapter_name text not null,
  reason text,
  diff jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists deployment_protection_project_idx
  on public.deployment_protection(organization_id, project_id);
create index if not exists deployment_rollback_history_deployment_idx
  on public.deployment_rollback_history(organization_id, deployment_id, created_at desc);

alter table public.deployment_protection enable row level security;
alter table public.deployment_rollback_history enable row level security;

drop policy if exists deployment_protection_member_select on public.deployment_protection;
create policy deployment_protection_member_select on public.deployment_protection
for select to authenticated
using ((select private.is_organization_member(organization_id)));

drop policy if exists deployment_protection_member_insert on public.deployment_protection;
create policy deployment_protection_member_insert on public.deployment_protection
for insert to authenticated
with check (
  updated_by = (select auth.uid())
  and (select private.is_organization_member(organization_id))
  and exists (
    select 1 from public.projects
    where projects.id = deployment_protection.project_id
      and projects.organization_id = deployment_protection.organization_id
  )
);

drop policy if exists deployment_protection_member_update on public.deployment_protection;
create policy deployment_protection_member_update on public.deployment_protection
for update to authenticated
using ((select private.is_organization_member(organization_id)))
with check (updated_by = (select auth.uid()) and (select private.is_organization_member(organization_id)));

drop policy if exists deployment_rollback_history_member_select on public.deployment_rollback_history;
create policy deployment_rollback_history_member_select on public.deployment_rollback_history
for select to authenticated
using ((select private.is_organization_member(organization_id)));

drop policy if exists deployment_rollback_history_member_insert on public.deployment_rollback_history;
create policy deployment_rollback_history_member_insert on public.deployment_rollback_history
for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (select private.is_organization_member(organization_id))
  and exists (
    select 1 from public.deployments
    where deployments.id = deployment_rollback_history.deployment_id
      and deployments.project_id = deployment_rollback_history.project_id
      and deployments.organization_id = deployment_rollback_history.organization_id
  )
);

grant select, insert, update on public.deployment_protection to authenticated;
grant select, insert on public.deployment_rollback_history to authenticated;
