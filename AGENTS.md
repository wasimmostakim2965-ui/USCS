# AGENTS.md — repository rules for Cloud Wai

This is the persistent memory for anyone (human or agent) working in this
repository. Read it before you change anything.

## Branches: `main` is the only branch

**All work goes directly to `main`. Do not create, work on, or push to any other
branch.** There are no feature branches, no phase branches, no PR branches in
this repository. `main` is where the software is built, tested and released.

This rule exists because it was broken once: an agent run invented a
`phase-1-...` branch, pushed work to it, and left `main` behind. That is wasted
work and a confusing repository.

Two git hooks enforce it, so the mistake is not possible by habit or by
assumption:

- `.githooks/pre-push` refuses a push to any ref other than `refs/heads/main`.
- `.githooks/pre-commit` refuses a commit made on any branch other than `main`.

Both can be overridden by a maintainer with `ALLOW_NON_MAIN_PUSH=1` /
`ALLOW_NON_MAIN_COMMIT=1`, which should be exceptional and explained.

### If you already made a branch by mistake

```sh
git checkout main
git merge --ff-only <branch>        # bring the work onto main
git push origin main
git branch -d <branch>
git push origin --delete <branch>   # remove it from GitHub too
```

### Enabling the hooks in a fresh clone

`core.hooksPath` is local git config, so a new clone must opt in:

```sh
git config core.hooksPath .githooks
```

`scripts/setup-hooks.sh` does this. Run it once after cloning. CI does not need
it; it is a local guardrail.

## Workflow

- Work phase by phase; each phase ends with `pnpm verify:all` green.
- Push to `main` after each phase. Do not stop to ask permission for that push.
- Never claim a phase is done while any part of it is unverified. A capability
  that needs a real engine stays honestly `not_configured` until a real engine
  exists.

## Commands

```sh
pnpm install
pnpm verify:all     # build + typecheck + tests + RLS isolation probe
pnpm format         # write prettier formatting
pnpm format:check   # check formatting
```

- `pnpm` 9.x is expected. Docker is needed for `verify:rls`; without it, run
  `pnpm verify` (build + typecheck + tests).
- The database store talks to Supabase over HTTP; tests use in-memory stores and
  never require a live database.
- Engine adapters default to an honest `not_configured` implementation whenever
  credentials are absent. Never wire a fake engine in production code; fakes are
  only for tests and local development, and only when explicitly requested.

## Honesty rules (the reason this codebase exists)

- An adapter must never report `succeeded` for work it did not perform.
- A client can never set a resource's state. States such as deployment status
  and domain verification are written only from an engine's own answer.
- Secrets never reach logs, audit rows or API responses.
- Organization scope is resolved from membership, never from client input.
- Every write path is exercised by a test that goes through the real router and
  a real store, not a mock.
- The browser holds the anon key and can reach PostgREST directly, so anything
  the API enforces in TypeScript must also be enforced in the database. RLS is a
  *row* rule: a blanket `update` policy lets a member set any column. Columns an
  engine owns (`domains.verified`, `data_resources.state`,
  `security_policies.state`, the `provider` pairs) are guarded at the column
  level by `supabase/migrations/0006_engine_column_guards.sql`, on INSERT and
  UPDATE. When you add such a column, add it to that migration and to
  `tests/isolation/rls/12_domain_verification_probe.sql`.

## Navigation model

`apps/web/src/navigation.ts` is the single source the sidebar, the command
palette, the breadcrumb and the page titles read from. Each entry carries a
`parseRoute`-compatible path, so every section is a deep link and a refresh lands
where the user was.

There are three drill-in levels, and `navForRoute` returns exactly one of them.
The sidebar is *replaced*, not appended to, at each level:

- **workspace** — Projects, API keys, Activity, Settings.
- **project** — Overview, Deployments, Domains, Database, Security, Settings.
- **database** — the Database sub-menu (Overview, Table Editor, SQL Editor,
  Authentication, Storage, API, Roles & Extensions, Logs, Settings). Reached from
  the project menu's Database entry. The back control steps up one level: from a
  sub-page to the Database Overview, then from the Overview to the project menu.

A sub-page is a real route: `.../database/tables` is not a query parameter or a
client-side tab, so it can be linked, bookmarked and reloaded on its own. Adding
a sub-section to `DATABASE_SECTIONS` in `routes.ts` without adding a glyph, a
description and a title is a type error, not a blank sidebar item.

The old `.../data` path still resolves, to the Database section that replaced it,
so an existing bookmark does not 404.

## Known gaps (do not paper over these)

- **Data-engine provisioning still runs on the request path.** The deployment,
  backup and policy writers are durable: `deployments.create`/`rollback`,
  `data.backup` and `security.policy.distribute` write their row, enqueue a job
  when a queue is wired (`apps/api/src/bootstrap.ts`), and the worker executes it
  off the request path (`apps/worker/src/{deployment,backup,policy}-job.ts`).
  But `data.provision` still calls its adapter synchronously and records
  `audit_logs` only — it does not enqueue. Provisioning is a fast idempotent
  create, so this is deliberate; if it is ever made durable, enqueue it the same
  way and move its test with it.

## Phase status

ADR-0006 numbers phases 0–8 (superseding the earlier 0–6). See the `feat(phase-N)`
commits for what each delivered; a phase is done when `pnpm verify:all` is green,
not when a commit message says so.

- Phases 0–2 and 4–8: delivered (see `feat(phase-0)`…`feat(phase-8)` commits).
- Phase 3: the adapter contracts, durable queue and worker landed in `5b1e536`.
  The API write paths for deploy, backup and policy landed in `d32b56a` and this
  session's data/security work; the dashboard now drives them. The durable writer
  is now complete for all three: SQL queue `bbe1060`, then the deployment
  (`c9c7b1f` and prior), backup and policy (`ad649ff`) API/worker wiring. A
  deploy, rollback, backup or policy distribution is a durable
  `orchestration_jobs` row executed by the worker, and its outcome lands in
  `audit_logs`.

## Environment and engine wiring (read before touching `buildEngines`)

- `.env.example` is the contract for `engineConfigFromEnv`. The keys are
  `STORAGE_ENDPOINT` / `STORAGE_ACCESS_KEY__<orgId>` / `STORAGE_SECRET_KEY__<orgId>`
  (not `MINIO_*`), `SECURITY_EDGE_URL` + `EDGE_HOSTNAME`, and the optional
  `COOLIFY_ENVIRONMENT_UUID__<orgId>` / `COOLIFY_DESTINATION_UUID__<orgId>`. If you
  add an env read, add it to both the example and `engineConfigFromEnv`.
- **The fakes are refused in production.** `buildEngines({ useFakes: true,
  nodeEnv: "production" })` throws rather than building in-memory engines that
  report success for work no engine performed. Read from `NODE_ENV`. A test that
  wants the fakes runs with `NODE_ENV=test`.
- **A real security edge is injected, never self-built.** `createEnvoySecurityEdge`
  needs resolvers the API owns (a route's host/origin, a policy's level), so
  `buildEngines` cannot construct it. Pass the built adapter as
  `EngineConfig.securityEdge`; absent means the honest `not_configured` edge,
  even when `SECURITY_EDGE_URL` is set.

## Closed gaps

- **`api_keys` scope forgery through PostgREST.** `apiKeys.create` narrows
  requested scopes with `boundedScopes`, but the browser holds the anon key and
  the user's JWT, so a member could previously insert a key row with arbitrary
  `scopes` through PostgREST without the API ever running that narrowing.
  Closed by `0007_api_key_scope_guard.sql`, which drops the client-facing
  INSERT/UPDATE/DELETE policies (every `api_keys` write already ran on the
  service role). `tests/isolation/rls/13_api_key_scope_probe.sql` fails on the
  pre-0007 schema and passes after it. The general rule it follows: a write-time
  rule enforced only in a procedure is not enforced for a client that can reach
  PostgREST directly.
