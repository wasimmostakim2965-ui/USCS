-- Fix recursive organization membership policies.
-- The helper is security definer so checking membership does not re-enter
-- organization_members RLS while evaluating another organization policy.

create or replace function public.is_organization_member(target_organization_id uuid, target_user_id uuid default auth.uid())
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

revoke all on function public.is_organization_member(uuid, uuid) from public;
grant execute on function public.is_organization_member(uuid, uuid) to authenticated;

drop policy if exists organizations_member_select on public.organizations;
create policy organizations_member_select on public.organizations
for select using (public.is_organization_member(id));

drop policy if exists organization_members_member_select on public.organization_members;
create policy organization_members_member_select on public.organization_members
for select using (
  user_id = auth.uid() or public.is_organization_member(organization_id)
);

drop policy if exists projects_member_select on public.projects;
create policy projects_member_select on public.projects
for select using (public.is_organization_member(organization_id));

drop policy if exists projects_member_insert on public.projects;
create policy projects_member_insert on public.projects
for insert with check (
  created_by = auth.uid()
  and exists (
    select 1
    from public.organization_members
    where organization_id = projects.organization_id
      and user_id = auth.uid()
      and role in ('owner', 'admin', 'member')
  )
);

drop policy if exists projects_admin_update on public.projects;
create policy projects_admin_update on public.projects
for update using (
  exists (
    select 1
    from public.organization_members
    where organization_id = projects.organization_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  )
) with check (
  public.is_organization_member(organization_id)
);

drop policy if exists audit_logs_member_select on public.audit_logs;
create policy audit_logs_member_select on public.audit_logs
for select using (public.is_organization_member(organization_id));
