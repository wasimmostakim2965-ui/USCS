-- ---------------------------------------------------------------------------
-- 0029 — a row's project_id must name a project in the same organization
--
-- `environment_insert` and `deployments_insert` in `0002` already refuse a row
-- whose `project_id` points at another tenant's project. Four tables added since
-- did not carry that check, so a browser holding only the anon key could write,
-- through PostgREST directly, a row in organization A whose `project_id` names
-- organization B's project:
--
--   * data_resources   (0002)   — `data_resources_insert`
--   * domains          (0002)   — `domains_insert`
--   * project_git_links(0011)   — `project_git_links_insert`
--   * project_env_vars (0015)   — `project_env_vars_insert`
--
-- The row stays inside the writer's own organization (RLS's `organization_id`
-- check still holds), so this is not a read of another tenant's data. It is an
-- integrity break: a foreign key that silently points across the tenant
-- boundary, which any future join, cascade or service-role read that trusts the
-- pair would follow into the wrong organization. AGENTS.md's rule is explicit —
-- anything the API enforces in TypeScript must also be enforced in the database,
-- because the browser holds the anon key and can reach PostgREST without the API.
--
-- The fix mirrors `environments_insert`: the `project_id` must resolve to a
-- project rows in the same organization as the row. It is applied to both INSERT
-- and UPDATE, because the same write is reachable by moving `project_id` on an
-- existing row.
--
-- `project_env_vars` additionally names an `environment_id` (0025). An
-- environment is a child of a project, so the same rule is extended: the named
-- environment must belong to the same organization *and* to the named project,
-- or a variable could be scoped to another project's environment.
-- ---------------------------------------------------------------------------

-- --- data_resources ---------------------------------------------------------
drop policy if exists data_resources_insert on data_resources;
create policy data_resources_insert on data_resources for insert to authenticated
with check (
  public.role_at_least(organization_id, 'member')
  and exists (
    select 1 from projects p
     where p.id = project_id and p.organization_id = data_resources.organization_id
  )
);

drop policy if exists data_resources_update on data_resources;
create policy data_resources_update on data_resources for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (
  public.role_at_least(organization_id, 'member')
  and exists (
    select 1 from projects p
     where p.id = project_id and p.organization_id = data_resources.organization_id
  )
);

-- --- domains ----------------------------------------------------------------
drop policy if exists domains_insert on domains;
create policy domains_insert on domains for insert to authenticated
with check (
  public.role_at_least(organization_id, 'member')
  and (
    project_id is null
    or exists (
      select 1 from projects p
       where p.id = project_id and p.organization_id = domains.organization_id
    )
  )
);

drop policy if exists domains_update on domains;
create policy domains_update on domains for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (
  public.role_at_least(organization_id, 'member')
  and (
    project_id is null
    or exists (
      select 1 from projects p
       where p.id = project_id and p.organization_id = domains.organization_id
    )
  )
);

-- --- project_git_links ------------------------------------------------------
drop policy if exists project_git_links_insert on project_git_links;
create policy project_git_links_insert on project_git_links for insert to authenticated
with check (
  public.role_at_least(organization_id, 'member')
  and created_by = auth.uid()
  and exists (
    select 1 from projects p
     where p.id = project_id and p.organization_id = project_git_links.organization_id
  )
);

drop policy if exists project_git_links_update on project_git_links;
create policy project_git_links_update on project_git_links for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (
  public.role_at_least(organization_id, 'member')
  and exists (
    select 1 from projects p
     where p.id = project_id and p.organization_id = project_git_links.organization_id
  )
);

-- --- project_env_vars -------------------------------------------------------
-- The project check is the same as the others; the environment check is
-- stronger because the environment must belong to the *named project*, not
-- merely the same organization — otherwise a variable could name project X and
-- an environment that belongs to project Y of the same tenant.
drop policy if exists project_env_vars_insert on project_env_vars;
create policy project_env_vars_insert on project_env_vars for insert to authenticated
with check (
  public.role_at_least(organization_id, 'member')
  and updated_by = auth.uid()
  and exists (
    select 1 from projects p
     where p.id = project_id and p.organization_id = project_env_vars.organization_id
  )
  and (
    environment_id is null
    or exists (
      select 1 from environments e
       where e.id = environment_id
         and e.project_id = project_env_vars.project_id
         and e.organization_id = project_env_vars.organization_id
    )
  )
);

drop policy if exists project_env_vars_update on project_env_vars;
create policy project_env_vars_update on project_env_vars for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (
  public.role_at_least(organization_id, 'member')
  and exists (
    select 1 from projects p
     where p.id = project_id and p.organization_id = project_env_vars.organization_id
  )
  and (
    environment_id is null
    or exists (
      select 1 from environments e
       where e.id = environment_id
         and e.project_id = project_env_vars.project_id
         and e.organization_id = project_env_vars.organization_id
    )
  )
);
