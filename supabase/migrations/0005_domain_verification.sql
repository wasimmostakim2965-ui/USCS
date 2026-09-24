-- ---------------------------------------------------------------------------
-- 0005 — domain verification state
--
-- Found while implementing the domain write path (add / verify / remove).
--
-- `domains.verified` says whether the edge has confirmed the hostname, but not
-- *how* a deployment confirms it, and not when it last did. Two facts were
-- missing:
--
--   * verification_token — the per-domain challenge a customer publishes as a
--     TXT record at `_cloud-wai-challenge.<hostname>`. Without it stored, a
--     verify request has nothing to compare against and the only way to confirm
--     would be to trust the client, which is exactly what this schema refuses.
--   * verified_at — when the edge last confirmed it, so the dashboard can show
--     "verified on <date>" rather than a bare boolean, and so a stale
--     confirmation is visible.
--
-- The token is not a credential: it is a value the customer is required to
-- publish publicly. Storing it in clear and returning it to the owning
-- organization is therefore correct, unlike an API key secret.
-- ---------------------------------------------------------------------------

alter table domains
  add column if not exists verification_token text,
  add column if not exists verified_at        timestamptz;

comment on column domains.verification_token is
  'Per-domain DNS challenge value, published by the customer at _cloud-wai-challenge.<hostname>.';
comment on column domains.verified_at is
  'When the edge last confirmed the hostname. NULL means never confirmed.';
