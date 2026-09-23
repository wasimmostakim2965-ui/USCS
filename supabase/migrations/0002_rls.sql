-- Row Level Security for the Cloud Wai control plane.
--
-- Rules:
--   * RLS is enabled on every table; without a matching policy the operation is
--     denied.
--   * Scope comes from auth.uid() via public.is_org_member / public.role_in.
--     A client-supplied organization_id is only ever used as the row's own
--     column to match against, never as the authority.
--   * audit_logs gets SELECT and INSERT policies only: it is append-only.
--   * orchestration_jobs and usage_records are service-role written.

alter table profiles              enable row level security;
alter table organizations         enable row level security;
alter table organization_members  enable row level security;
alter table projects              enable row level security;
alter table environments          enable row level security;
alter table deployments           enable row level security;
alter table data_resources        enable row level security;
alter table data_backups          enable row level security;
alter table domains               enable row level security;
alter table security_policies     enable row level security;
alter table api_keys              enable row level security;
alter table orchestration_jobs    enable row level security;
alter table usage_records         enable row level security;
alter table audit_logs            enable row level security;

-- ---------------------------------------------------------------------------
-- profiles: self, or a co-member of an organization I belong to
-- ---------------------------------------------------------------------------

create policy profiles_select on profiles for select to authenticated
using (
  id = auth.uid()
  or exists (
    select 1
    from organization_members mine
    join organization_members theirs on theirs.organization_id = mine.organization_id
    where mine.user_id = auth.uid() and theirs.user_id = profiles.id
  )
);

create policy profiles_insert on profiles for insert to authenticated
with check (id = auth.uid());

create policy profiles_update on profiles for update to authenticated
using (id = auth.uid())
with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- organizations: members read; creator inserts; owner/admin update; owner deletes
-- ---------------------------------------------------------------------------

create policy organizations_select on organizations for select to authenticated
using (public.is_org_member(id));

create policy organizations_insert on organizations for insert to authenticated
with check (created_by = auth.uid());

create policy organizations_update on organizations for update to authenticated
using (public.role_at_least(id, 'admin'))
with check (public.role_at_least(id, 'admin'));

create policy organizations_delete on organizations for delete to authenticated
using (public.role_in(id) = 'owner');

-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------

create policy organization_members_select on organization_members for select to authenticated
using (public.is_org_member(organization_id));

-- An owner/admin may add members. A user may also claim ownership of an
-- organization they just created (the first membership row).
create policy organization_members_insert on organization_members for insert to authenticated
with check (
  public.role_at_least(organization_id, 'admin')
  or (
    user_id = auth.uid()
    and role = 'owner'
    and exists (select 1 from organizations o where o.id = organization_id and o.created_by = auth.uid())
  )
);

-- Role changes require owner/admin; the last owner cannot demote themselves.
create policy organization_members_update on organization_members for update to authenticated
using (public.role_at_least(organization_id, 'admin'))
with check (public.role_at_least(organization_id, 'admin'));

create policy organization_members_delete on organization_members for delete to authenticated
using (
  public.role_at_least(organization_id, 'admin')
  and (
    -- Cannot remove the last owner.
    role <> 'owner'
    or exists (
      select 1 from organization_members other
      where other.organization_id = organization_members.organization_id
        and other.role = 'owner'
        and other.user_id <> organization_members.user_id
    )
  )
);

-- ---------------------------------------------------------------------------
-- projects / environments
-- ---------------------------------------------------------------------------

create policy projects_select on projects for select to authenticated
using (public.is_org_member(organization_id));

create policy projects_insert on projects for insert to authenticated
with check (public.role_at_least(organization_id, 'member') and created_by = auth.uid());

create policy projects_update on projects for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (public.role_at_least(organization_id, 'member'));

create policy projects_delete on projects for delete to authenticated
using (public.role_at_least(organization_id, 'admin'));

create policy environments_select on environments for select to authenticated
using (public.is_org_member(organization_id));

create policy environments_insert on environments for insert to authenticated
with check (
  public.role_at_least(organization_id, 'member')
  and exists (select 1 from projects p where p.id = project_id and p.organization_id = environments.organization_id)
);

create policy environments_update on environments for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (public.role_at_least(organization_id, 'member'));

create policy environments_delete on environments for delete to authenticated
using (public.role_at_least(organization_id, 'admin'));

-- ---------------------------------------------------------------------------
-- deployments: users read and request; only the service worker mutates status
-- ---------------------------------------------------------------------------

create policy deployments_select on deployments for select to authenticated
using (public.is_org_member(organization_id));

create policy deployments_insert on deployments for insert to authenticated
with check (
  public.role_at_least(organization_id, 'member')
  and requested_by = auth.uid()
  and exists (select 1 from projects p where p.id = project_id and p.organization_id = deployments.organization_id)
);

-- No user-facing UPDATE policy: status transitions are written by the worker
-- through the service role, so a client cannot mark its own deployment
-- succeeded.

create policy deployments_delete on deployments for delete to authenticated
using (public.role_at_least(organization_id, 'admin'));

-- ---------------------------------------------------------------------------
-- data resources and backups
-- ---------------------------------------------------------------------------

create policy data_resources_select on data_resources for select to authenticated
using (public.is_org_member(organization_id));

create policy data_resources_insert on data_resources for insert to authenticated
with check (public.role_at_least(organization_id, 'member'));

create policy data_resources_update on data_resources for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (public.role_at_least(organization_id, 'member'));

create policy data_resources_delete on data_resources for delete to authenticated
using (public.role_at_least(organization_id, 'admin'));

create policy data_backups_select on data_backups for select to authenticated
using (public.is_org_member(organization_id));

-- Backups are requested through the API but the row is written by the worker
-- with the service role. Users may only read.

-- ---------------------------------------------------------------------------
-- domains
-- ---------------------------------------------------------------------------

create policy domains_select on domains for select to authenticated
using (public.is_org_member(organization_id));

create policy domains_insert on domains for insert to authenticated
with check (public.role_at_least(organization_id, 'member'));

create policy domains_update on domains for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (public.role_at_least(organization_id, 'member'));

create policy domains_delete on domains for delete to authenticated
using (public.role_at_least(organization_id, 'admin'));

-- ---------------------------------------------------------------------------
-- security policies
-- ---------------------------------------------------------------------------

create policy security_policies_select on security_policies for select to authenticated
using (public.is_org_member(organization_id));

create policy security_policies_insert on security_policies for insert to authenticated
with check (public.role_at_least(organization_id, 'admin') and created_by = auth.uid());

create policy security_policies_update on security_policies for update to authenticated
using (public.role_at_least(organization_id, 'admin'))
with check (public.role_at_least(organization_id, 'admin'));

create policy security_policies_delete on security_policies for delete to authenticated
using (public.role_in(organization_id) = 'owner');

-- ---------------------------------------------------------------------------
-- api keys: names are readable; the hash is never selectable by a client
-- ---------------------------------------------------------------------------

-- Column-level protection: the hash must never be readable by a client.
-- A column-level REVOKE is not enough while a table-level SELECT grant exists
-- (the table grant still covers every column), so the table grant is revoked
-- and only the safe columns are re-granted. The hash column is therefore
-- excluded from any client-issued `select *`.
revoke select on api_keys from authenticated;
grant select (
  id, organization_id, name, key_prefix, owner_id, scopes,
  last_used_at, revoked_at, created_at
) on api_keys to authenticated;

create policy api_keys_select on api_keys for select to authenticated
using (public.role_at_least(organization_id, 'admin') or owner_id = auth.uid());

create policy api_keys_insert on api_keys for insert to authenticated
with check (public.role_at_least(organization_id, 'member') and owner_id = auth.uid());

-- Revocation is an UPDATE of revoked_at.
create policy api_keys_update on api_keys for update to authenticated
using (public.role_at_least(organization_id, 'admin') or owner_id = auth.uid())
with check (public.role_at_least(organization_id, 'admin') or owner_id = auth.uid());

create policy api_keys_delete on api_keys for delete to authenticated
using (public.role_at_least(organization_id, 'admin'));

-- ---------------------------------------------------------------------------
-- orchestration jobs and usage: read-only for members, service-role written
-- ---------------------------------------------------------------------------

create policy orchestration_jobs_select on orchestration_jobs for select to authenticated
using (public.is_org_member(organization_id));

create policy usage_records_select on usage_records for select to authenticated
using (public.is_org_member(organization_id));

-- ---------------------------------------------------------------------------
-- audit logs: append-only from the service role, readable by members
-- ---------------------------------------------------------------------------

create policy audit_logs_select on audit_logs for select to authenticated
using (public.is_org_member(organization_id));

-- Intentionally no UPDATE or DELETE policy: audit rows are immutable for every
-- role, including owners.
