-- Keep all tenant policies on the non-recursive private membership helper.
-- Administrative mutations are additionally protected by role-specific policies.

drop policy if exists organizations_member_select on public.organizations;
create policy organizations_member_select on public.organizations
for select to authenticated using ((select private.is_organization_member(id)));

drop policy if exists organization_members_member_select on public.organization_members;
create policy organization_members_member_select on public.organization_members
for select to authenticated using (
  user_id = (select auth.uid())
  or (select private.is_organization_member(organization_id))
);

drop policy if exists projects_member_select on public.projects;
create policy projects_member_select on public.projects
for select to authenticated using ((select private.is_organization_member(organization_id)));

drop policy if exists audit_logs_member_select on public.audit_logs;
create policy audit_logs_member_select on public.audit_logs
for select to authenticated using (
  (select private.is_organization_member(organization_id))
  and exists (
    select 1 from public.organization_members member
    where member.organization_id = audit_logs.organization_id
      and member.user_id = (select auth.uid())
      and member.role in ('owner', 'admin', 'security')
  )
);

drop policy if exists workspace_invitations_member_select on public.workspace_invitations;
create policy workspace_invitations_member_select on public.workspace_invitations
for select to authenticated using ((select private.is_organization_member(organization_id)));

drop policy if exists workspace_invitations_admin_insert on public.workspace_invitations;
create policy workspace_invitations_admin_insert on public.workspace_invitations
for insert to authenticated with check (
  invited_by = (select auth.uid())
  and (select private.is_organization_admin(organization_id))
);

drop policy if exists workspace_invitations_admin_update on public.workspace_invitations;
create policy workspace_invitations_admin_update on public.workspace_invitations
for update to authenticated using ((select private.is_organization_admin(organization_id)))
with check ((select private.is_organization_admin(organization_id)));

-- Explicitly retain the role gate for team mutations at the database boundary.
drop policy if exists organization_members_admin_update on public.organization_members;
create policy organization_members_admin_update on public.organization_members
for update to authenticated using ((select private.is_organization_admin(organization_id)))
with check ((select private.is_organization_admin(organization_id)));
drop policy if exists organization_members_admin_delete on public.organization_members;
create policy organization_members_admin_delete on public.organization_members
for delete to authenticated using ((select private.is_organization_admin(organization_id)));
