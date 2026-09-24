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
