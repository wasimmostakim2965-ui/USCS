-- ---------------------------------------------------------------------------
-- 0015 — environment variables per project (matrix P13 / audit D5)
--
-- Vercel's most-used project setting has no equivalent here: a customer had no
-- way to give their application a `DATABASE_URL` without editing the engine by
-- hand. The hosting adapter now exposes Coolify's `/applications/{uuid}/envs`
-- routes (`listEnvVars` / `createEnvVar` / `updateEnvVar` / `deleteEnvVar`), so
-- the remaining work is the control-plane half: a table, RLS, and the write
-- path. This is that table.
--
-- One row per project per key:
--
--   * `key` is normalised to the same shape Coolify accepts — uppercase letters,
--     digits and underscores — because the engine is the system of record for
--     what a build receives, and two spellings of one key would be two rows here
--     and one variable there.
--   * `value_encrypted` is AES-256-GCM ciphertext produced by `SecretCipher`
--     (the same scheme `project_git_links.secret_encrypted` uses). The plaintext
--     is never stored and never returned to a browser; the *presence* of a value
--     is what the dashboard shows. `value_prefix` is a short non-secret fragment
--     so a customer can tell two variables apart.
--   * `is_build_time` mirrors Coolify's `is_buildtime`: whether a build-step
--     change means the running output changed. A change to a build-time variable
--     is expressed as a *deployment*, never a silent in-place edit, which is the
--     rule the master plan set for this section.
--   * `engine_ref` is the engine's own handle for the variable. It is
--     engine-owned, so a client cannot set or move it (see the guard below): it
--     is how a delete addresses the variable after an upsert.
--
-- Who may read and write: a member reads the key inventory (never a value); a
-- member and above may set or remove a variable, the same threshold as renaming
-- the project, because a member who can already trigger a production deploy is
-- not made less trustworthy by also setting the variables that deploy reads.
-- ---------------------------------------------------------------------------

create table if not exists project_env_vars (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id      uuid not null references projects (id) on delete cascade,
  key             text not null check (key ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  -- AES-256-GCM ciphertext. Never a plaintext column, never selectable by a
  -- client (see the grant revocation below).
  value_encrypted text not null,
  -- A short non-secret fragment naming the variable in a list response.
  value_prefix    text not null,
  is_build_time   boolean not null default true,
  -- The engine's own handle for this variable, written only by the API from the
  -- adapter's answer. Null until the variable has reached the engine.
  engine_ref      text,
  -- The engine application the variable was last written to, so a value change
  -- to a different application (a preview vs production) is visible rather than
  -- silent. Kept alongside the ref for auditability.
  provider        text,
  provider_resource_id text,
  -- The member who last set it, so an audit reader can attribute a change.
  updated_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, key)
);

create index if not exists project_env_vars_org_idx
  on project_env_vars (organization_id, created_at desc);
create index if not exists project_env_vars_project_idx
  on project_env_vars (project_id);

alter table project_env_vars enable row level security;

-- A member reads which variables exist; the value ciphertext is not in the
-- grant. Setting or removing a variable is a project-settings act, so the
-- threshold is the same as `projects.update` in `0002`.
create policy project_env_vars_select on project_env_vars for select to authenticated
using (public.is_org_member(organization_id));

create policy project_env_vars_insert on project_env_vars for insert to authenticated
with check (
  public.role_at_least(organization_id, 'member') and updated_by = auth.uid()
);

create policy project_env_vars_update on project_env_vars for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (public.role_at_least(organization_id, 'member'));

create policy project_env_vars_delete on project_env_vars for delete to authenticated
using (public.role_at_least(organization_id, 'member'));

-- The ciphertext and its prefix are never selected by a client. A column-level
-- REVOKE is not enough while the table SELECT grant covers every column, so —
-- exactly as `api_keys.key_hash` in `0002` and `project_git_links` in `0011` —
-- the table grant is revoked and only the safe columns are re-granted.
revoke select on project_env_vars from authenticated;
grant select (
  id, organization_id, project_id, key, value_prefix, is_build_time,
  updated_by, created_at, updated_at
) on project_env_vars to authenticated;

-- `engine_ref`, `provider` and `provider_resource_id` are the engine's answer,
-- not a customer's to assert. They change only from the adapter's reply, through
-- the service role, exactly like `domains.verified` in `0006`.
create trigger project_env_vars_guard_engine_columns
  before update on project_env_vars
  for each row execute function public.guard_engine_columns(
    'engine_ref', 'provider', 'provider_resource_id'
  );

create trigger project_env_vars_guard_engine_columns_insert
  before insert on project_env_vars
  for each row execute function public.guard_engine_columns_on_insert(
    'engine_ref=null', 'provider=null', 'provider_resource_id=null'
  );

create trigger project_env_vars_touch
  before update on project_env_vars
  for each row execute function public.touch_updated_at();
