# ADR-0002 — Coolify: version-pinned adapter, not an embedded fork

- Status: accepted
- Date: 2026-09-23
- Deciders: Cloud Wai engineering
- Related: ADR-0001

## Context

Coolify is the deployment/hosting execution engine. Source inspection of
`engines-src/coolify` at commit `7c86e53422ad` (2026-09-23) established:

- **It is a complete application**, not a library: `composer.json` declares
  `"type": "project"`, PHP `^8.4`, Laravel `^12.65.0`, with `artisan`, `app/`,
  Livewire UI, queues and its own database. There is no supported "embed me"
  mode.
- **It has a real HTTP API** with 202 documented endpoints in `openapi.json`
  (OpenAPI 3.1). The surface we care about is concrete and stable enough to wrap,
  and every route below was confirmed in `routes/api.php` rather than assumed:
  - `POST /deploy` — trigger a deployment; answers with a `deployment_uuid`
  - `POST /applications/public` — create a public application. There is **no**
    bare `POST /applications`; creation is build-pack specific
    (`/applications/public`, `/applications/private-github-app`,
    `/applications/private-deploy-key`, `/applications/dockerfile`,
    `/applications/dockerimage`) and requires a project, server, environment and
    git source.
  - `GET /applications`, `/applications/{uuid}`, `/applications/{uuid}/logs`,
    `POST /applications/{uuid}/rollback` (requires `commit`)
  - `GET /deployments`, `/deployments/{uuid}`, `/deployments/applications/{uuid}`,
    `POST /deployments/{uuid}/cancel` — queued work is addressed by
    *deployment* uuid, not application uuid
  - `/projects`, `/projects/{uuid}/environments`, `/projects/{uuid}/environments/{env}`
  - `/databases/postgresql`, `/databases/{uuid}/backups`, `/databases/{uuid}/backups/{id}/executions`
  - `/s3-storages`, `/servers/{uuid}/proxy`, `/servers/{uuid}/cloudflare-tunnel`
- **Response envelope.** `bootstrap/helpers/api.php` `serializeApiResponse()`
  sorts keys and lifts `uuid`, `name`, `description`, `id`, `created_at` and
  `updated_at` to a stable position. `tests/fixtures/coolify-routes.json` pins the
  route table so the adapter cannot drift back to invented paths.
- **Team is the tenant boundary.** `app/Http/Middleware/ApiAbility.php` and
  `app/Http/Middleware/EnsureTokenBelongsToCurrentTeamMember.php` show a Sanctum
  token carrying `team_id`, with abilities `root`, `write`, `write:sensitive`,
  `deploy`, `read:sensitive` restricted to `admin`/`owner` roles. Members are
  read-only.
- **License: Apache-2.0** at the repository root (`composer.json` and `LICENSE`).

## Decision

We **wrap** Coolify through a version-pinned `HostingAdapter`
(`packages/adapters`). We do not fork it, and we do not embed its application.

Specifically:

1. Pin the upstream commit and record it in `LICENSES/engines.json`.
2. Preserve Apache-2.0 LICENSE/NOTICE with the deployed Coolify service.
3. Map Cloud Wai organization → Coolify team, using a **dedicated team per trust
   boundary**, and a dedicated destination/server where practical.
4. Store Coolify UUIDs only as `ProviderRef` values alongside the Cloud Wai
   organization, project and resource ids — never as a tenant boundary.
5. Never let the browser or a generic API handler call a Coolify endpoint.
6. Never pass unvalidated customer input into Docker, SSH, shell or Coolify APIs.

## Why not fork

- Forking makes Coolify the de-facto source of identity and commercial state,
  which the blueprint explicitly forbids.
- It duplicates a dashboard we already own and would need to keep in sync.
- It couples our release cadence to an actively developed upstream and splits
  the security patch trail across two codebases.
- Apache-2.0 makes the fork legal, but legality is not the deciding factor here;
  architectural ownership is.

## Compatibility suite (acceptance criteria)

The adapter must be proven against the pinned commit, not assumed:

- create application → deploy → read logs → rollback → cancel, against a real
  Coolify instance in a review environment;
- deployment and rollback operations are idempotent under replay of the same
  idempotency key;
- provider timeout is recoverable and surfaces as `pending`/`degraded`, never as
  a fabricated success;
- cross-organization isolation: an application, secret, log, backup, destination,
  webhook or API token of organization A is unreachable from organization B;
- deletion is verified (no orphaned provider resource, no leaked secret).

Until a Coolify instance is configured, the adapter reports
`not_configured` — it does not simulate deployments.

## Consequences

- We must translate Coolify's error and status vocabulary into Cloud Wai's
  `EngineStatus` vocabulary.
- We must maintain a pinned-version compatibility test.
- A Coolify outage degrades hosting operations only; control-plane identity,
  billing and audit remain available because they live in Supabase.
