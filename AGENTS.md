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
- In a sandbox where `pnpm` is not on `PATH`, corepack provides it:
  `export PATH="/usr/local/lib/node_modules/corepack/shims:$PATH"` and
  `export COREPACK_ENABLE_DOWNLOAD_PROMPT=0` (the second stops the one-time
  download from blocking on a `[Y/n]` prompt).
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

### Sidebar visibility

The sidebar is part of the layout on a wide screen and an off-canvas drawer on a
narrow one. It is open by default on a wide screen and closed by default below
960px, where the compact bar carries the same items. The top-bar menu button
toggles it; the choice is remembered in `localStorage` under `cloudwai.sidebar`,
and a remembered choice wins over the responsive default. Following a link closes
the drawer only on a narrow screen — on a wide screen the sidebar stays put, so a
second Back press remains reachable.

## Known gaps (do not paper over these)

- **A second deploy for a project does not necessarily build the source its
  row names.** The first deploy creates the project's engine application from
  `gitRepository`/`gitBranch` and stores its handle
  (`setProjectProviderResource`). Every later deploy for that project resolves
  that stored application and asks the engine to rebuild it, and the self-hosted
  runtime rebuilds whatever source the application was created with. So a second
  `deployments.create` that names a *different* repository still builds the
  first repository, while its `deployments` row records the repository it was
  told to use. Seen directly: two deploys of one project, the second naming
  `octocat/Hello-World`, both cloned `vercel/vercel`. The row's
  `gitRepository` is a request, not a promise the engine fulfilled — the honest
  fix is to re-point the engine application at the new source (or make the
  project-forks-engine-source rule explicit and reject a changed source rather
  than silently ignoring it), and until then a project's source is fixed at
  first deploy.

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
  some other reason. All three cases where that would be wrong are now handled
  explicitly: a trusted address is exempt from the deny list (each deny chain
  fails when `cloud_wai_trusted` is set), a confirmed crawler likewise (the same
  chain also fails when `cloud_wai_bot` is set), and the deployment's own probe
  likewise (`cloud_wai_internal`) — so "trusted", "a verified crawler" and "an
  internal request" all mean never blocked by a deny rule. The internal marker
  was the last one added: the step used to emit `pass,nolog` with **no** marker,
  so it was inert — an allow that read correctly in the ladder and did nothing in
  the emitted rules. It is only trustworthy because the edge strips
  `x-cloud-wai-internal` from inbound traffic; that obligation is security-
  critical and is recorded in `docs/runbooks/deploy-aws.md`. What is still not
  handled is the WAF's anomaly rule itself: a confirmed crawler that carries a
  CRS-matching payload is still blocked by the WAF, which is the intended trade
  (inspection is never weakened for anyone).

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

- **Deployment protection is per *project*, compiled onto each *route*.** A
  preview URL is unlisted, not private, so a project can carry a `none` /
  `password` / `ip` posture (`project_deployment_protection`, migration `0030`)
  that the edge enforces *before* the firewall. The compile input is
  `EdgeRoute.protection` rather than a field on the artifact because one artifact
  covers an organization's whole domain set — one project's preview can be gated
  while another stays open, so the posture has to travel with the host. The
  loader caches per project (a project can own several domains), reads the
  password digest on the service role (it is not in the client SELECT grant), and
  a password posture with no digest compiles to `none` rather than a route that
  pretends to be protected. The API and the compiler share one validator
  (`validateProtection`), so an accepted posture is always one the compiler will
  emit. A save reports `applied: false` with the engine's reason when no edge
  actually took it — never a fake success. The Envoy-side application of the
  fragment (reading `protection` and answering basic-auth / allow-list) still
  needs a live host, so it is gate 6.

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

## The build plane we ship

`infra/deployment/builder-server.mjs` implements the HTTP contract the Railpack
adapter speaks, driving the pinned Nixpacks binary. It is bounded (concurrency,
timeout, log volume, retention) and authenticated, and it is one of the two
services given the Docker socket (the other is the self-hosted runtime, below).
Three things are deliberately not done, and none of them is papered over:

- **No registry.** The image is tagged in the local daemon. Promoting an artifact
  to a different host needs a registry push; the artifact carries whatever image
  reference the builder returns, so adding one is a change to the tag, not the
  port.
- **No per-build CPU/memory limit.** `BUILDER_CONCURRENCY` caps how many run; a
  single build is unbounded here. Enforce that on the host (cgroup) or run a
  builder per tenant (`docs/runbooks/build-plane.md`, shape B).
- **One shared builder is a shared trust boundary.** Nixpacks builds run as
  containers with the daemon's reach, so a build for tenant A shares the daemon
  with tenant B. Acceptable for a small trusted set; use builder-per-tenant when
  tenants are not mutually trusted.

Do not describe the build plane as a hard multi-tenant boundary.

- **Nixpacks 1.41 mis-detects a repo whose only directory is `.git`.** The build
  plan generator picks the sole subdirectory as the app root, so `octocat/
  Hello-World` (root files `README` + `.git`) is built as `Using subdirectory
  ".git"` and fails with "unable to generate a build plan". This is nixpacks'
  own heuristic, not a defect in the builder contract, and it is why a
  `.git`-only or directory-less static repo does not build here; a repo with a
  detected language (a `package.json`, `index.html`, etc.) builds normally. A
  real static-site path would need a `--config` or an explicit build plan.
  Verified: `heroku/nodejs-getting-started` builds and serves (HTTP 200 on the
  reported port), `octocat/Hello-World` does not.

## The self-hosted runtime we ship

`infra/deployment/runtime-server.mjs` (+ `runtime.Dockerfile`, ADR-0020) is the
container engine this deployment owns: it clones the git source, drives the build
plane to produce an image, runs that image and reports the real status, url and
logs. It is the piece Coolify otherwise supplies, behind the same
`HostingAdapter` port (`packages/adapters/src/selfhosted.ts`).

- **One port, two engines.** `buildEngines` prefers the runtime when
  `RUNTIME_URL` + `RUNTIME_TOKEN__<orgId>` are set, then Coolify, then the honest
  `not_configured`. Because both share one port, `engineReport` reads the
  adapter's `__engine` marker: a runtime-wired host reports `selfhosted: ready`
  and `coolify: not_configured`, never both. `tests/engines/wiring.test.ts` pins
  this.
- **Opt-in and loopback.** The compose `runtime` service (profile `runtime`)
  mounts the Docker socket in its own image, on `127.0.0.1:8095` only.
  `deploy.sh`'s `ensure_runtime` starts it and wires every organization.
- **Shared runtime is a shared trust boundary.** Every tenant's container runs on
  the same daemon, so this is a process boundary, not a machine boundary. Point
  each tenant at its own runtime for a hard boundary; release gate 8 stays open
  until that is done. Do not describe the runtime as a hard multi-tenant boundary.

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
- **The build engine is reached per organization, like Coolify.** The API/worker
  read `BUILD_ENGINE_URL__<orgId>` + `BUILD_ENGINE_TOKEN__<orgId>`; the builder
  service itself reads `BUILDER_TOKEN` (its single secret) plus
  `BUILDER_PORT`/`BUILDER_HOST` and the bounds `BUILDER_CONCURRENCY`,
  `BUILDER_BUILD_TIMEOUT_MS`, `BUILDER_MAX_LOG_LINES`, `BUILDER_JOB_TTL_MS`
  (`infra/deployment/builder-server.mjs`). With no token the adapter stays
  honestly `not_configured`. The per-organization keys are appended by the
  operator/`deploy.sh`, not written in `.env.example` — the org id breaks the
  dotenv parser, the same reason as `COOLIFY_TOKEN__`. See
  `docs/runbooks/build-plane.md` and gate 15.

## Deploying the software

- `docs/runbooks/deploy.md` is the operator runbook for a single host;
  `docs/runbooks/deploy-aws.md` is the AWS form of it, and
  `infra/aws/terraform/` is the environment as code (VPC, application Auto
  Scaling group, ALB + ACM, Route 53, SSM config, CloudWatch). Both shapes run
  the same `infra/deployment/docker-compose.yml`, so they cannot drift into two
  products. Read ADR-0015 before changing the AWS shape.
- **The AWS application tier scales horizontally, and that is safe because of the
  queue.** A launch template + `aws_autoscaling_group` spans both private subnets
  with `min ≥ 2`; a target-tracking CPU policy resizes it. N instances drain one
  `orchestration_jobs` queue because `claim` is `for update skip locked` with a
  unique `(organization_id, idempotency_key)` (`packages/database/src/sql-queue.ts`)
  — so the worker was already correct for more than one replica. The limit that
  does **not** change: every instance shares one builder and one self-hosted
  runtime, so the tier is capacity, not a hard multi-tenant boundary (gate 8
  stays open). `tests/deployment/aws-scaling.test.ts` pins the group, the ELB
  health check, the base64-encoded launch-template user data and that honesty
  limit. Do not replace the group with a lone instance, and do not describe it as
  isolation.
- `infra/deployment/` holds the `api` / `worker` / `web` images and the compose
  file for a single host. The dashboard image serves the bundle and
  reverse-proxies `/rpc` and `/healthz` to the API, so the browser has one origin
  and the API's `CLOUD_WAI_ALLOWED_ORIGINS` stays empty.
- `infra/deployment/builder-server.mjs` + `builder.Dockerfile` are the build
  plane, and the compose `builder` service (profile `build`) is given the Docker
  socket, loopback-only. `deploy.sh`'s `ensure_builder` starts it and wires every
  organization; the AWS bootstrap starts it by profile when `BUILDER_TOKEN` is
  present. Its bounds are release gate 15
  (`tests/deployment/build-plane.test.ts`); read
  `docs/runbooks/build-plane.md` before changing it.
- `infra/deployment/runtime-server.mjs` + `runtime.Dockerfile` are the
  self-hosted runtime, and the compose `runtime` service (profile `runtime`) is
  the second service given the Docker socket, also loopback-only.
  `deploy.sh`'s `ensure_runtime` starts it and wires every organization. Read
  ADR-0020 before changing it; gate 15 pins the socket to exactly these two
  services.
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

- **A crash mid-deploy could start a second, billed build.** The worker writes a
  deployment's settled outcome *after* the handler returns, so a process that
  died between `engine.deploy` returning (the engine has accepted the build and
  issued its deployment handle) and that write left the row with no handle. A
  reap then saw an ordinary new deploy and started a second build for one
  request. The executor now writes the handle itself, via
  `markDeploymentInFlight`, the moment `deploy` returns — before the state read
  and before the applier — and the resume path treats any handle on a
  non-terminal row as in flight, so the requeue polls that build instead of
  rebuilding. The status written there is the engine's own answer (`running` /
  `pending`), never `succeeded`; the applier still writes the settled state. Note
  what is still *not* done: an interrupted build the engine never settles is only
  ever polled, never force-resolved — `reconcile` remains unused by the worker.

- **An admin could mint an owner on INSERT.** Migration `0020` made rank a
  *ceiling* on `organization_members` UPDATE and DELETE — an admin may not demote
  an owner, nor grant the owner role, and nobody edits their own role. The
  **INSERT** policy from `0002` kept the first-cut shape
  (`with check (role_at_least(organization_id, 'admin') or …)`), which any admin
  satisfies for any row: an admin could `insert … role = 'owner'` and then rule
  the organization they were only appointed to administer. Closed by
  `0026_member_insert_rank.sql`, which restates the INSERT policy with the same
  ceiling as UPDATE: an owner may add anyone, an admin only a non-owner
  (`role <> 'owner'`), and the creator may still claim the first ownership row of
  an organization they created. `tests/isolation/rls/25_member_management_probe.sql`
  probes 9a–9c cover it, and the negative control (that probe run without `0026`)
  reproduces the escalation. The general rule, once more: the API's
  `organizations.members.*` rank check is not enough on its own — a member can
  reach PostgREST with their own JWT, so the rank rule must hold in the database.

- **A hard spend cap must gate *every* trigger that builds, not only the button.**
  `deployments.rollback` asks the engine to build, and the git webhook receiver
  enqueues the same build job, so a cap enforced only on `deployments.create` is
  escapable by rolling back or by pushing. The single check is
  `hardCapRefusal` (`apps/api/src/procedures/billing.ts`); `create` and
  `rollback` throw `budget_exceeded` (402) before a row or job exists, and
  `git-hook.ts` — which has no member to answer and must not report a status the
  provider cannot act on — returns `202 { reason: "budget_exceeded" }` and writes
  a `deployment.cap_refused` audit row. `data.backup` carried the same hole for
  the `backups` metric the worker writes, and calls the helper too. A soft budget
  blocks nothing anywhere. When a new trigger for billable work is added, it must
  call this same helper; the cap is a property of the organization's work, not of
  one procedure.

- **A serverless build's log was unaddressable (the Phase C visible-stage gap).**
  A container engine builds for itself, so a failed build is written to the
  engine's *deployment* log and `deployments.deployment_resource_id` (0009)
  addresses it. A serverless deploy is different: the build runs on a separate
  builder engine (`BuildEngine`, ADR-0018) and only the deploy runs on the
  runtime, so the failure lives in the *builder's* log — and `runBuildStep`'s
  `buildRef` was thrown away, so a failed serverless build was a one-line reason
  with no log to open. Migration `0031` adds `deployments.build_provider_resource_id`
  and `build_provider`; the executor records the builder's handle through
  `markDeploymentBuildHandle` (and `runBuildStep`'s `onBuildStarted` hook) the
  moment the builder accepts the build, before the artifact is polled, so a build
  that fails, hangs, or outlives the process still has its log addressed by the
  row. `deploymentsLogs` prefers that handle and reads the log through the shared
  build engine (source `"build"`). Both columns are engine observations, frozen on
  INSERT and UPDATE by 0031 exactly as `status` is by 0009.
  `tests/integration/serverless-build-log.test.ts` pins the executor half and
  `tests/isolation/deployment-writes.test.ts` the procedure half;
  `tests/isolation/rls/29_deployment_build_handle_probe.sql` is the database-side
  proof that a client cannot name a build it did not run.

## List pagination (append-ordered lists)

`deployments` and `audit_logs` are append-ordered and grow without bound, so
neither is ever read in full. `packages/database/src/index.ts` defines
`ListPageOptions` (`before` cursor + `limit`); the store clamps `limit` to
`MAX_LIST_LIMIT` (200) through `resolveListLimit`, which treats a non-positive or
fractional value as absent, and emits `created_at=lt.<before>&order=created_at.desc`
— a keyset cursor, never an offset. An offset would repeat or skip a row the
moment something is inserted at the head; the cursor cannot.

`deployments.list` / `audit.list` carry `before`/`limit` and take an object input.
`usePagedSection` (`apps/web/src/react/hooks.ts`) accumulates pages: it offers
"Load older" only while a *full* page comes back and ends on the first short one,
because only a short page proves there is nothing older. A reload resets to the
first page so accumulated pages cannot mix two projects' rows.

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



## Publishing a route must carry the policy (not a bare fragment)

- `securityEdge.publishRoute` is called when a domain **verifies**, to put the
  hostname on the edge. It used to compile `compileEdge({ route })` — the route
  alone — so the published fragment said `wafEnabled: false`, carried no WAF rule
  and no deny/allow ladder, and told the edge to serve the host *without
  inspection* exactly when it went live. That silently undid any policy the
  customer had saved. It now loads the organization's policy through the same
  `loadPolicy` loader `applyPolicy` uses and compiles the route as the primary
  fragment. A route-only compile remains only for the honest case where no policy
  exists yet. `tests/engines/security-edge.test.ts` pins both halves.

## Stranded deployments: the sweep a queue reap cannot do (C7 residual)

- A requeued deploy polls its in-flight build (`resumeRunningDeployment`), but
  only while a job for that deployment is being redelivered. A job that reached a
  terminal state while its deployment row stayed `pending`/`running` leaves a row
  the customer reads as still progressing, forever. The queue's `reapExpired`
  reaps *jobs*; it cannot settle the *rows* those jobs left.
- `buildDeploymentReconciler` (`apps/worker/src/deployment-reconcile.ts`) is that
  settlement. It runs on the worker loop (throttled, `sweepIntervalMs`, 60s) and
  reads rows non-terminal past `DEFAULT_STALE_AFTER_MS` (10 min) through
  `listStrandedDeploymentsForService` — the one service-role **cross-tenant** read
  in the store, deliberately so: the sweeper does not know which organizations to
  look in. Each row carries its own `organizationId`, so the write is scoped to
  the row the read returned; a cross-tenant read never becomes a cross-tenant write.
- It asks each row's engine through the *shared router* (`deploymentEngineFor`),
  never an adapter directly, and writes only the engine's answer: a confirmed
  `succeeded` is promoted and billed exactly as the job applier does (a staged
  production build is not promoted); an engine with no record of the build fails
  the row with that reason; a row past `DEFAULT_HARD_CEILING_MS` (1 hour) the
  engine still calls in-flight is failed with a reason naming the ceiling. It
  never writes `succeeded` from a timeout. We do not use the adapter's
  `reconcile` method here: adding it to the `DeploymentEngine` port would change
  an adapter interface. `tests/integration/deployment-reconcile.test.ts` pins
  each branch.

## API keys are real credentials now (the retired "Wired" claim)

- Before this, `apiKeys.list/create/revoke` existed and the docs called API
  tokens **Wired**, but nothing accepted a key: `keyAllows`/`apiKeyMatches` were
  reachable only from a unit test and `last_used_at` was never written. A key you
  created could not be used. That is the honesty bug this closed.
- A bearer token is routed by *shape* in `apps/api/src/context.ts`: the public
  `cw_live_` prefix means a key, and the SHA-256 of the presented secret is
  resolved through `store.findApiKeyByHash` — never sent to the identity
  provider. A JWT never reaches the key lookup.
- A key acts for its owner, and is always the **narrower** authority:
  `effectiveScopes` intersects the issued scopes with the owner's *current*
  membership, so an owner demoted after issuance shrinks their keys. The guard
  (`apps/api/src/guard.ts`) gates both the membership capability *and* the key's
  own organization + scopes; a key aimed at a foreign org is `not_found`, never a
  hint the tenant exists. `org:delete`/`billing:manage` remain out of reach
  because `boundedScopes` never granted them (ADR-0007).
- `packages/auth` owns `ApiKeyAuthority` (structural: id/org/owner/scopes/dates)
  so `@cloud-wai/database` can return a key without depending on `@cloud-wai/auth`
  (the dependency is auth → database, never the reverse). The store methods are
  `findApiKeyByHash`, `markApiKeyUsed` (best-effort, tenant-scoped) and
  `getProfileForService` (email only).
- `tests/isolation/api-key-auth.test.ts` pins authentication, revocation,
  demotion, unknown secret, org confinement, and that the session path is
  unchanged. Do not add a client-facing INSERT/UPDATE policy to `api_keys` to
  make a new key path work — every key write is a service-role operation
  (migration 0007).


## PostgREST tenant-guard filters (verified against a real PostgREST)

The membership re-check every scoped query carries —
`organization_members.user_id=eq.<caller>` — is a *dotted filter*, and PostgREST
refuses a dotted filter unless the embedded resource also appears in `select`
(PGRST108) and the relationship is reachable (PGRST200). Two forms are correct
and must be used per table shape; the pinned PostgREST v14.17 behaves the same as
v16.3, so this is not a version regression:

- Table is `organizations` (the child is a direct FK):
  `select=*,organization_members!inner(user_id)&organization_members.user_id=eq.<caller>`
- Table is anything else (the path runs back through `organizations`):
  `select=*,organizations!inner(organization_members!inner(user_id))&organizations.organization_members.user_id=eq.<caller>`

On the `organization_members` table itself the guard still runs through
`organizations!inner(...)` — the row's own `user_id` is the *target* of the
write, so it cannot double as the caller filter.

The store tests once used in-process stand-ins that *skipped* dotted keys, so the
whole control plane shipped with queries a real PostgREST rejects while the suite
stayed green. `tests/database/tenant-guard-join.test.ts` now models the embed rule
instead: a dotted filter on a resource missing from `select` is rejected exactly
as PostgREST rejects it. Do not reintroduce a fake that ignores dotted keys.

`profiles` is populated by the `on_auth_user_created` trigger on `auth.users`
(migration `0027`), and `organization_members.user_id` has a FK to `profiles.id`
so the `profiles(...)` embed resolves. PostgREST returns a to-one embed as an
**object**, not an array — `toOrganizationMember` accepts both, because reading
only the array made every member email/display name silently null.


## Single-host deploy, verified end to end (2026-09-28)

`./infra/deployment/deploy.sh deploy` was run to completion in this sandbox and
the live system was exercised through a real browser. What that proved, and the
traps worth remembering:

- One command brings up the whole product: the Supabase stack, every migration
  (`0001`–`0029`), the build plane, the API, the worker, the edge and the
  gateway. It ends by probing all three origins and printing `dashboard 200`,
  `api 200`, `gateway 200`.
- Re-verified the same day after the pidfile fix. `status`, `down` and a
  redeploy now agree: the four pidfiles name the four live services, `down`
  stops all four with no leftovers, and a redeploy reuses the path. The bug it
  fixed was real and had been masked by a `status` that trusted `kill -0`:
  a service that had exited into a zombie state (parent reaped, not yet
  collected) still answers `kill -0`, so `status` printed "up" while the origin
  answered `502`. Both checks now read the truth — the wrapper's own pid and
  `/proc/<pid>/stat`.
- The sandbox daemon is root-owned. `docker` as the `openhands` user gets
  `permission denied` on `/var/run/docker.sock` while `sudo docker` works; the
  fix is `sudo chmod 666 /var/run/docker.sock` (or add the user to the `docker`
  group). The deploy script's own "is docker running" check uses the socket, so
  an unreadable socket reads as "the daemon did not come up".
- The browser bundle bakes `VITE_SUPABASE_URL` in at **build** time. A value
  that is only reachable from the host (`http://127.0.0.1:54321` or `:12001`)
  makes the dashboard hang on "Connecting to Cloud Wai…", because the browser
  cannot resolve it. To preview a deployed build, rebuild with the public work
  host, e.g.
  `VITE_SUPABASE_URL=https://work-2-<id>.prod-runtime.all-hands.dev pnpm --filter @cloud-wai/web build:web`,
  then restart the edge. `PUBLIC_SUPABASE_URL`/`VITE_SUPABASE_URL` in Terraform
  exist for exactly this reason — set them to the public origin, not loopback.
- The demo bypass (`DEMO_AUTOLOGIN=1` + `DEMO_EMAIL` + `DEMO_PASSWORD`) is the
  only way to reach the dashboard without a configured OAuth provider. It is
  rate-limited per client (`DEMO_MAX_PER_WINDOW`, default 30/60s); a burst of
  reloads returns `429`, which the client treats as "keep waiting" and the page
  stays on "Connecting". Raise the cap for a demo session, and turn the bypass
  off (`DEMO_AUTOLOGIN=0`) for anything reachable by others.
- Restarting the API or edge by `kill`ing a PID from a pidfile used to fail
  silently with `EADDRINUSE` when the old process was still alive. That was a
  bug in `deploy.sh`, not an operator mistake: `start_process` recorded `$!`
  — the `setsid` *parent*, which exits immediately — so the pidfile named a
  process that was not the service, `status` called a live service "down", and
  a restart could not signal the real one. The script now writes the pid of
  the `setsid` child (which `exec`s the service, so the two are one process),
  and `status` treats a `Z`-state entry in `/proc` as down rather than trusting
  `kill -0` (which succeeds against a zombie). If you ever do restart by hand,
  confirm with `ss -ltnp | grep :8787` and check the new process's log for the
  listen line.
- Verified directly: the built bundle carries the public anon key and **not**
  the service-role key or `CLOUD_WAI_SECRET_ENCRYPTION_KEY`; the API/worker/edge
  logs contain no secret; `.env` and `.deploy/` are gitignored and untracked.
  The Supabase CLI writes the service-role key into its own
  `.deploy/logs/supabase.log` — that is third-party, gitignored and untracked,
  but do not copy `.deploy/` into anything that ships.


## Deploy / test environment gotchas (2026-09-28)

- A fresh stack has no demo user, so the `DEMO_AUTOLOGIN=1` no-login bypass is
  dead until `demo.session` can perform its password grant. `deploy.sh` now
  calls `ensure_demo_tenant` after `start_all`: it creates `DEMO_EMAIL` through
  `auth/v1/admin/users` (or looks the id up if it exists) and inserts a demo
  `organizations` row plus an `owner` `organization_members` row via the db
  container's `psql`. If you wipe the database and redeploy, this is what makes
  the dashboard render instead of sitting on "Connecting to Cloud Wai…".
- `NODE_ENV=production` (which production hosts export) makes Vite externalize
  `node:*` builtins as empty modules under the jsdom test environment, so
  `createServer` from `node:http` is `undefined` and every test that binds a
  real server fails with "createServer is not a function" even though the code
  is unchanged. `vitest.config.ts` pins `process.env.NODE_ENV = "test"` before
  Vite reads it. Test `pnpm verify` with `NODE_ENV=production` set, because that
  is how a real host runs it.
- `scripts/verify-rls.sh` boots a throwaway Postgres on `PORT`. A production
  shell often has `PORT` set for the app (deploy.sh exports it, and PaaS hosts
  set it), which collides on `8787`. Use `CLOUDWAI_RLS_PORT` to pick the probe
  port; `PORT` remains the fallback.
- The connected sandbox `GITHUB_TOKEN` has no push rights on this repo. The
  owner's own token is required to push to `wasimmostakim2965-ui/USCS`; keep it
  out of the remote URL and out of logs (`git push https://user:$TOKEN@...`).

## Domain last mile: publish and withdraw (2026-09-28)

- The hosting adapter sets an app's hostnames with `PUT /apps/:id/domains`. The
  runtime's request dispatcher only read a body for POST/PATCH, so every PUT
  arrived empty and `setDomains` silently *cleared* the hostnames instead of
  publishing them. Any verb that can carry a body is now read.
- `domains.remove` used to withdraw only the firewall (envoy) route. The hosting
  engine was never told, so the router kept answering for a released hostname.
  Removal now re-sets the engine to the project's remaining verified hostnames;
  the runtime turns that whole-set set into an explicit `DELETE` for each host
  the caller dropped. Both outcomes are recorded in the `domain.removed` audit
  event (`routeWithdrawn` for the edge, `hostingRouteWithdrawn` for the engine).
- `tests/engines/selfhosted.test.ts` uses a *mock* runtime that reads the body
  itself, so it never exercised the real dispatcher's body handling. Prefer
  `tests/runtime/router-publishing.test.ts` (real `runtime-server.mjs` + a
  recording router) for anything about the publish/withdraw wire format.


## Landing page and the domain search (2026-09-28)

- `apps/web/src/pages/landing.tsx` renders outside `AppShell`, so it carries its
  own top navigation. Section links call `scrollIntoView` rather than using
  `#anchor`: the app routes on the URL hash, so an anchor would be parsed as a
  route and land on not-found.
- The domain search is a shared component, `apps/web/src/components/domain-search.tsx`,
  and lives in the landing page's Domains section — not the hero. It answers
  about the *query* (hostname shape vs. unconfigured registrar) and never invents
  an availability result. Reuse it anywhere a Domains surface needs a lookup box
  instead of duplicating the markup.


## Deploying a site from a local git server (2026-09-30)

Verified end to end in this sandbox: a real deployment was created through the
dashboard, the build plane cloned the source, Nixpacks built an image, the
runtime started it, the row settled on the engine's own `succeeded` and a live
URL, and the container answered `200` with the app's own body. What that run
proved, and the traps worth remembering:

- **The build plane clones with `--depth 1`.** A *dumb* HTTP git server (the
  `git update-server-info` + `python -m http.server` shape) answers a shallow
  clone with `fatal: dumb http transport does not support shallow capabilities`,
  and the build fails before Nixpacks ever runs — the row reads only `build
  failed`, and the real reason lives in the runtime's own app logs
  (`/data/apps.json` in the `deployment-runtime-1` container), not in the worker
  log. Serve a *smart* git server instead: `git daemon` (git://) or
  `git http-backend` behind an HTTP server. `git daemon` is the fastest to stand
  up, but the API's `optionalRepository` only accepts `http(s)://` and `git@`
  URLs, so an `http://` smart server is the one that goes through the form.
- **The build's `failure_reason` is the adapter's sentence, not the engine's.**
  `runtime-server.mjs` returns `{ error: "build failed" }` for any failed job;
  the job's log lines are the only place the actual cause is written. When a
  deploy fails with no explanation, read the runtime's per-app log, not the
  deployment row.
- **`deployments.create` is idempotent per form-open.** One idempotency key is
  minted when the dialog opens, so pressing Deploy twice — or after a failure —
  replays the same request and does not create a second row. Reopen the dialog
  for a genuinely new attempt.
- **The published URL is loopback-bound.** The runtime publishes each app on
  `127.0.0.1:<port>` and hands the router a loopback upstream; only ports
  `12000`/`12001` are forwarded to the public work host in this sandbox. So a
  deployed app is reachable on the host loopback and *through a verified domain
  routed by the router*, never directly at `work-2-…:<port>`. That is why the
  Deployments doc says reaching the URL from outside needs a domain.
- **Settings' Engine status is the honest ledger.** With the real engines wired,
  `selfhosted`, `MinIO storage`, `Railpack build` and `dns` read Configured;
  `Coolify hosting`, `PostgreSQL`, `Envoy/Coraza` and `AWS Lambda` read Not
  configured. Do not "fix" the Coolify and PostgreSQL rows: the self-hosted
  runtime and the storage engine are the ones this deployment runs, and a tenant
  Postgres stays with its engine by design (ADR-0011), so those rows are correct.

## The landing page rebuild and the no-workspace sidebar (2026-09-28)

- `apps/web/src/pages/landing.tsx` was replaced end to end. It is now a full
  marketing page (sticky nav, hero with a deploy illustration, an engines strip,
  a three-layer platform band, a capabilities bento, the Domains band with the
  shared search, a security band, a comparison, pricing and a columned footer).
  Two things are deliberate and easy to reintroduce by accident: every section
  link still scrolls with `scrollIntoView` (a `#anchor` would be parsed as a
  route), and nothing on the page reports an engine success this deployment did
  not observe — the terminal hero is a labelled *illustration*, and the page has
  no uptime badge or fabricated availability.
- The sidebar was hidden whenever there was no active organization
  (`sidebarVisible = Boolean(activeOrganizationId) && sidebarOpen`). That was not
  a cosmetic condition: at `#/orgs` with no workspace committed — a fresh sign-in
  with no organizations, or the chooser itself — no route's `navForRoute` could
  answer, so the shell dropped the sidebar and the top-bar toggle flipped state
  with nothing on screen. The menu therefore looked dead on the one screen a
  brand-new account sees. The shell now renders the sidebar in every state and
  supplies a one-item fallback nav (Organizations → `#/orgs`) when no workspace
  is selected, so the toggle always has something to show and hide.
  `tests/web/dashboard.e2e.test.tsx` has a regression test for it.

## Adversarial audit findings (2026-09-28)

Full record in `docs/audit/adversarial-audit-2026-09-28.md`. Two are worth
repeating here because they are invariants rather than gaps:

- **The `/rpc` path is service-role, so RLS is *not* the second layer there.**
  `apps/api/src/bootstrap.ts` builds the store with `SUPABASE_SERVICE_ROLE_KEY`,
  which bypasses RLS. Tenant isolation on `/rpc` therefore rests on
  `requireCapability` **and** the `organizations.organization_members.user_id=eq.<caller>`
  embed that every store read carries. That embed is a security invariant: a new
  read method that omits it returns another tenant's rows with no database
  backstop. Do not remove it, and add a test if you add a read method.
- **The internal-request allow needs a stripping edge, and none ships here.**
  The compiled `allow-internal` step matches `x-cloud-wai-internal: 1` and
  exempts the request from every deny rule. The header is client-settable, so the
  allow is only safe where the edge strips it inbound. Neither
  `infra/deployment/nginx.conf` nor `infra/deployment/edge-server.mjs` strips it,
  so on the self-hosted/nginx edge in this repo the allow is inert-to-unsafe.
  Fix belongs in the edge, not the runbook.

## The in-dashboard Docs surface (2026-09-28)

- `apps/web/src/docs/menu-map.ts` builds the whole three-level menu map from
  `workspaceNav` / `projectNav` / `databaseNav` (the same functions the sidebar
  reads) plus `toPath`. It is *generated*, so the Docs page cannot describe a
  menu entry that does not exist; a new sidebar entry appears automatically.
  `tests/web/docs.test.ts` pins the map against the three `*Nav` lists entry for
  entry. Do not hand-write a second menu list here.
- When no project is open, project-level entries are still *described* but
  rendered unreachable (`route: null`, no link) with a `:project` path
  placeholder. `toPath` percent-encodes `:`, so the placeholder is repaired back
  to its literal form; a link that could not resolve is never rendered.
- `DOC_INTRO` and every `DocSection` carry an inline SVG diagram (paths in a
  `0 0 64 40` viewBox), so the bundle ships no binary and no third-party asset.
  New symbols are exported from `apps/web/src/index.ts` for the tests to reach.
- The Docs page has one search box that filters the menu map and the detailed
  sections together, and states the matched count honestly (never a full-slice
  claim); an empty result uses `EmptyState`, not a blank column.
- Honesty is unchanged: a section for a Missing feature says "not built" with
  the reason, and Database/Security are documented as first-class because they
  are the differentiators.

## A settled deploy must reach the dashboard (2026-09-28)

A real deploy of a public Vite repo through the self-hosted runtime surfaced two
defects, both of which read on screen as "not configured" rather than as bugs.

- **The deployment list never re-read a row in flight.** A build settles in the
  worker, off the request path, so the dashboard kept rendering `Deploying` for a
  row the engine had long since answered `succeeded` about. `DeploymentsPage`
  now polls `reload()` every 4s *while — and only while —* some row is
  `pending`/`running`, and stops the moment none is. A list with nothing in
  flight is never re-fetched. If you add another surface that shows a worker's
  outcome, it needs the same in-flight poll; a one-shot read is only correct for
  data that cannot change underneath it.

- **A build log was unaddressable by the deployment handle.** The hosting
  adapter's ref for a deployment build is the engine's *attempt* id
  (`deploymentResourceId`), but the runtime had no attempt-addressed log route:
  `GET /apps/<attemptId>/logs` missed its `state.apps` lookup and answered 404,
  which the logs drawer rendered as "Deployment logs — not configured" for a
  build that had actually run. The app-level `logs` is a *tail*, so by the time a
  customer opened a settled build it held only the running container's output.
  Now each attempt keeps its own buffer (`attemptLogs[attemptId]`, written by
  `log()` alongside the app tail and pruned with the attempt), `GET
  /deployments/:id/logs` serves it, and an attempt id arriving on the
  `/apps/<id>/logs` path serves the same buffer — so a handle recorded by either
  write path resolves. `tests/runtime/attempt-logs.test.ts` starts the real
  server and pins all three cases (attempt route, application path, and a 404 for
  an id that is neither). Read the runtime's route table before adding a handle
  that only the adapter knows how to address.



## Deploying a real web app, end to end (2026-09-29)

Verified this session: full `./infra/deployment/deploy.sh deploy`, then a real
deploy driven through the dashboard, then the deployed container probed.

- **The `gitRepository` field is shared across the whole path.** The control
  plane (`apps/api`/`apps/worker`/`packages/adapters`) sends `gitRepository`; the
  runtime stores and revalidates `app.gitRepository`, passes it as the build
  source's `repository`, and the builder clones `source.repository`. A build that
  reaches the builder is one the runtime already validated with
  `isGitRepository`, so the field names differ only across that one
  runtime→builder hop, by design. Add a new source field to the builder's reader
  and the runtime's validator together.
- **A project pins one source: its first application.** `POST /apps` then
  `deploy` finds-or-creates the runtime app by project id, so a second deploy to
  the same project reuses the first app's repository. Sending a different repo
  URL to the deploy modal does not change what is built — deploy a different
  source as a new project (one project, one application, as Vercel does).
- **A project that builds but never serves is still `succeeded`.** The runtime
  runs the image's own start command. `githubtraining/hellogitworld` builds a
  jar with no main manifest, so its container exits and reads
  `Restarting (1)`; the deployment row is honestly `succeeded` because the build
  genuinely succeeded. Use a repo that serves HTTP
  (`heroku/node-js-getting-started`) to prove a deploy end to end.
- **App ports are loopback-only by design.** `docker run -p
  127.0.0.1:<hostPort>:<appPort>`; `RUNTIME_PUBLIC_HOST` only changes the URL
  *string*, not reachability. The app answers `curl
  http://127.0.0.1:<hostPort>/` → 200 on the host, and becomes publicly
  reachable only once a verified domain publishes a router route. So
  `http://<public-host>:<hostPort>` is refused until the domain last mile is
  done — do not present it as a live public link.

## Vercel builds fail on an unbuilt workspace (2026-09-29)

- **Green locally, red on Vercel, and the reason was not Vercel.** `apps/web`
  imports `@cloud-wai/ui` and `@cloud-wai/contracts`, whose `main`/`exports`
  point at `dist/` and which have **no Vite alias** back to their source.
  `pnpm install` links those packages but does not build them, so `vercel.json`'s
  `buildCommand` — `cd apps/web && vite build` — failed to resolve them in
  Vercel's build container. A local run passed only because the workspace was
  already built. The command now builds both packages first:
  `pnpm --filter @cloud-wai/contracts --filter @cloud-wai/ui build && cd apps/web
  && vite build`. `tests/deployment/vercel-build.test.ts` pins it, along with
  `outputDirectory` matching `vite.config.ts`'s `outDir` and the install keeping
  dev deps (`--prod=false`), because the workspace packages are dev-built here.
- If a Vercel deployment is needed again, `docs/plans/vercel-roadmap.md` is the
  architecture map and `vercel.json` is the only project config in the repo; the
  account-level project settings (root directory, framework) live in Vercel and
  must agree with it.

## A deploy must prove it took the port, not that something answers on it (2026-09-29)

- **The false `ok`.** `start_process` starts a service, then `wait_for_http`
  probes its loopback port. If a *stale* copy already holds the port, the new
  process dies with `EADDRINUSE` while the probe answers from the old one — so
  the deploy printed `ok api on 127.0.0.1:8787` for a process that was already
  dead, and `status` printed `api down / dashboard 200` in the same breath.
  Observed live this session after an earlier deploy ran under `sudo`: the
  root-owned API/worker/edge/gateway (03:42) survived every restart because
  `pkill` cannot signal another user's process.
- **The fix.** `assert_port_owner` (called after each `start_process`) reads the
  real owner of the listening port from `/proc/net/tcp` (`port_holder`, exact
  hex parsing — the host has no `ss`/`lsof`) and requires it to be the pid the
  deploy just recorded (or its child). Otherwise the deploy `die`s naming the
  holder. `status` gained a `ports` block so `up` is never inferred from a probe;
  a holder this user cannot inspect prints as "held by a process this user
  cannot inspect" (its `/proc/<pid>/fd` is unreadable) — a real fact, not "nobody
  is on it". A leftover owned by another user is **not** something the deploy
  clears itself: it names the holder and the operator removes it.
- **Do not add `sudo pkill` to the sweep.** It was tried and it killed the live
  API: `sweep_process`'s pattern (`apps/api/dist/main.js`) matches the *running*
  deployment, `sudo` bypasses the stubbed `pkill` the test injects, and so a
  `pnpm verify` run on the host terminated the real service. It is exactly the
  broad-keyword hazard the sweep was written to avoid, one privilege level up.
  `tests/deployment/deploy-script.test.ts` now refuses a `pkill` that mentions
  `sudo` in either order.
- `tests/deployment/deploy-script.test.ts` pins the call sites and runs the
  extracted `port_holder` for real. **If you start a service by hand, check the
  port owner (`grep -l` on `/proc/*/fd`), not just that the port answers.**

## Registrar-style domain search on the Domains page (2026-09-29)

- `apps/web/src/components/domain-search.tsx` renders a registrar-shaped search
  on the Domains page (and the landing page's Domains section). A bare label
  expands across `.com/.net/.org/.io/.dev`, each marked `Needs a registrar` when
  no registrar is configured; a full hostname yields itself; a non-name yields
  an honest "not a hostname" answer. It answers about the *query* and never
  invents availability or a price. Pass `registrarConfigured` only when a real
  registrar is wired.
- **The `DomainSearch` submit path needs Enter or the submit button — the Search
  label is a static styled div, not the control.** Verified live: typing a bare
  label and pressing Enter expands the five names.

## The recipe book (2026-09-29)

- `docs/recipe-book.md` is the "one place" that joins the scattered sources for
  *how to build a Vercel-class platform*: the open pattern (Nixpacks build plane,
  artifact host, edge, control plane, data plane), what this repository copied
  exactly and what it deliberately did not, the nixpacks failure we hit with its
  exact fix, renting a real server (one VPS / AWS-as-code / split AWS), the
  domain public step (DNS + TLS with Caddy, ACM, or Cloudflare), the business
  logic and money, and how to verify every claim. **Every external claim carries
  a source link; every link in it was HTTP-checked live on 2026-09-29; every
  internal claim names the file, migration or test that proves it.** Two dead
  links found during that check were replaced, not left in.
- It follows the same honesty rule as the rest of the repository: the pieces the
  incumbent treats as a black box (the security edge) are named as ours, the
  pieces that still need a live host are named as open, and a not-built feature
  (card-on-file billing, drafting a registrar purchase) says so with the reason.
- The in-dashboard Docs surface already covers the whole menu (`apps/web/src/docs/content.ts`,
  `menu-map.ts`) and is searchable, so the recipe book is the operator/investor
  companion, not a second copy of the page help. Do not duplicate the menu map
  here; link to it.
- **The sign-in form is honest about providers.** `apps/web/src/session.ts`
  reads the enabled OAuth providers from `auth/v1/settings` before the first
  render (`enabledProvidersFromSettings` / `listEnabledProviders`), and
  `pages/login.tsx` renders a button only for an enabled provider. An unreadable
  or empty list offers no button and says why, instead of showing a control that
  "does nothing" — which is exactly what a disabled provider used to look like.
  Each button carries the provider's own brand mark (filled single-path geometry
  from simple-icons, CC0; the icon set gained a `fill` mode for it).
  `tests/web/login-providers.test.tsx` pins the mapping, the read and the
  no-button cases. The provider *credentials* are still absent
  (`supabase/config.toml`, every `[auth.external.*] enabled = false`), so a real
  deployment must configure them in the identity provider; the UI no longer
  pretends otherwise. The configuration is the proof: `supabase/config.toml`
  declares no `[auth.external.google]`, `[auth.external.github]` or
  `[auth.external.gitlab]` block at all (the only one it declares, `apple`, is
  `enabled = false`), so no OAuth provider is switched on until credentials are
  added.

## The default deployment hostname (the Vercel-style address) (2026-09-30)

- A deployment needs an address before a customer adds a domain. The runtime
  mints `<label>.<RUNTIME_DEFAULT_DOMAIN_SUFFIX>` from the app's own name/id
  (`ensureDefaultHostname`, `defaultLabel`), publishes it to the router with
  `tls: "auto"`, and reports it as the app's `url` — so the dashboard's "Visit
  site" link opens a real name, not `http://<host>:<port>`. The fallback url is
  the loopback port, used only when the suffix is unset.
- **It is derived, never persisted as a separate name.** `defaultHostname` is
  re-computed from `app.name`/`app.id`, so it is stable across a runtime restart
  and identical for a given app. It is *not* part of the customer's `domains`
  set; `routableHosts(app)` = customer domains + the default, so a customer's
  domain is served *alongside* the default and removing it never withdraws the
  default.
- **The suffix is opt-in, because a name that does not resolve is a lie.**
  `RUNTIME_DEFAULT_DOMAIN_SUFFIX` is empty by default; `deploy.sh` writes it only
  when the operator sets `CLOUD_WAI_APP_DOMAIN`, whose wildcard `*.<domain>` must
  already point at the host. The runtime will not advertise a name it has no
  reason to believe resolves. `tests/runtime/default-domain.test.ts` drives the
  real `runtime-server.mjs` against a recording router and pins the mint, the
  alongside-behaviour and the non-withdrawal.
- **Two limits the operator owns.** The app port is plain HTTP, so a default
  hostname carries `RUNTIME_PUBLIC_SCHEME=https` only when the router terminates
  TLS for it (`ROUTER_ACME_EMAIL` set); with no ACME email the router serves its
  self-signed fallback and a browser shows a certificate warning — the app still
  serves, but that is a warning, not a silent success. And the sandbox work-host
  ingress does **not** forward subdomains (a subdomain of a work host answers the
  platform's own `404 page not found`, while the router on `:80/:443` serves it
  correctly when reached by IP), so the mechanism is provable locally with
  `curl -sk --resolve`, but a real default-domain deployment needs DNS that
  routes the wildcard to the router.

