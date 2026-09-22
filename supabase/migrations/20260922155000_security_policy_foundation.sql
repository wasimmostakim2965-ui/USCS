-- Phase 3: project security posture is a control-plane record that drives
-- concrete edge enforcement. It is not a cosmetic UI preference.
do $$ begin
  create type public.security_level as enum ('none', 'normal', 'high', 'ultimate');
exception when duplicate_object then null;
end $$;

create table if not exists public.security_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  security_level public.security_level not null default 'normal',
  auto_setup boolean not null default true,
  enforcement_version integer not null default 1,
  desired_config jsonb not null default '{}'::jsonb,
  applied_config jsonb not null default '{}'::jsonb,
  last_applied_at timestamptz,
  last_apply_status text not null default 'not_applied' check (last_apply_status in ('not_applied', 'pending', 'applied', 'failed')),
  last_apply_error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, project_id)
);

create table if not exists public.security_policy_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  security_policy_id uuid not null references public.security_policies(id) on delete cascade,
  event_type text not null check (event_type in ('previewed', 'applied', 'failed', 'rolled_back')),
  actor_id uuid references auth.users(id),
  desired_config jsonb not null default '{}'::jsonb,
  applied_config jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists security_policies_org_idx on public.security_policies(organization_id);
create index if not exists security_policies_project_idx on public.security_policies(project_id);
create index if not exists security_policy_events_org_created_idx on public.security_policy_events(organization_id, created_at desc);

alter table public.security_policies enable row level security;
alter table public.security_policy_events enable row level security;

drop policy if exists security_policies_member_select on public.security_policies;
create policy security_policies_member_select on public.security_policies for select using (private.is_organization_member(organization_id));
drop policy if exists security_policies_operator_insert on public.security_policies;
create policy security_policies_operator_insert on public.security_policies for insert with check (
  private.is_organization_member(organization_id)
  and exists (select 1 from public.organization_members m where m.organization_id = security_policies.organization_id and m.user_id = auth.uid() and m.role in ('owner', 'admin', 'security'))
);
drop policy if exists security_policies_operator_update on public.security_policies;
create policy security_policies_operator_update on public.security_policies for update using (
  exists (select 1 from public.organization_members m where m.organization_id = security_policies.organization_id and m.user_id = auth.uid() and m.role in ('owner', 'admin', 'security'))
) with check (private.is_organization_member(organization_id));
drop policy if exists security_policy_events_member_select on public.security_policy_events;
create policy security_policy_events_member_select on public.security_policy_events for select using (private.is_organization_member(organization_id));
drop policy if exists security_policy_events_operator_insert on public.security_policy_events;
create policy security_policy_events_operator_insert on public.security_policy_events for insert with check (
  private.is_organization_member(organization_id)
  and exists (select 1 from public.organization_members m where m.organization_id = security_policy_events.organization_id and m.user_id = auth.uid() and m.role in ('owner', 'admin', 'security'))
);

revoke all on public.security_policies, public.security_policy_events from anon;
grant select, insert, update on public.security_policies to authenticated;
grant select, insert on public.security_policy_events to authenticated;
