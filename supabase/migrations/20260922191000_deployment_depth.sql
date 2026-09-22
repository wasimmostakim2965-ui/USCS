create table if not exists public.deployment_env_vars (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  environment public.deployment_environment not null,
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  value_ref text,
  masked_value text not null default '••••••••',
  is_secret boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, environment, name)
);

create table if not exists public.deployment_domain_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  domain_id uuid not null references public.domains(id) on delete cascade,
  environment public.deployment_environment not null default 'production',
  status text not null default 'pending' check (status in ('pending', 'active', 'failed', 'not_configured')),
  provider_ref text,
  error_message text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, domain_id, environment)
);

create index if not exists deployment_env_vars_project_idx on public.deployment_env_vars(organization_id, project_id, environment);
create index if not exists deployment_domain_bindings_project_idx on public.deployment_domain_bindings(organization_id, project_id, environment);
alter table public.deployment_env_vars enable row level security;
alter table public.deployment_domain_bindings enable row level security;

drop policy if exists deployment_env_vars_member_select on public.deployment_env_vars;
create policy deployment_env_vars_member_select on public.deployment_env_vars for select to authenticated using ((select private.is_organization_member(organization_id)));
drop policy if exists deployment_env_vars_member_insert on public.deployment_env_vars;
create policy deployment_env_vars_member_insert on public.deployment_env_vars for insert to authenticated with check (created_by = (select auth.uid()) and (select private.is_organization_member(organization_id)));
drop policy if exists deployment_env_vars_member_update on public.deployment_env_vars;
create policy deployment_env_vars_member_update on public.deployment_env_vars for update to authenticated using ((select private.is_organization_member(organization_id))) with check ((select private.is_organization_member(organization_id)));
drop policy if exists deployment_env_vars_member_delete on public.deployment_env_vars;
create policy deployment_env_vars_member_delete on public.deployment_env_vars for delete to authenticated using ((select private.is_organization_member(organization_id)));

drop policy if exists deployment_domain_bindings_member_select on public.deployment_domain_bindings;
create policy deployment_domain_bindings_member_select on public.deployment_domain_bindings for select to authenticated using ((select private.is_organization_member(organization_id)));
drop policy if exists deployment_domain_bindings_member_insert on public.deployment_domain_bindings;
create policy deployment_domain_bindings_member_insert on public.deployment_domain_bindings for insert to authenticated with check (created_by = (select auth.uid()) and (select private.is_organization_member(organization_id)));
drop policy if exists deployment_domain_bindings_member_update on public.deployment_domain_bindings;
create policy deployment_domain_bindings_member_update on public.deployment_domain_bindings for update to authenticated using ((select private.is_organization_member(organization_id))) with check ((select private.is_organization_member(organization_id)));

grant select, insert, update, delete on public.deployment_env_vars to authenticated;
grant select, insert, update on public.deployment_domain_bindings to authenticated;
