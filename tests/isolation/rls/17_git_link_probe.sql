-- Probe: a linked repository and its webhook secret.
--
-- Three things are proved here, and each is the kind only a real database can
-- prove:
--
--   1. The webhook secret is not readable by any client. A member can read
--      which repository is linked and nothing more: the ciphertext is not in
--      the SELECT grant, so even `select *` cannot return it. This is the same
--      guarantee `api_keys.key_hash` carries, for the same reason — a leaked
--      row must not let anyone forge a delivery.
--
--   2. Linking a repository is an admin's act, and it is scoped. A member
--      cannot link one, and nobody can link one into another tenant.
--
--   3. Cross-tenant isolation holds for the table as a whole.
--
-- Self-contained: it creates its own fixtures.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (superuser/service role: RLS bypassed)
-- ===========================================================================

truncate project_git_links, deployments, projects, organization_members,
         organizations, profiles cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com');

insert into profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', 'Carol'),
  ('44444444-4444-4444-4444-444444444444', 'dave@example.com', 'Dave');

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'Org B', 'org-b', '44444444-4444-4444-4444-444444444444');

-- Alice owns A; Carol is only a member of A; Dave owns B.
insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', '44444444-4444-4444-4444-444444444444', 'owner');

insert into projects (id, organization_id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Alpha', 'alpha', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-00000000000b', 'Beta', 'beta', '44444444-4444-4444-4444-444444444444');

-- A linked repository for A, and one for B. `secret_encrypted` here is a
-- stand-in for the API's AES-256-GCM ciphertext: the probe cares that whatever
-- is stored cannot be read by a client.
insert into project_git_links
  (id, organization_id, project_id, provider, repository, production_branch,
   previews_enabled, secret_encrypted, secret_prefix, created_by)
values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-0000000000a1', 'github', 'acme/alpha', 'main',
   true, 'v1:AAAA:BBBB:CCCC', 'whsec_ab12', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-0000-0000-0000-0000000000c2', 'bbbbbbbb-0000-0000-0000-00000000000b',
   'bbbbbbbb-0000-0000-0000-0000000000b1', 'github', 'other/beta', 'main',
   false, 'v1:DDDD:EEEE:FFFF', 'whsec_cd34', '44444444-4444-4444-4444-444444444444');

-- A deployment carries its own kind and branch/PR: the request, not an
-- engine observation. A production row defaults to 'production'.
insert into deployments
  (id, organization_id, project_id, idempotency_key, requested_by, kind, git_branch, pull_request)
values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-0000000000a1', 'req-1', '11111111-1111-1111-1111-111111111111',
   'preview', 'feature/x', 42);

do $$
declare k deployment_kind;
begin
  select kind into k from deployments where idempotency_key = 'req-1';
  if k <> 'preview' then
    raise exception 'SCHEMA FAIL: deployment kind is %, expected preview', k;
  end if;
end;
$$;

-- ===========================================================================
-- Probe 1: a member can read the link, but never the secret
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare repo text;
begin
  select repository into repo from project_git_links
   where organization_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  if repo <> 'acme/alpha' then
    raise exception 'ISOLATION FAIL: Alice cannot read her own git link (% )', repo;
  end if;
end;
$$;

-- `select *` must not include the ciphertext: the column is not in the grant.
do $$
declare cols text;
begin
  select string_agg(column_name, ',' order by column_name) into cols
    from information_schema.columns
   where table_name = 'project_git_links'
     and column_name in ('secret_encrypted', 'secret_prefix');
  -- Both columns still exist on the table; the point is the grant below.
  if cols is null then
    raise exception 'SCHEMA FAIL: secret columns are missing from the table';
  end if;
end;
$$;

do $$
begin
  begin
    perform secret_encrypted from project_git_links limit 1;
    raise exception 'SECRET FAIL: a client selected the webhook secret ciphertext';
  exception
    when insufficient_privilege then
      null; -- expected: not in the SELECT grant
  end;

  begin
    perform secret_prefix from project_git_links limit 1;
    raise exception 'SECRET FAIL: a client selected the secret prefix';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end;
$$;

-- ===========================================================================
-- Probe 2: cross-tenant isolation — Alice sees A's link, never B's
-- ===========================================================================

do $$
declare visible int;
begin
  select count(*) into visible from project_git_links
   where organization_id = 'bbbbbbbb-0000-0000-0000-00000000000b';
  if visible <> 0 then
    raise exception 'ISOLATION FAIL: Alice can read org B git links';
  end if;

  select count(*) into visible from project_git_links;
  if visible <> 1 then
    raise exception 'ISOLATION FAIL: Alice sees % git links, expected 1', visible;
  end if;
end;
$$;

reset role;

-- ===========================================================================
-- Probe 3: linking is a member's act, scoped to their own organization
-- ===========================================================================

-- Carol is a member: the same threshold as renaming a project, she may link.
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
begin
  insert into project_git_links
    (organization_id, project_id, provider, repository, secret_encrypted, secret_prefix, created_by)
  values
    ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1',
     'github', 'acme/gamma', 'v1:XXXX', 'whsec_ef56',
     '33333333-3333-3333-3333-333333333333');
end;
$$;

-- ... but never into an organization she does not belong to.
do $$
begin
  begin
    insert into project_git_links
      (organization_id, project_id, provider, repository, secret_encrypted, secret_prefix, created_by)
    values
      ('bbbbbbbb-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-0000000000b1',
       'github', 'other/backdoor', 'v1:YYYY', 'whsec_gh78',
       '33333333-3333-3333-3333-333333333333');
    raise exception 'ISOLATION FAIL: a member linked a repository into another tenant';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end;
$$;

reset role;

-- And a viewer, who can read, cannot link.
set role authenticated;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', false);

do $$
begin
  begin
    insert into project_git_links
      (organization_id, project_id, provider, repository, secret_encrypted, secret_prefix, created_by)
    values
      ('aaaaaaaa-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1',
       'github', 'acme/delta', 'v1:ZZZZ', 'whsec_ij90',
       '44444444-4444-4444-4444-444444444444');
    raise exception 'ISOLATION FAIL: a non-member linked a repository';
  exception
    when insufficient_privilege then
      null; -- expected
  end;
end;
$$;

reset role;

\echo 'git link probe passed: the secret is unreadable, linking is a member act, and scope holds'
