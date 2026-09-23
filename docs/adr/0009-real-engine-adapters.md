# Real engine adapters: per-tenant credentials and one wiring point

- Status: accepted
- Date: 2026-09-22

## Context

Phases 2 and 3 built the tenant boundary in the database and the honest-state
rules in the adapter layer. This phase replaces three of the stubs with real
engines, starting with Coolify, which ADR-0002 already committed us to wrapping
rather than forking.

Two questions had to be answered before any HTTP call was written:

1. How does an adapter get credentials?
2. Where does a deployment decide which engines are real?

## Decision

### Per-organization credentials, resolved on every call

A Coolify team is the tenant boundary inside Coolify. Cloud Wai therefore issues
one Sanctum token per organization and resolves it per call:

```ts
createCoolifyHosting({
  credentials: (organizationId) => tokens[organizationId] ?? null,
});
```

When the resolver returns `null`, the adapter returns `not_configured` for that
organization. It does not fall back to a shared token. The isolation property
follows directly: organization B holds a different token, so A's application is
not filtered out of a shared list — Coolify answers 404 because B's team cannot
see it. `tests/engines/coolify.test.ts` asserts exactly this against a stub
server.

A `ProviderRef` carries the organization alongside Coolify's UUID. The UUID is
never treated as a tenant boundary.

### One wiring point, and no fakes in production

`buildEngines(config)` in `packages/adapters` is the only place the decision is
made. The rule is blunt: incomplete configuration means the `notConfigured`
implementation, never a fake. `useFakes` exists for tests and local development
and must be set deliberately.

The not-configured adapters carry a `__notConfigured` brand, so `engineReport()`
can state which engines this deployment can act on without probing them.

### HTTP is contained

`packages/adapters/src/http.ts` is the only module that calls `fetch`. It
enforces the deadline, strips query strings from log lines (they can carry
tokens), and classifies a response:

- 2xx → `succeeded`
- 4xx → `failed` (the request was wrong or the resource is absent)
- 5xx, 429 → `degraded` (the engine is unwell; it may recover)
- connection error → `degraded`
- timeout → `failed`

A `404` on reconcile is special-cased to `not_configured`, because "Coolify does
not have this application" is not a failure of a deployment — it is an absent
resource, and the UI must say so.

## Consequences

- Adding the next engine means writing one adapter and one entry in
  `buildEngines`; no other module changes.
- The API and UI can render a truthful "not configured" per engine.
- The stub-server suite is the compatibility test ADR-0002 asked for. It runs in
  normal CI with no Coolify instance. A separate, opt-in suite against a real
  pinned Coolify remains the pre-release gate.

## Acceptance evidence

- `tests/engines/coolify.test.ts` — 25 tests against a local HTTP server that
  speaks the pinned upstream shape (no fetch mock): create via
  `/applications/public` with the exact required body, deploy returning a
  `deployment_uuid` and reporting `running` (not `succeeded`), read back by
  application and by deployment, cancel by *deployment* uuid, rollback with the
  required `commit`, logs with a null cursor, delete, auth header, cross-tenant
  404, unreachable → `degraded`, hang → bounded, the status mapping including an
  unknown upstream value not becoming success, and a route-conformance check that
  every path the adapter calls exists in
  `tests/fixtures/coolify-routes.json` (extracted from the pinned commit).
- `tests/engines/wiring.test.ts` — 8 tests: no token means `not_configured`,
  per-organization tokens and infrastructure UUIDs are independent, fakes are
  opt-in.
