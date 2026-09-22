create table if not exists public.observability_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  deployment_id uuid references public.deployments(id) on delete set null,
  category text not null check (category in ('log', 'metric', 'error', 'request')),
  severity text not null default 'info' check (severity in ('debug', 'info', 'warn', 'error', 'critical')),
  message text not null check (char_length(message) between 1 and 4000),
  route text,
  status_code integer check (status_code is null or status_code between 100 and 599),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.observability_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  metric text not null check (metric in ('error_rate', 'latency_p95', 'request_rate', 'uptime')),
  threshold numeric not null check (threshold >= 0),
  enabled boolean not null default true,
  state text not null default 'inactive' check (state in ('inactive', 'triggered', 'unknown')),
  last_triggered_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists observability_events_org_occurred_idx on public.observability_events(organization_id, occurred_at desc);
create index if not exists observability_events_category_idx on public.observability_events(organization_id, category, occurred_at desc);
create index if not exists observability_alerts_org_idx on public.observability_alerts(organization_id, updated_at desc);

alter table public.observability_events enable row level security;
alter table public.observability_alerts enable row level security;

drop policy if exists observability_events_member_select on public.observability_events;
create policy observability_events_member_select on public.observability_events for select to authenticated using ((select private.is_organization_member(organization_id)));
drop policy if exists observability_events_service_insert on public.observability_events;
create policy observability_events_service_insert on public.observability_events for insert to authenticated with check ((select private.is_organization_member(organization_id)));
drop policy if exists observability_alerts_member_select on public.observability_alerts;
create policy observability_alerts_member_select on public.observability_alerts for select to authenticated using ((select private.is_organization_member(organization_id)));
drop policy if exists observability_alerts_member_insert on public.observability_alerts;
create policy observability_alerts_member_insert on public.observability_alerts for insert to authenticated with check (
  created_by = (select auth.uid())
  and (select private.is_organization_member(organization_id))
);
drop policy if exists observability_alerts_member_update on public.observability_alerts;
create policy observability_alerts_member_update on public.observability_alerts for update to authenticated using ((select private.is_organization_member(organization_id))) with check ((select private.is_organization_member(organization_id)));

grant select, insert on public.observability_events to authenticated;
grant select, insert, update on public.observability_alerts to authenticated;
