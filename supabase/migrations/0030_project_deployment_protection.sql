-- ---------------------------------------------------------------------------
-- 0030 — deployment protection for preview and production hostnames
--        (matrix P12 / audit D7, the roadmap's Phase D win condition)
--
-- The gap this closes is the one every preview-deployment story runs into: a
-- preview URL is a public URL, so an unshipped branch, a half-finished page and
-- a customer's staging data are reachable by anyone who guesses the hostname.
-- Vercel answers this with Deployment Protection — password, Vercel
-- Authentication, or an IP allow-list, applied at the edge in front of the
-- deployment. This migration is the control-plane half of the same control: the
-- edge already owns the decision, so all that is missing is the state the
-- decision is compiled from.
--
-- One row per project, because protection is a property of an application (its
-- previews and its production host share the setting), not of a single hostname.
-- A project with no row is unprotected, which is the honest default: protection
-- is opt-in, exactly like preview builds (`project_git_links.previews_enabled`).
--
-- What is stored, and what is deliberately not:
--
--   * `mode` — `none`, `password`, or `ip`. `password` is HTTP basic auth; `ip`
--     is an allow-list of source addresses. `none` is a real, stored choice (an
--     operator turning protection *off* is a change worth recording), so it is a
--     row like any other rather than a missing row.
--   * `basic_password_hash` — a one-way SHA-256 digest of the password, never the
--     password. Unlike the git webhook secret it cannot be a reversible
--     ciphertext: the edge only ever *verifies* a password a visitor sends, it
--     never needs to recover one, so a digest is both sufficient and strictly
--     safer (a leaked digest does not reveal the password, and no
--     `CLOUD_WAI_SECRET_ENCRYPTION_KEY` is needed to protect a preview).
--     The plaintext is shown to the operator exactly once, at save time, the same
--     contract as an API key secret and a webhook secret.
--   * `allowed_cidrs` — the `ip` mode's allow-list. Stored as text[] and
--     validated at the API boundary and again at compile time against the same
--     CIDR grammar the trusted-source list uses, so a value that reaches the
--     edge is always one the compiler will emit.
--   * `engine_ref` / `provider` / `provider_resource_id` — the edge's own handle
--     for the applied policy, guarded exactly like every other engine-observed
--     column (`0006`): a client asserts the *intent* (mode, addresses), never the
--     fact that an edge accepted it.
--   * `version` — monotonic like `security_policies.version`, so a distribution
--     can never silently apply an older protection than the one on record.
--
-- Who may read and write: a member reads the mode (never the hash); turning
-- protection on or off, or rewriting its password or allow-list, is an admin act,
-- because a mis-set allow-list is a self-inflicted lockout or an accidental
-- exposure, and neither should be a member's routine click.
-- ---------------------------------------------------------------------------

create table if not exists project_deployment_protection (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id      uuid not null references projects (id) on delete cascade,
  mode            text not null default 'none'
                    check (mode in ('none', 'password', 'ip')),
  -- HTTP basic auth. Set together, or not at all.
  basic_user      text
                    check (basic_user is null or basic_user ~ '^[A-Za-z0-9._@-]{1,64}$'),
  -- SHA-256 hex of the password. One-way on purpose: the edge verifies, it never
  -- recovers. Never a plaintext column, never selectable by a client (the grant
  -- revocation below enforces the second half).
  basic_password_hash text
                    check (basic_password_hash is null or basic_password_hash ~ '^[0-9a-f]{64}$'),
  -- The `ip` mode's allow-list. Empty for a `password` or `none` row.
  allowed_cidrs   text[] not null default '{}',
  -- An expiring protection window, so a "protect this until the client reviews
  -- it" click does not become a permanent password nobody remembers. A past
  -- timestamp lapses back to `none` at compile time, the same rule attack mode
  -- uses (`security_policies.protection_expires_at`).
  protection_expires_at timestamptz,
  -- Monotonic, so a distribution never applies an older protection than the one
  -- recorded.
  version         integer not null default 1 check (version >= 1),
  -- The edge's own handle for what it applied. Engine-observed, guarded below.
  engine_ref      text,
  provider        text,
  provider_resource_id text,
  updated_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One protection row per project: a project has exactly one posture, not a set
  -- of competing ones.
  unique (project_id),
  -- The mode decides which fields are present. A `password` row names a user and
  -- a hash; an `ip` row names at least one address; a `none` row names neither,
  -- so a half-specified posture cannot be stored and read back as if it worked.
  check (
    (mode = 'none'     and basic_user is null and basic_password_hash is null and cardinality(allowed_cidrs) = 0)
    or (mode = 'password' and basic_user is not null and basic_password_hash is not null and cardinality(allowed_cidrs) = 0)
    or (mode = 'ip'     and basic_user is null and basic_password_hash is null and cardinality(allowed_cidrs) >= 1)
  )
);

create index if not exists project_deployment_protection_org_idx
  on project_deployment_protection (organization_id, created_at desc);
create index if not exists project_deployment_protection_project_idx
  on project_deployment_protection (project_id);

alter table project_deployment_protection enable row level security;

-- A member reads the posture (which mode, which addresses), never the hash.
create policy project_deployment_protection_select on project_deployment_protection
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy project_deployment_protection_insert on project_deployment_protection
  for insert to authenticated
  with check (
    public.role_at_least(organization_id, 'admin') and updated_by = auth.uid()
  );

create policy project_deployment_protection_update on project_deployment_protection
  for update to authenticated
  using (public.role_at_least(organization_id, 'admin'))
  with check (public.role_at_least(organization_id, 'admin'));

create policy project_deployment_protection_delete on project_deployment_protection
  for delete to authenticated
  using (public.role_at_least(organization_id, 'admin'));

-- The password digest is never selected by a client. A column-level REVOKE is
-- not enough while the table SELECT grant covers every column, so — exactly as
-- `api_keys.key_hash` in `0002`, `project_git_links.secret_encrypted` in `0011`
-- and `project_env_vars.value_encrypted` in `0015` — the table grant is revoked
-- and only the safe columns are re-granted.
revoke select on project_deployment_protection from authenticated;
grant select (
  id, organization_id, project_id, mode, basic_user, allowed_cidrs,
  protection_expires_at, version, updated_by, created_at, updated_at
) on project_deployment_protection to authenticated;

-- The edge's answer is not a customer's to assert. It changes only from the
-- adapter's reply, through the service role, exactly like `domains.verified`.
create trigger project_deployment_protection_guard_engine_columns
  before update on project_deployment_protection
  for each row execute function public.guard_engine_columns(
    'engine_ref', 'provider', 'provider_resource_id'
  );

create trigger project_deployment_protection_guard_engine_columns_insert
  before insert on project_deployment_protection
  for each row execute function public.guard_engine_columns_on_insert(
    'engine_ref=null', 'provider=null', 'provider_resource_id=null'
  );

create trigger project_deployment_protection_touch
  before update on project_deployment_protection
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Widen the recorded decision stages for the protection step.
--
-- Deployment protection is decided *before* every other stage — a request has no
-- route to inspect until basic auth has passed — so the compiled ladder gained a
-- `protect` step ahead of `allow-verified-bot`. The `security_events.stage` check
-- would have rejected an edge reporting that decision, so the decision would be
-- silently unrecordable, exactly the drift `0018` fixed for `allow-trusted-ip`
-- and `ratelimit`. This restates the check from the ladder the compiler produces.
-- ---------------------------------------------------------------------------

alter table security_events
  drop constraint if exists security_events_stage_check;

alter table security_events
  add constraint security_events_stage_check check (
    stage in ('protect','allow-verified-bot','allow-internal','allow-trusted-ip',
              'block-deny-list','ratelimit','challenge','waf','log','pass')
  );
