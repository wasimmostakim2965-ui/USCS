-- Cloud Wai control-plane schema.
--
-- This database is the permanent source of truth for identity, organizations,
-- projects, deployments, data resources, domains, policies, API keys, usage,
-- jobs and audit. Customer tenant databases live in a separate data plane and
-- must never be reachable from here.
--
-- RLS is enabled on every table below. Scope is always resolved from
-- auth.uid() through organization_members; a client-supplied organization id is
-- never trusted.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type org_role as enum ('owner', 'admin', 'member', 'viewer');
create type engine_status as enum ('pending', 'running', 'succeeded', 'failed', 'degraded', 'not_configured');
create type risk_level as enum ('low', 'medium', 'high', 'critical');
create type enforcement_action as enum ('allow', 'log', 'challenge', 'block', 'quarantine');
create type job_state as enum ('queued', 'running', 'succeeded', 'failed', 'cancelled');
create type data_resource_state as enum ('provisioning', 'ready', 'restoring', 'failed', 'not_configured');
create type policy_state as enum ('draft', 'compiled', 'distributed', 'active', 'rejected', 'degraded');

-- ---------------------------------------------------------------------------
-- Profiles — one row per Supabase auth user
-- ---------------------------------------------------------------------------

create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  display_name text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Organizations — the tenant boundary
-- ---------------------------------------------------------------------------

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 1 and 120),
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table organization_members (
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            org_role not null default 'viewer',
  invited_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_members_user_idx on organization_members (user_id);

-- ---------------------------------------------------------------------------
-- Scope helpers
--
-- Both are `security definer` so a policy on any table costs one indexed
-- lookup and cannot recurse into organization_members' own policy. `stable` is
-- required so the planner can cache them within a statement.
-- ---------------------------------------------------------------------------

create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from organization_members m
    where m.organization_id = target_org and m.user_id = auth.uid()
  );
$$;

create or replace function public.role_in(target_org uuid)
returns org_role
language sql
security definer
stable
set search_path = public
as $$
  select m.role from organization_members m
  where m.organization_id = target_org and m.user_id = auth.uid()
  limit 1;
$$;

create or replace function public.role_at_least(target_org uuid, minimum org_role)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select array_position(
       array['viewer','member','admin','owner']::org_role[],
       public.role_in(target_org)
     ) >= array_position(
       array['viewer','member','admin','owner']::org_role[],
       minimum
     )),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------

create table projects (
  id             uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name           text not null check (length(trim(name)) between 1 and 120),
  slug           text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  provider       text,
  provider_resource_id text,
  created_by     uuid not null references auth.users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (organization_id, slug)
);

create index projects_org_idx on projects (organization_id);

create table environments (
  id             uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id     uuid not null references projects (id) on delete cascade,
  name           text not null check (length(trim(name)) between 1 and 60),
  is_default     boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (project_id, name)
);

create index environments_org_idx on environments (organization_id);

-- ---------------------------------------------------------------------------
-- Deployments — the operation log for hosting engines
-- ---------------------------------------------------------------------------

create table deployments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id      uuid not null references projects (id) on delete cascade,
  environment_id  uuid references environments (id) on delete set null,
  status          engine_status not null default 'pending',
  provider        text,
  provider_resource_id text,
  url             text,
  idempotency_key text not null,
  requested_by    uuid not null references auth.users (id),
  failure_reason  text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  unique (organization_id, idempotency_key)
);

create index deployments_org_idx on deployments (organization_id);
create index deployments_project_idx on deployments (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Data resources (tenant database / bucket handles)
-- ---------------------------------------------------------------------------

create table data_resources (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id      uuid references projects (id) on delete cascade,
  kind            text not null check (kind in ('postgres', 'object_storage')),
  name            text not null check (length(trim(name)) between 1 and 120),
  state           data_resource_state not null default 'provisioning',
  provider        text,
  provider_resource_id text,
  -- Never store raw tenant credentials here; only a reference into the secret store.
  secret_ref      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, kind, name)
);

create index data_resources_org_idx on data_resources (organization_id);

create table data_backups (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations (id) on delete cascade,
  data_resource_id  uuid not null references data_resources (id) on delete cascade,
  provider          text,
  provider_resource_id text,
  size_bytes        bigint check (size_bytes >= 0),
  status            engine_status not null default 'pending',
  created_at        timestamptz not null default now(),
  finished_at       timestamptz
);

create index data_backups_org_idx on data_backups (organization_id);

-- ---------------------------------------------------------------------------
-- Domains
-- ---------------------------------------------------------------------------

create table domains (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  project_id      uuid references projects (id) on delete set null,
  hostname        text not null check (hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  verified        boolean not null default false,
  provider        text,
  provider_resource_id text,
  created_at      timestamptz not null default now(),
  unique (organization_id, hostname)
);

create index domains_org_idx on domains (organization_id);

-- ---------------------------------------------------------------------------
-- Security policies — versioned per organization, monotonic
-- ---------------------------------------------------------------------------

create table security_policies (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 120),
  risk_level      risk_level not null default 'medium',
  action          enforcement_action not null default 'log',
  state           policy_state not null default 'draft',
  -- Monotonic per organization: the edge rejects a lower version.
  version         integer not null default 1 check (version >= 1),
  created_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, name)
);

create index security_policies_org_idx on security_policies (organization_id);

-- ---------------------------------------------------------------------------
-- API keys — hashed, scoped, never returned after creation
-- ---------------------------------------------------------------------------

create table api_keys (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name            text not null check (length(trim(name)) between 1 and 120),
  -- Only the hash and a short display prefix are stored.
  key_hash        text not null unique,
  key_prefix      text not null,
  owner_id        uuid not null references auth.users (id),
  scopes          text[] not null default '{}',
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index api_keys_org_idx on api_keys (organization_id);

-- ---------------------------------------------------------------------------
-- Orchestration jobs and usage
-- ---------------------------------------------------------------------------

create table orchestration_jobs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  kind            text not null,
  state           job_state not null default 'queued',
  payload         jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  attempts        integer not null default 0 check (attempts >= 0),
  last_error      text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  unique (organization_id, idempotency_key)
);

create index orchestration_jobs_org_idx on orchestration_jobs (organization_id);
create index orchestration_jobs_state_idx on orchestration_jobs (state, created_at);

create table usage_records (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  metric          text not null,
  quantity        numeric not null check (quantity >= 0),
  recorded_at     timestamptz not null default now()
);

create index usage_records_org_idx on usage_records (organization_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- Audit log — append-only
--
-- No UPDATE or DELETE policy is ever created for this table, so those
-- operations are denied for every role including owners. The row is written by
-- the service role when a command is accepted.
-- ---------------------------------------------------------------------------

create table audit_logs (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  actor_id        uuid references auth.users (id),
  actor_email     text,
  event           text not null,
  target_type     text,
  target_id       uuid,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index audit_logs_org_idx on audit_logs (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles','organizations','projects','data_resources','security_policies']
  loop
    execute format(
      'create trigger %I_touch before update on %I for each row execute function public.touch_updated_at()',
      t, t
    );
  end loop;
end;
$$;
