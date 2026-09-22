create table if not exists public.observability_error_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  fingerprint text not null,
  example_message text not null,
  occurrence_count bigint not null default 1 check (occurrence_count >= 1),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'resolved', 'ignored')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id, fingerprint)
);
create table if not exists public.observability_alert_destinations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  alert_id uuid not null references public.observability_alerts(id) on delete cascade,
  destination_type text not null check (destination_type in ('email', 'webhook', 'slack')),
  destination_ref text not null check (char_length(destination_ref) between 1 and 1024),
  enabled boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists observability_error_groups_scope_idx on public.observability_error_groups(organization_id, last_seen_at desc);
create index if not exists observability_alert_destinations_alert_idx on public.observability_alert_destinations(organization_id, alert_id);
alter table public.observability_error_groups enable row level security;
alter table public.observability_alert_destinations enable row level security;
create policy observability_error_groups_member_select on public.observability_error_groups for select to authenticated using ((select private.is_organization_member(organization_id)));
create policy observability_error_groups_member_update on public.observability_error_groups for update to authenticated using ((select private.is_organization_member(organization_id))) with check ((select private.is_organization_member(organization_id)));
create policy observability_alert_destinations_member_select on public.observability_alert_destinations for select to authenticated using ((select private.is_organization_member(organization_id)));
create policy observability_alert_destinations_member_insert on public.observability_alert_destinations for insert to authenticated with check (created_by = (select auth.uid()) and (select private.is_organization_member(organization_id)));
create policy observability_alert_destinations_member_update on public.observability_alert_destinations for update to authenticated using ((select private.is_organization_member(organization_id))) with check ((select private.is_organization_member(organization_id)));
grant select, update on public.observability_error_groups to authenticated;
grant select, insert, update on public.observability_alert_destinations to authenticated;
