-- ---------------------------------------------------------------------------
-- 0017 — a project's execution model: container or serverless (ADR-0017)
--
-- The architectural pivot: a Cloud Wai project can run on the container engine
-- (Coolify) or on a serverless engine (AWS Lambda and equivalents). The two are
-- different execution machines behind different adapters, so *which one a
-- project uses* is a property of the project that the API routes on.
--
-- `execution_model` is the customer's own choice, so it is a writable column —
-- distinct from `projects.provider` / `provider_resource_id`, which are the
-- engine's answer and are frozen against client writes by the `0006` trigger. A
-- customer picks the model; the engine then reports which specific resource it
-- created, and that is not the customer's to assert.
--
-- `container` is the default, because existing projects were created before the
-- serverless engine existed and must keep behaving exactly as they did: a
-- migration that silently moved a running project onto a different execution
-- model would be the worst possible kind of surprise.
--
-- Why a column and not a UI-only setting: the worker drains a deployment job with
-- no session and must know which adapter to call. If the model lived only in the
-- browser, a queued job would have no honest way to pick its engine.
--
-- Routing rule the API and worker both apply:
--   * `serverless`           -> the serverless engine only. If it is
--                               not configured, the deployment reports
--                               `not_configured`; it is NEVER handed to Coolify,
--                               which would build the wrong execution model and
--                               call it success.
--   * `container` / null     -> the container engine, exactly as before.
-- ---------------------------------------------------------------------------

alter table projects
  add column if not exists execution_model text not null default 'container'
  check (execution_model in ('container', 'serverless'));

-- No new policy is needed: `projects_update` already lets a member with
-- `project:update` change their own project's writable columns, and the `0006`
-- trigger still freezes `provider` / `provider_resource_id`. `execution_model`
-- is deliberately NOT added to the guard's frozen list — it is customer input.

comment on column projects.execution_model is
  'The execution machine this project deploys to: container (Coolify) or serverless (Lambda). Customer-chosen; routes which adapter the API and worker call.';
