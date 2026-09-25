-- ---------------------------------------------------------------------------
-- 0011 — git integration: a repository linked to a project, and preview builds
--
-- This is the data half of the largest gap in `docs/competitive/vercel-feature-matrix.md`
-- (P8/P9/P10): today a deploy carries a repo URL in a text box and nothing can
-- trigger it but a click. A linked repository turns a push into a deployment.
--
-- Two additions:
--
--   * `project_git_links` — one row per (project, provider, repository). The row
--     holds the production branch and the webhook secret the receiver verifies a
--     delivery against. Each row is organization-scoped with RLS, and the secret
--     ciphertext is removed from the client SELECT grant exactly as
--     `api_keys.key_hash` is in `0002`: a browser may read which repository is
--     linked, never the key that authenticates its webhook.
--
--   * `deployments.kind` (+ `git_branch`, `git_commit`, `pull_request`) — a
--     deployment is either a production build or a preview build for a branch or
--     pull request. These are the *request*, not an engine observation, so they
--     are not frozen by `guard_engine_columns`; the engine-owned columns
--     (`status`, `url`, `provider_resource_id`, …) stay guarded by `0009`.
--
-- The secret is stored encrypted, never in the clear: the receiver must be able
-- to recompute an HMAC, so unlike an API key it cannot be a one-way hash. The
-- ciphertext is produced by the API with `CLOUD_WAI_SECRET_ENCRYPTION_KEY`
-- (AES-256-GCM) and is never readable by a client. Without that key configured,
-- linking a repository is an honest `not_configured` rather than a stored
-- plaintext secret.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'deployment_kind') then
    create type deployment_kind as enum ('production', 'preview');
  end if;
end;
$$;

alter table deployments
  add column if not exists kind deployment_kind not null default 'production',
  add column if not exists git_branch text,
  add column if not exists git_commit text,
  add column if not exists pull_request integer check (pull_request is null or pull_request > 0),
  -- A stable key for a preview target (`pr-42`, `branch-feature-x`), so a
  -- branch's engine application is reused across pushes instead of leaking a
  -- new one per delivery. Null for a production deployment.
  add column if not exists preview_key text;

comment on column deployments.kind is
  'production = the linked branch; preview = a branch or pull request build. A request attribute, not an engine observation.';
comment on column deployments.pull_request is
  'The pull-request number a preview deployment was built for, when it came from one.';
comment on column deployments.preview_key is
  'The stable identity of a preview target, so its engine application is reused rather than duplicated.';

create index if not exists deployments_kind_idx on deployments (project_id, kind, created_at desc);
create index if not exists deployments_preview_idx
  on deployments (project_id, preview_key, created_at desc)
  where preview_key is not null;

-- ---------------------------------------------------------------------------
-- The linked repositories
-- ---------------------------------------------------------------------------

create table if not exists project_git_links (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id      uuid not null references projects (id) on delete cascade,
  provider        text not null check (provider in ('github', 'gitlab', 'bitbucket', 'generic')),
  -- Normalised as `owner/name` (lower-cased, no trailing `.git`), so the same
  -- repository cannot be linked twice under two spellings.
  repository      text not null check (repository ~ '^[a-z0-9._-]+/[a-z0-9._-]+$'),
  -- The branch a push to which builds production.
  production_branch text not null default 'main' check (length(trim(production_branch)) between 1 and 200),
  -- Preview builds are opt-in: a repository that wants one environment should
  -- not get a URL per branch by surprise.
  previews_enabled boolean not null default false,
  -- The webhook secret, encrypted at rest. Never a plaintext column, never
  -- selectable by a client (see the grant revocation below). `secret_prefix` is
  -- a short non-secret display fragment so the dashboard can name the secret.
  secret_encrypted text not null,
  secret_prefix    text not null,
  -- The member who linked it, so an audit reader can attribute the connection.
  created_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, provider, repository)
);

create index if not exists project_git_links_org_idx
  on project_git_links (organization_id, created_at desc);
create index if not exists project_git_links_project_idx
  on project_git_links (project_id);
-- The receiver resolves a link by id from a URL and has no session, so the
-- lookup index is on the primary key alone; this partial index supports the
-- duplicate-repository check the API performs before insert.
create unique index if not exists project_git_links_repo_idx
  on project_git_links (organization_id, provider, repository);

alter table project_git_links enable row level security;

-- A member reads which repository is linked; the secret is not in the grant.
-- Linking is a project-settings act, so the threshold is the same as
-- `projects.update` in `0002`: member and above. A viewer reads but cannot link;
-- a member who can already trigger a production deploy is not made less
-- trustworthy by also connecting the repository that triggers it. The secret
-- itself is generated server-side and is never readable by the client, so this
-- threshold does not hand anyone a credential.
create policy project_git_links_select on project_git_links for select to authenticated
using (public.is_org_member(organization_id));

create policy project_git_links_insert on project_git_links for insert to authenticated
with check (public.role_at_least(organization_id, 'member') and created_by = auth.uid());

create policy project_git_links_update on project_git_links for update to authenticated
using (public.role_at_least(organization_id, 'member'))
with check (public.role_at_least(organization_id, 'member'));

create policy project_git_links_delete on project_git_links for delete to authenticated
using (public.role_at_least(organization_id, 'member'));

-- The secret ciphertext and its prefix are never selected by a client. A
-- column-level REVOKE is not enough while the table SELECT grant covers every
-- column, so — exactly as `api_keys.key_hash` in `0002` — the table grant is
-- revoked and only the safe columns are re-granted.
revoke select on project_git_links from authenticated;
grant select (
  id, organization_id, project_id, provider, repository, production_branch,
  previews_enabled, created_by, created_at, updated_at
) on project_git_links to authenticated;

-- A linked repository is identified by its id in the webhook URL, so nothing
-- about the secret is ever an input to a decision a browser makes.

create trigger project_git_links_touch
  before update on project_git_links
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Preview targets — the engine application behind one preview key
--
-- A preview deployment per branch or pull request needs an engine application
-- per *target*, not per delivery: otherwise every push creates another
-- application and the engine fills with orphans. This table is that mapping
-- from `(project, key)` to the engine's application handle, so the worker finds
-- the existing one and redeploys it.
--
-- `provider_resource_id` is an engine observation, so it is frozen against a
-- client write by `guard_engine_columns`, exactly like `projects` in `0006`.
-- The key and the branch/PR are the request and stay a client's input.
-- ---------------------------------------------------------------------------

create table if not exists preview_targets (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id      uuid not null references projects (id) on delete cascade,
  -- `pr-42` or `branch-feature-x`: stable across pushes.
  preview_key     text not null check (preview_key ~ '^[a-z0-9][a-z0-9-]{0,118}$'),
  branch          text,
  pull_request    integer check (pull_request is null or pull_request > 0),
  provider        text,
  provider_resource_id text,
  created_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, preview_key)
);

create index if not exists preview_targets_org_idx
  on preview_targets (organization_id, created_at desc);

alter table preview_targets enable row level security;

-- A member reads the preview targets of projects they can see.
create policy preview_targets_select on preview_targets for select to authenticated
using (public.is_org_member(organization_id));

-- Only the API/worker records a target, through the service role: a target is
-- created as a side effect of a delivery, never chosen by a browser. There is
-- deliberately no client INSERT policy — the default is deny, following `0007`.

create trigger preview_targets_touch
  before update on preview_targets
  for each row execute function public.touch_updated_at();

-- The engine's application handle: written only by the service role.
create trigger preview_targets_guard_engine_columns
  before update on preview_targets
  for each row execute function public.guard_engine_columns(
    'provider', 'provider_resource_id'
  );

create trigger preview_targets_guard_engine_columns_insert
  before insert on preview_targets
  for each row execute function public.guard_engine_columns_on_insert(
    'provider=null', 'provider_resource_id=null'
  );
