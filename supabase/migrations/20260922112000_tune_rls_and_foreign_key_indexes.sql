-- Keep auth helpers statement-scoped so Postgres can cache their result
-- instead of re-evaluating them for every row.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists organization_members_member_select on public.organization_members;
create policy organization_members_member_select
on public.organization_members
for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select private.is_organization_member(organization_id))
);

drop policy if exists projects_member_select on public.projects;
create policy projects_member_select
on public.projects
for select
to authenticated
using ((select private.is_organization_member(organization_id)));

drop policy if exists projects_member_insert on public.projects;
create policy projects_member_insert
on public.projects
for insert
to authenticated
with check (
  created_by = (select auth.uid())
  and exists (
    select 1
    from public.organization_members
    where organization_members.organization_id = projects.organization_id
      and organization_members.user_id = (select auth.uid())
      and organization_members.role = any (array['owner','admin','member'])
  )
);

drop policy if exists projects_admin_update on public.projects;
create policy projects_admin_update
on public.projects
for update
to authenticated
using (
  exists (
    select 1
    from public.organization_members
    where organization_members.organization_id = projects.organization_id
      and organization_members.user_id = (select auth.uid())
      and organization_members.role = any (array['owner','admin'])
  )
)
with check ((select private.is_organization_member(organization_id)));

create index if not exists audit_logs_actor_id_idx
  on public.audit_logs(actor_id);

create index if not exists organizations_created_by_idx
  on public.organizations(created_by);

create index if not exists projects_created_by_idx
  on public.projects(created_by);
