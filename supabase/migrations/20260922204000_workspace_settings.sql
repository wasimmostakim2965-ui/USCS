create or replace function private.is_organization_admin(target_organization_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = target_organization_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (char_length(trim(email)) between 3 and 320),
  role text not null default 'member' check (role in ('admin', 'member', 'viewer', 'billing', 'security')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  invited_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);
create table if not exists public.workspace_notification_preferences (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  deployment_failures boolean not null default true,
  security_events boolean not null default true,
  billing_updates boolean not null default true,
  observability_alerts boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index if not exists workspace_invitations_org_idx on public.workspace_invitations(organization_id, created_at desc);
alter table public.workspace_invitations enable row level security;
alter table public.workspace_notification_preferences enable row level security;
create policy workspace_invitations_member_select on public.workspace_invitations for select to authenticated using ((select private.is_organization_member(organization_id)));
create policy workspace_invitations_admin_insert on public.workspace_invitations for insert to authenticated with check (invited_by = (select auth.uid()) and (select private.is_organization_admin(organization_id)));
create policy workspace_invitations_admin_update on public.workspace_invitations for update to authenticated using ((select private.is_organization_admin(organization_id))) with check ((select private.is_organization_admin(organization_id)));
create policy workspace_notification_preferences_member_select on public.workspace_notification_preferences for select to authenticated using ((select private.is_organization_member(organization_id)));
create policy workspace_notification_preferences_admin_insert on public.workspace_notification_preferences for insert to authenticated with check (updated_by = (select auth.uid()) and (select private.is_organization_admin(organization_id)));
create policy workspace_notification_preferences_admin_update on public.workspace_notification_preferences for update to authenticated using ((select private.is_organization_admin(organization_id))) with check ((select private.is_organization_admin(organization_id)));
create policy organization_members_admin_update on public.organization_members for update to authenticated using ((select private.is_organization_admin(organization_id))) with check ((select private.is_organization_admin(organization_id)));
create policy organization_members_admin_delete on public.organization_members for delete to authenticated using ((select private.is_organization_admin(organization_id)));
grant select, insert, update on public.workspace_invitations to authenticated;
grant select, insert, update on public.workspace_notification_preferences to authenticated;
grant update, delete on public.organization_members to authenticated;
