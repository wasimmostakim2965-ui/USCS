# Adversarial audit — Cloud Wai, 2026-09-28

This is an independent, adversarial read of the codebase, not a status report. It
was done after `source-audit-2026-09.md` and `deployment-readiness-2026-09-28.md`,
so it deliberately does not restate their inventory: it goes looking for the
places where the stated invariant and the shipped code could disagree, and it
records only what it found plus the evidence for it.

Vocabulary is the same as `source-audit-2026-09.md`.

## Method

Read from the boundary inward: the HTTP adapter, the session and API-key
resolvers, the scope guard, the store's RLS posture, and then every procedure
path that resolves a resource by a client-supplied id (the cross-tenant read a
tenant boundary actually fails at). The database layer was read for *why* it is
safe, not just that RLS is enabled: the migations were read for the policies and
the guard triggers, and the isolation probes for what they actually assert.

## Findings

### F1 — The API bypasses RLS; tenant isolation on `/rpc` rests on one pattern holding everywhere

**Status: Implemented, with a load-bearing caveat.**

`apps/api/src/bootstrap.ts` builds the control-plane store with the
*service-role* key (`createPostgrestClient({ url, serviceRoleKey })`), and every
store read carries `organizations.organization_members.user_id=eq.<caller>` as an
embedded filter (e.g. `getProject`, `listDomains`, `getDataResource`,
`listDeployments`, `listGitLinks`, `listEnvVars`, `listSecurityIncidents`).
RLS is therefore *not* the second layer on the `/rpc` path, even though the
comments in `packages/database/src/supabase-store.ts` and
`supabase/migrations/0002_rls.sql` read as if it were. The database does not
decide what the service role may see — the service role may see everything.

What actually holds the boundary is two things, both enforced in application
code: `requireCapability` (server-side membership, never the body), and the
per-query membership embed above. The first was verified on every write path; the
second was spot-checked across the store and is present on every read the audit
examined. A single future store method that omits the `organizations!inner(...)`
embed would return another tenant's rows on the `/rpc` path with no database
backstop. That makes the embed a security invariant, not an implementation
detail, and it currently has no dedicated test that would fail if it were
dropped.

Recommendation: add a probe that enumerates the store's read methods and asserts
each one's generated PostgREST filter contains the caller's membership predicate;
that is the cheap way to keep the invariant from silently eroding.

### F2 — The internal-request allow is a client-settable header with no shipped strip

**Status: Contract-only / not enforced in this repo.**

`packages/adapters/src/security-edge.ts` compiles an `allow-internal` step whose
whole premise is the request header `x-cloud-wai-internal: 1`:

```
SecRule REQUEST_HEADERS:x-cloud-wai-internal "@streq 1" \
  "id:…,phase:1,pass,nolog,setvar:tx.cloud_wai_internal=1"
```

`tx.cloud_wai_internal` is then a term of the *negated* chain on every deny rule
(`packages/adapters/src/security-edge.ts:817`), so a request that carries the
header is exempted from the deny list. The header is a plain request header:
anyone can send it. The only thing that makes the allow safe is an obligation the
repository states but does not implement — the edge must strip the header from
every inbound request at the listener that faces the internet.

The obligation is documented (`AGENTS.md`, "Known gaps"; `docs/runbooks/deploy-aws.md`
§"The edge's obligation to the internal-request allow"). It is not implemented in
anything shipped here: `infra/deployment/nginx.conf` does not remove it, the Node
stand-in edge (`infra/deployment/edge-server.mjs`) proxies headers through
untouched, and the Terraform in `infra/aws` contains no header-strip. So on the
self-hosted / nginx edge as it exists in this repository, a client that sends
`x-cloud-wai-internal: 1` is exempt from every compiled deny rule. The runbook
says an edge that does not strip "should be considered to have no internal allow
at all" — which is the honest reading of the current state.

Recommendation: make the strip part of the deployed edge rather than a runbook
instruction. At minimum, have `edge-server.mjs` delete the header before
proxying (one line), and add the `proxy_set_header … ""` / `more_clear_input_headers`
to `nginx.conf`; the runbook correctness argument then has code behind it.

### F3 — The demo autologin seeds an owner and hands out an owner session unauthenticated

**Status: Implemented, opt-in, off by default.**

`infra/deployment/deploy.sh` (`ensure_demo_tenant`) inserts the demo user as
`role = 'owner'` of the demo organization, and `demo.session`
(`apps/api/src/demo-session.ts`) performs a real password grant with the
server-held `DEMO_EMAIL`/`DEMO_PASSWORD` and returns the tokens to any
unauthenticated caller. The rate limit is per-process and in-memory.

The bypass is correctly off unless `DEMO_AUTOLOGIN=1` *and* both credentials are
set, and `.env.example` ships `DEMO_AUTOLOGIN=0`. The residual risk is that the
seeded account is an *owner*, so the bypass grants full tenant authority rather
than a read-only tour. If a production host ever flips the flag, it exposes an
owner session to the internet with only a courtesy rate limit in front of it.

Recommendation: seed the demo membership as `viewer` (or `member`), which is
enough to demonstrate every screen and removes the owner escalation from the
bypass entirely.

### F4 — Topic-adjacent, lower severity

* **No abuse brake on `/rpc` authentication.** `demo.session` is rate-limited;
  the bearer-token path is not. Brute-forcing an API key is bounded by 256 bits
  of entropy, so this is low, but there is no global limiter.
* **Deployment-protection password is a single unsalted SHA-256**
  (`apps/api/src/procedures/security.ts`, `passwordDigest`). For an HTTP-basic
  gate on an unlisted preview URL this is a reasonable trade, but it is
  GPU-crackable; a cost-parameterised KDF would be stronger.

## What held up

Read adversarially and found correct:

* **Session resolution fails closed.** `createSupabaseSessionVerifier` asks the
  provider (`GET /auth/v1/user`) rather than decoding the JWT locally, times out
  at 5s, and returns `null` on any non-2xx, empty body or transport error, which
  becomes `unauthenticated`.
* **Two credential paths, narrower wins.** A request is a session or an API key,
  decided by the public `cw_live_` prefix. A key's authority is
  `effectiveScopes` = issued scopes ∩ the owner's *live* membership, so a key
  minted before a demotion cannot keep the old authority; a key aimed at another
  organization is `not_found`, identical to a non-member, so a key cannot learn
  that another tenant exists.
* **The guard is the only door and never reads the body.**
  `requireCapability` resolves the role from server-side memberships and gives
  `not_found` (not `forbidden`) to non-members, so there is no tenant
  enumeration. Verified that every write procedure calls it before doing work,
  and that resource lookups (`getProject`, `getDomain`, …) are caller-scoped so a
  guessed id is `not_found`.
* **Engine-owned columns cannot be self-certified through PostgREST.**
  `0006_engine_column_guards.sql` freezes `domains.verified`/`verification_token`/
  `hostname`, `data_resources.state`/`provider*`, `security_policies.state` and
  `projects.provider*` against any non-`service_role` session, on UPDATE *and*
  INSERT (the INSERT guard was the fix for the bypass the UPDATE-only guard left).
  This closes the direct-`PostgREST` path that F1 would otherwise leave open for
  the engine-fact columns.
* **API-key material is unreachable from a client.** The table-level SELECT is
  revoked and only non-secret columns re-granted, so `select *` cannot return
  `key_hash`; `0007` dropped the client INSERT/UPDATE/DELETE policies outright;
  `publicApiKey` strips the hash on the API path; the store's own read selects an
  explicit column list without it.
* **Secrets are encrypted, versioned and fail closed.** AES-256-GCM with a
  random IV per value, `v1:` prefix, key length validated (a wrong-length key is
  "unconfigured", never padded); an unset
  `CLOUD_WAI_SECRET_ENCRYPTION_KEY` yields `not_configured`, never a plaintext
  fallback. Webhook HMACs and shared tokens are compared with `timingSafeEqual`
  over the *raw* body, and the ciphertext is excluded from the client SELECT
  grant on `project_git_links`.
* **The durable queue is DB-enforced.** Idempotent enqueue is an
  `on_conflict` on `(organization_id, kind, idempotency_key)`; claim/reap are
  `security definer` RPCs granted to `service_role` only; nothing in the queue
  can write `succeeded` for a job the worker did not finish. Worker handlers
  re-read every resource through an org-scoped `*ForService` lookup rather than
  trusting a handle from the payload.
* **The runtime turns tenants into containers without turning them into
  arguments.** Image refs, git repos, git refs and env keys are each validated
  against option-injection (`isOptionLike`), and app ports are bound to
  `127.0.0.1` unless the operator sets a public host.
* **No committed secrets, no XSS sinks, no TODO/FIXME in source.** `.env` is
  ignored; `git grep` finds no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or
  `new Function` in the web/UI packages.
* **The security matrix is proven, not asserted.** 235 `raise exception`
  assertions across 20 probes in `tests/isolation/rls/`, run by `pnpm verify:rls`
  and by the `rls` CI job against a real PostgreSQL. (The suite could not be
  executed in this sandbox — no Docker daemon and no local PostgreSQL — so this
  audit read the probes and the migrations rather than running them.)