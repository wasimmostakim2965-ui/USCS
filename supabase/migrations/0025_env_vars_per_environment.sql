-- ---------------------------------------------------------------------------
-- 0025 — environment variables are scoped to an environment (matrix P13)
--
-- `0015` made environment variables real, but per *project*: a key was unique
-- per project, and one value served every build. Vercel's model is per
-- environment — the same `DATABASE_URL` key holds a staging value for Preview
-- and a production value for Production — and that is the shape the dashboard's
-- Environment Variables dialog is built around. With `0024` giving every project
-- a Production and a Preview environment, the missing half is this column.
--
-- What changes:
--
--   * `environment_id` is added, backfilled to each project's Production
--     environment (which `0024` guarantees exists), then made NOT NULL. A
--     variable written before this migration therefore keeps its behaviour: it
--     applies to production, which is what it did when there was one set of
--     variables per project.
--   * The uniqueness moves from `(project_id, key)` to
--     `(project_id, environment_id, key)`, so the same key may exist once per
--     environment — the point of the feature — and still exactly once within one
--     environment, so a build reads one value per key.
--   * `environment_id` is a *request* attribute, not an engine observation: a
--     client names which environment a variable belongs to, exactly like
--     `deployments.environment_id` in `0009`. It is therefore not guarded.
--     `engine_ref`/`provider`/`provider_resource_id` stay guarded from `0015`,
--     and the value ciphertext stays outside the client SELECT grant.
--
-- The foreign key is `on delete cascade`: an environment is part of its project,
-- and a variable cannot outlive the environment it is scoped to.
-- ---------------------------------------------------------------------------

alter table project_env_vars
  add column if not exists environment_id uuid references environments (id) on delete cascade;

-- Backfill to the project's Production environment. A project with no production
-- row would be a project created before `0024`'s backfill ran, which the same
-- migration prevents; the `coalesce` to the project's oldest environment keeps
-- this statement total rather than leaving a null that the NOT NULL below would
-- then reject with an opaque error.
update project_env_vars v
   set environment_id = coalesce(
     (select e.id from environments e
       where e.project_id = v.project_id and e.kind = 'production'),
     (select e.id from environments e
       where e.project_id = v.project_id
       order by e.created_at asc, e.id asc
       limit 1)
   )
 where v.environment_id is null;

-- Only enforce NOT NULL once every row has one, so a deployment that runs this
-- against real data cannot fail half-way.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'project_env_vars'
       and column_name = 'environment_id'
       and is_nullable = 'YES'
  ) and not exists (select 1 from project_env_vars where environment_id is null) then
    alter table project_env_vars alter column environment_id set not null;
  end if;
end;
$$;

-- The old key named one variable per project; the new one names one per
-- environment. Dropping it is what allows a Preview row and a Production row to
-- share a key.
alter table project_env_vars
  drop constraint if exists project_env_vars_project_id_key_key;

create unique index if not exists project_env_vars_env_key_idx
  on project_env_vars (project_id, environment_id, key);

create index if not exists project_env_vars_environment_idx
  on project_env_vars (environment_id);

comment on column project_env_vars.environment_id is
  'The environment this variable belongs to (Production or Preview). A request attribute, not an engine observation, so it is not frozen by the engine-column guard.';
