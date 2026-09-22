create table if not exists public.security_edge_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  event_type text not null check (event_type in ('waf', 'firewall', 'rate_limit', 'bot', 'ddos', 'tls')),
  action text not null check (action in ('allowed', 'challenged', 'blocked', 'observed')),
  source text not null default 'edge-adapter',
  ip_hash text,
  path text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists security_edge_events_scope_idx on public.security_edge_events(organization_id, project_id, created_at desc);
alter table public.security_edge_events enable row level security;
drop policy if exists security_edge_events_member_select on public.security_edge_events;
create policy security_edge_events_member_select on public.security_edge_events for select to authenticated using ((select private.is_organization_member(organization_id)));
drop policy if exists security_edge_events_service_insert on public.security_edge_events;
create policy security_edge_events_service_insert on public.security_edge_events for insert to authenticated with check ((select private.is_organization_member(organization_id)));
grant select, insert on public.security_edge_events to authenticated;
