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
- **The web tests render built output, not source.** `tests/web/*` import
  `@cloud-wai/web`, which resolves to `apps/web/dist`. A `tsc -b` at the root
  can decide the package is up to date while your edit is unbuilt, and the test
  then asserts against the previous build. After editing anything under
  `apps/web/src`, rebuild before trusting a green run:
  `./node_modules/.bin/tsc -b apps/web --force`, or run `verify` from clean.
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

- **The allow steps do not exempt a request from the WAF's inspection.** Every
  allow step (verified bot, internal, trusted source) emits `pass` and sets a
  marker variable, because Coraza's disruptive `allow` would end inspection for
  the whole transaction — and a request from a verified crawler can still carry
  an attack, so ending inspection on it is the wrong trade. The consequence is
  that an allow step alone does not stop the WAF from denying the request for
  some other reason. Both cases where that would be wrong are now handled
  explicitly: a trusted address is exempt from the deny list (each deny chain
  fails when `cloud_wai_trusted` is set), and so is a confirmed crawler (the same
  chain also fails when `cloud_wai_bot` is set), so "trusted" and "a verified
  crawler" both mean never blocked by a deny rule. What is still not handled is
  the WAF's anomaly rule itself: a confirmed crawler that carries a CRS-matching
  payload is still blocked by the WAF, which is the intended trade (inspection is
  never weakened for anyone).

- **The bot confirmation is a suffix match, and its marker is set by the chain
  member.** Two defects fixed together, and both were silent. The confirm member
  used `@streq` against a DNS *suffix*, but the edge records the *hostname* it
  forward-confirmed (`crawl-…​.googlebot.com`), which never equals
  `googlebot.com` — so the allow could never fire. It now matches with `@rx
  (^|\.)suffix$`, which is a label-boundary suffix match: `evilgooglebot.com` is
  rejected, which a bare `@endsWith` would have accepted. And the `setvar` that
  marks a confirmed bot sat on the chain *starter*; because `setvar` is
  non-disruptive it runs as soon as the starter matches, whether or not the chain
  member does, so anyone sending `User-Agent: Googlebot` would have been marked
  as a confirmed crawler — the exact spoof the chain exists to reject, and (with
  the new deny guard) a bypass. The marker is now on the member.

- **The Envoy fragment carries the trusted addresses and a crawler flag, but the
  edge that consumes them does not exist here.** `EnvoyRouteFragment` now has
  `skipChallengeAddresses` (the validated address literals) and
  `skipChallengeForVerifiedBots` (a flag, deliberately not a User-Agent list).
  The compiler emits both, and the production loader's trusted sources reach the
  fragment — a test pins that end to end. What is *not* done is the edge-side
  application: an Envoy host must read those fields and skip the interstitial
  accordingly. Until it does, turning attack mode on still challenges a
  customer's own webhook sender, because the WAF markers
  (`tx.cloud_wai_trusted`, `tx.cloud_wai_bot`) are set after Envoy has already
  decided. The crawler skip is a flag rather than a UA list because Envoy cannot
  do the forward-confirmed DNS check; handing it a UA pattern would reopen the
  spoof the WAF chain closes.

- **A timed attack window ends at the next policy distribution, not on a timer.**
  The compiled artifact carries `protection: "attack" | "normal"` — a boolean, not
  a timestamp — so the edge cannot end a window by itself. `protectionIsActive`
  is the single expiry rule, and the loader (`packages/database/src/edge-loaders.ts`)
  evaluates it at publish time and passes `normal` once the window has lapsed; a
  test pins that a lapsed window compiles to no challenge and a live one stays in
  force. So a customer's 24h window really ends, but at the next distribution
  rather than at the exact instant. A worker that republishes on expiry would
  close the gap; until then, a policy that is distributed after the window has
  lapsed is what switches the edge back. Do not move the expiry into the compile
  input: it is compiled once and frozen, so a timestamp there would keep
  challenging browsers forever.

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

## Deploying the software

- `docs/runbooks/deploy.md` is the operator runbook for a single host;
  `docs/runbooks/deploy-aws.md` is the AWS form of it, and
  `infra/aws/terraform/` is the environment as code (VPC, private host, ALB +
  ACM, Route 53, SSM config, CloudWatch). Both shapes run the same
  `infra/deployment/docker-compose.yml`, so they cannot drift into two products.
  Read ADR-0015 before changing the AWS shape.
- `infra/deployment/` holds the `api` / `worker` / `web` images and the compose
  file for a single host. The dashboard image serves the bundle and
  reverse-proxies `/rpc` and `/healthz` to the API, so the browser has one origin
  and the API's `CLOUD_WAI_ALLOWED_ORIGINS` stays empty.
- `.env.example` must stay loadable by a dotenv parser. A placeholder written as
  a key (`COOLIFY_TOKEN__<organizationId>=…`) makes `docker compose` refuse the
  file outright; per-organization placeholders belong in comments.
  `tests/deployment/env-template.test.ts` enforces this.
- The API reads `HOST` / `PORT` / `CLOUD_WAI_ALLOWED_ORIGINS` from the
  environment (`allowedOriginsFromEnv`). An allow-list, never `*`: a
  control-plane response is per-user.
- No engine is faked to make a deployment look healthy. Gates 6–9 stay **open**
  until a real engine closes them — do not describe a host as complete while they
  are open.

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

- **A deployment could be born green.** `deployments` has no client-facing
  UPDATE policy, so a client cannot mutate an existing row's status — but the
  `deployments_insert` policy constrained only *who* may insert, not *which
  columns*. A member could INSERT their own deployment with
  `status = 'succeeded'` and a `url`, a green deployment no engine ran. Migration
  `0009_deployment_status_guard.sql` applies 0006's `guard_engine_columns` /
  `_on_insert` to the table: `status`, `url`, `provider`, `provider_resource_id`,
  `deployment_resource_id`, `failure_reason`, `started_at`, `finished_at` are
  frozen on UPDATE, and a client INSERT must be `pending` with no outcome.
  `tests/isolation/rls/15_deployment_status_probe.sql` fails before 0009 and
  passes after. The lesson is the one above: "there is no UPDATE policy" is not
  the same as "the column is protected".

- **A deployment's build log was unaddressable.** `getLogs` took an application
  ref and always hit `/applications/{uuid}/logs`, the running container's tail.
  A failed *build* writes to the engine's deployment queue instead
  (`/deployments/{uuid}`), so a build failure showed no explanation. The engine's
  deployment handle (distinct from the application handle) is now carried through
  `deploymentResourceId` — persisted by the worker and the API's sync path, and
  read back by `deploymentsLogs`, which prefers it and falls back to the
  application tail. The result carries `source` so the drawer can say which log
  it is rather than presenting one as the other.

## The security page's edge banner

- The banner text is derived from `providers.health` (the adapter's report of the
  Envoy edge), not a hardcoded string. It shows `Edge configured.` only when the
  adapter reports the edge `ready`, `Edge not configured.` when it reports not
  configured, and `Edge status unknown.` when the read failed. Do not put a fixed
  sentence back: a hardcoded "not configured yet" survives the edge being wired
  and becomes a lie in the other direction.

## Security incidents (the layer above the edge's decisions)

- `security_events` is one append-only fact per request. `security_incidents`
  (migration `0019`) is the layer above it: a grouped signal with a lifecycle.
  They are deliberately separate tables. Folding them together would mean
  mutating an append-only fact, which is the guarantee `security_events` exists
  to carry.
- Two kinds of column, treated differently. The *observed facts* — `kind`,
  `severity`, `summary`, `opened_at` — are the control plane's own observation:
  the client INSERT grant is dropped and the UPDATE grant is narrowed to the
  lifecycle columns, so a browser cannot fabricate an incident or rewrite the one
  it opened. The *triage* — `state`, `resolution`, `closed_at`, `triaged_by` — is
  an operator's work, admin-only, at the same threshold as a policy change.
- The API and the table's trigger enforce the *same* lifecycle, and they must
  stay identical: triage before any close, a resolution required to close, a
  closed incident cannot be reopened, and `closed_at` is stamped from the server
  clock so a close cannot be backdated. A rule that lives only in the procedure
  is not a rule for a caller that reaches PostgREST directly — the same lesson as
  the API-key and deployment-status guards above.
- The detector opens an incident through the service role, never through a
  procedure: the policy worker (`apps/worker/src/policy-job.ts`) and the
  synchronous `distributeSecurityPolicy` both do it when the edge refuses a
  distribution. That is the honest counterpart of "a policy that the edge
  rejected is not active" — the refusal leaves a case an operator can see and
  close, rather than a log line.
- `tests/isolation/rls/24_incident_probe.sql` is the database-side proof
  (isolation, no client insert, immutable observation, forward-only lifecycle,
  admin-only triage); `tests/isolation/data-security-writes.test.ts` is the
  procedure-side proof; `tests/web/dashboard.e2e.test.tsx` covers the surface.
  `0019` is in `scripts/verify-rls.sh`'s single step list, and
  `security_incidents` is in the `10_isolation_probe.sql` sweep — a new
  tenant-owned table must be added to both, or a leak in it goes unnoticed.

