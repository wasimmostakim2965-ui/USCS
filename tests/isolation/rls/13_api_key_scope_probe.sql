-- Probe: a client must not be able to mint an API key with scopes its role was
-- never granted, nor rewrite a key's scopes after issuance.
--
-- `apiKeys.create` intersects the requested scopes with the caller's role before
-- storing them. That check ran only in the API, but the browser holds the anon
-- key and the user's own JWT, so PostgREST is reachable directly. Before
-- migration 0007, `api_keys_insert` let any member insert a row for themselves
-- with arbitrary `scopes`, and `api_keys_update` let an owner rewrite them.
--
-- Self-contained: it sets up its own fixtures, so it does not depend on the
-- order another probe ran in.

\set ON_ERROR_STOP on

-- ===========================================================================
-- Setup (as the invoking role: superuser or service_role, so RLS is bypassed)
-- ===========================================================================

truncate api_keys, organization_members, organizations, profiles cascade;
delete from auth.users;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com');

insert into profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', 'Carol');

insert into organizations (id, name, slug, created_by) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'Org A', 'org-a', '11111111-1111-1111-1111-111111111111');

-- Alice owns the organization; Carol is only a member.
insert into organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333', 'member');

insert into api_keys (id, organization_id, name, key_hash, key_prefix, owner_id, scopes) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-00000000000a', 'Existing', 'hash-existing', 'cw_ex', '11111111-1111-1111-1111-111111111111', '{project:read}');

-- ===========================================================================
-- Probe: a member cannot insert a key with scopes its role never had
-- ===========================================================================

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

do $$
begin
  begin
    insert into api_keys (organization_id, name, key_hash, key_prefix, owner_id, scopes)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'Sneaky', 'hash-sneaky', 'cw_sn',
            '33333333-3333-3333-3333-333333333333', '{org:delete,billing:manage}');
    raise exception 'ESCALATION FAIL: a member inserted a key with ungranted scopes';
  exception
    when insufficient_privilege then null; -- expected: no client INSERT policy
  end;
end;
$$;

-- The same holds for the owner: scope bounding is the API's job, and no client
-- may store a scope by writing the row directly.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

do $$
declare affected int;
begin
  -- An INSERT with no policy is refused outright.
  begin
    insert into api_keys (organization_id, name, key_hash, key_prefix, owner_id, scopes)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'Owner forged', 'hash-forged', 'cw_fo',
            '11111111-1111-1111-1111-111111111111', '{org:delete}');
    raise exception 'ESCALATION FAIL: an owner inserted a key with ungranted scopes';
  exception
    when insufficient_privilege then null; -- expected
  end;

  -- An UPDATE with no policy matches no rows, so it silently affects none.
  update api_keys set scopes = '{org:delete,billing:manage}'
  where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'ESCALATION FAIL: a client rewrote api_keys.scopes (% rows)', affected;
  end if;

  -- Nor delete the row to launder a replacement in.
  delete from api_keys where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise exception 'ESCALATION FAIL: a client deleted an api key row (% rows)', affected;
  end if;

  -- Reads still work, so the dashboard can list names and prefixes.
  perform 1 from api_keys where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
end;
$$;

-- ===========================================================================
-- The service role still writes, so issuing and revoking keys keeps working
-- ===========================================================================

reset role;

do $$
declare affected int;
begin
  insert into api_keys (organization_id, name, key_hash, key_prefix, owner_id, scopes)
  values ('aaaaaaaa-0000-0000-0000-00000000000a', 'Issued by API', 'hash-issued', 'cw_is',
          '11111111-1111-1111-1111-111111111111', '{project:read}');

  update api_keys set revoked_at = now()
  where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'BROKEN FAIL: the service role could not revoke a key (% rows)', affected;
  end if;
end;
$$;
