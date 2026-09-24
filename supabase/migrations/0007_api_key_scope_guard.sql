-- ---------------------------------------------------------------------------
-- 0007 — a client cannot mint an API key with scopes it was never granted
--
-- Found while auditing the security controls. `apiKeys.create` narrows the
-- requested scopes to the caller's role with `boundedScopes` before storing
-- them, so a member asking for `org:delete` gets it dropped. That rule lived
-- only in the API, though, and the browser holds the Supabase anon key plus the
-- user's own JWT, so PostgREST is reachable directly. `api_keys_insert` allowed
-- any member to insert a row for themselves, and `api_keys_update` let the
-- owner or an admin rewrite `scopes` afterwards:
--
--     insert into api_keys (organization_id, name, key_hash, key_prefix,
--                           owner_id, scopes)
--     values (..., auth.uid(), '{org:delete,billing:manage}');
--
-- The API's `boundedScopes` never runs on that path. The key is issued, and any
-- component that ever consumes a key by trusting its stored scopes would honour
-- authority the owner's role never had. The issuer cannot be the only thing
-- standing between a client and a forged scope.
--
-- Every write to `api_keys` in this codebase already goes through the API's
-- service-role connection: `createApiKey` and `revokeApiKey` in
-- `packages/database/src/supabase-store.ts`, the same session the worker uses.
-- The client-facing INSERT/UPDATE/DELETE policies were therefore both unused
-- and load-bearing only for an attacker. They are dropped here; reads stay as
-- they are (names and prefix only, never the hash).
--
-- This follows `deployments`, which expresses "the service role writes this
-- table" by simply having no client-facing write policy, and complements
-- `0006_engine_column_guards.sql`, which guards individual engine columns.
-- ---------------------------------------------------------------------------

-- A member may no longer insert a key row for themselves. Issuing a key is an
-- API operation, performed with the service role, so no client INSERT policy is
-- needed. Without one, the default is deny.
drop policy if exists api_keys_insert on api_keys;

-- Same for the owner/admin row update that carried revocation. `apiKeys.revoke`
-- writes `revoked_at` through the service role, so a client UPDATE policy is not
-- needed, and keeping it would re-open scope rewriting after issuance.
drop policy if exists api_keys_update on api_keys;

-- Deleting a key row is also an API operation; the dashboard revokes rather than
-- deletes, and revocation is what the audit trail records.
drop policy if exists api_keys_delete on api_keys;
