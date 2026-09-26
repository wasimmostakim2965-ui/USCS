-- ---------------------------------------------------------------------------
-- 0021 — a deployment remembers the source it was built from
--
-- The gap this closes is P27 in `docs/competitive/vercel-feature-matrix.md`:
-- "rollback with a commit; no redeploy of a past deployment row". Rollback
-- returns to a revision the engine already built, which is a different action
-- from *redeploying* — asking for a fresh build of the same source. Vercel's
-- most-used deployment action is the latter, and it was impossible here for a
-- simple reason: the deployment row did not record where it was built from.
-- `git_branch` and `git_commit` were stored (0011) but not the repository, so a
-- row could not name its own source and a redeploy had nothing to replay.
--
-- Two columns, both *request* attributes, not engine observations:
--
--   * `git_repository` — the clone URL the build was requested with. It is the
--     same value the caller typed on the Deployments page or the link resolved
--     to, recorded so a redeploy replays it rather than asking again.
--   * `build_pack` — the build pack that was requested, so a redeploy does not
--     silently fall back to the engine's default and produce a different
--     artifact than the build it is repeating.
--
-- Neither is guarded. `guard_engine_columns` (0006/0009) exists to stop a client
-- from asserting an *outcome*; a repository and a build pack are the request,
-- exactly like `git_branch` in 0011, and the API is the writer. The outcome
-- columns stay frozen by 0009.
--
-- Honesty note, because it is the difference between this and a false claim: the
-- hosting engine builds a *branch*, not a commit. So a redeploy replays the
-- repository and branch, and the engine builds the branch's current head —
-- identical to a fresh deploy. Pinning an exact earlier revision is what
-- Rollback is for, and the dashboard says so rather than implying a redeploy
-- reproduces a byte-for-byte artifact.
-- ---------------------------------------------------------------------------

alter table deployments
  add column if not exists git_repository text,
  add column if not exists build_pack text;

comment on column deployments.git_repository is
  'The clone URL this deployment was requested with. A request attribute, not an engine observation; it is what a redeploy replays.';
comment on column deployments.build_pack is
  'The build pack requested for this deployment (nixpacks, railpack, static, dockerfile, dockercompose), so a redeploy repeats the same build rather than the engine default.';
