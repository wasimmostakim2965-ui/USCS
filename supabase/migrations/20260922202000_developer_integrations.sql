create table if not exists public.developer_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('github', 'gitlab', 'bitbucket')),
  status text not null default 'not_configured' check (status in ('not_configured', 'connected', 'error')),
  account_ref text,
  token_ref text,
  error_message text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);
create table if not exists public.developer_repositories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null references public.developer_connections(id) on delete cascade,
  full_name text not null,
  default_branch text not null default 'main',
  webhook_status text not null default 'not_configured' check (webhook_status in ('not_configured', 'pending', 'active', 'failed')),
  webhook_ref text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, connection_id, full_name)
);
create index if not exists developer_connections_org_idx on public.developer_connections(organization_id, provider);
create index if not exists developer_repositories_org_idx on public.developer_repositories(organization_id, created_at desc);
alter table public.developer_connections enable row level security;
alter table public.developer_repositories enable row level security;
create policy developer_connections_member_select on public.developer_connections for select to authenticated using ((select private.is_organization_member(organization_id)));
create policy developer_connections_member_insert on public.developer_connections for insert to authenticated with check (created_by = (select auth.uid()) and (select private.is_organization_member(organization_id)));
create policy developer_connections_member_update on public.developer_connections for update to authenticated using ((select private.is_organization_member(organization_id))) with check ((select private.is_organization_member(organization_id)));
create policy developer_repositories_member_select on public.developer_repositories for select to authenticated using ((select private.is_organization_member(organization_id)));
create policy developer_repositories_member_insert on public.developer_repositories for insert to authenticated with check (created_by = (select auth.uid()) and (select private.is_organization_member(organization_id)));
create policy developer_repositories_member_update on public.developer_repositories for update to authenticated using ((select private.is_organization_member(organization_id))) with check ((select private.is_organization_member(organization_id)));
grant select, insert, update on public.developer_connections to authenticated;
grant select, insert, update on public.developer_repositories to authenticated;
