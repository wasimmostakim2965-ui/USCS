-- ---------------------------------------------------------------------------
-- 0006 — engine-observed columns are not client-writable
--
-- Found while proving the domain write path. `domains.verified` is the edge's
-- observation of a DNS challenge, not a customer's assertion, but the table had
-- a blanket `update to authenticated` policy. Any member could therefore run
--
--     update domains set verified = true where ...
--
-- through PostgREST with their own JWT and self-certify a hostname they do not
-- control. `tests/isolation/rls/12_domain_verification_probe.sql` reproduced it
-- against the real migrations before this file existed.
--
-- `deployments` got this right by having no client-facing UPDATE policy at all:
-- status is the worker's to write through the service role. Postgres RLS cannot
-- express "all columns except these", so this migrates the same guarantee to the
-- other tables with a guard trigger: engine-owned columns may change only in a
-- `service_role` session.
--
-- The trigger, not a column GRANT, is the mechanism here. A column-level REVOKE
-- does not compose with a table-level UPDATE grant (the table grant still covers
-- every column) — the same reason `api_keys` revokes the table grant outright.
-- A trigger is per-column accurate and says which invariant it protects.
--
-- Columns that are a customer's own input stay writable: renaming a project,
-- editing a policy's risk level. Only the columns an engine reports are frozen.
-- ---------------------------------------------------------------------------

create or replace function public.guard_engine_columns()
returns trigger
language plpgsql
as $$
declare
  col text;
begin
  -- These columns belong to the API server and the worker, and to an operator
  -- running a script. Both are sessions that already bypass RLS: `service_role`
  -- carries BYPASSRLS in Supabase, as does a superuser. The role is named as
  -- well as the privilege, so the guard does not depend on how a particular
  -- deployment happened to set the flag. Any other session is a client.
  if current_user = 'service_role'
     or (select rolsuper or rolbypassrls from pg_roles where rolname = current_user)
  then
    return new;
  end if;

  -- `to_jsonb` compares by column name, so the trigger argument *is* the column
  -- list: no dynamic SQL, no PL/pgSQL record-field reflection. The `?` test is
  -- load-bearing: `to_jsonb(new) -> 'typo'` is NULL on both sides, which would
  -- read as "unchanged" and let a mistyped column name fail open. A name that is
  -- not a column of the row is an error here, not a silent pass.
  foreach col in array tg_argv loop
    if not (to_jsonb(new) ? col) then
      raise exception 'guard_engine_columns: % is not a column of %', col, tg_table_name;
    end if;
    if to_jsonb(new) -> col is distinct from to_jsonb(old) -> col then
      raise exception
        'column % on % may only be written by the service role',
        col, tg_table_name
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.guard_engine_columns() is
  'Rejects a change to engine-observed columns from a non-service_role session. Column list is supplied as trigger arguments.';

/**
 * The INSERT half of the same rule.
 *
 * Guarding UPDATE alone is not enough: a row can be *created* already claiming
 * the fact. A client that inserts `domains(verified = true)` never issues an
 * UPDATE, so the UPDATE guard never sees it. The probe caught exactly that.
 *
 * On INSERT there is no OLD to compare against, so each argument names the one
 * value a client is allowed to supply: `column=default`. Anything else is the
 * client asserting an engine's answer, which is what this refuses.
 */
create or replace function public.guard_engine_columns_on_insert()
returns trigger
language plpgsql
as $$
declare
  arg text;
  col text;
  expected text;
  actual text;
begin
  if current_user = 'service_role'
     or (select rolsuper or rolbypassrls from pg_roles where rolname = current_user)
  then
    return new;
  end if;

  foreach arg in array tg_argv loop
    col := split_part(arg, '=', 1);
    expected := nullif(split_part(arg, '=', 2), 'null');
    -- Same load-bearing existence test as the UPDATE guard: a mistyped column
    -- name would otherwise compare as NULL = NULL and fail open.
    if not (to_jsonb(new) ? col) then
      raise exception 'guard_engine_columns_on_insert: % is not a column of %', col, tg_table_name;
    end if;
    actual := to_jsonb(new) ->> col;
    if actual is distinct from expected then
      raise exception
        'column % on % may not be set to % on insert by a client',
        col, tg_table_name, coalesce(actual, 'null')
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.guard_engine_columns_on_insert() is
  'Rejects a client INSERT that pre-supplies an engine-observed column. Arguments are column=default.';

-- domains: whether the edge confirmed the hostname, how, and by which engine.
-- `verification_token` is included on purpose: a client that can choose the
-- token can verify itself, so protecting only `verified` would be theatre.
-- `hostname` is included because renaming to a name you do not control is the
-- same forgery one step earlier.
create trigger domains_guard_engine_columns
  before update on domains
  for each row execute function public.guard_engine_columns(
    'verified', 'verified_at', 'verification_token', 'provider', 'provider_resource_id', 'hostname'
  );

-- On INSERT the client may name the hostname (that is the request) but must not
-- supply the challenge token or any verification fact: those are issued by the
-- server. The token is the interesting one — a client-chosen token is a
-- self-signed certificate.
create trigger domains_guard_engine_columns_insert
  before insert on domains
  for each row execute function public.guard_engine_columns_on_insert(
    'verified=false', 'verified_at=null', 'verification_token=null',
    'provider=null', 'provider_resource_id=null'
  );

-- data_resources: provisioning state and the engine's own identifiers.
create trigger data_resources_guard_engine_columns
  before update on data_resources
  for each row execute function public.guard_engine_columns(
    'state', 'provider', 'provider_resource_id'
  );

create trigger data_resources_guard_engine_columns_insert
  before insert on data_resources
  for each row execute function public.guard_engine_columns_on_insert(
    'state=provisioning', 'provider=null', 'provider_resource_id=null'
  );

-- security_policies: the enforcement state is the edge's to report; risk_level
-- and action remain the customer's.
create trigger security_policies_guard_engine_columns
  before update on security_policies
  for each row execute function public.guard_engine_columns(
    'state'
  );

create trigger security_policies_guard_engine_columns_insert
  before insert on security_policies
  for each row execute function public.guard_engine_columns_on_insert(
    'state=draft'
  );

-- projects: which engine hosts the project is recorded by the API from the
-- engine's answer, never chosen by a browser.
create trigger projects_guard_engine_columns
  before update on projects
  for each row execute function public.guard_engine_columns(
    'provider', 'provider_resource_id'
  );

create trigger projects_guard_engine_columns_insert
  before insert on projects
  for each row execute function public.guard_engine_columns_on_insert(
    'provider=null', 'provider_resource_id=null'
  );
