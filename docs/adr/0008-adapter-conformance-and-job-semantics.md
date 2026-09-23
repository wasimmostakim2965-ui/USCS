# Adapter conformance, honest states and durable job semantics

- Status: accepted
- Date: 2026-09-22

## Context

Cloud Wai never embeds an execution engine. Every engine — the hosting platform,
PostgreSQL, object storage, the security edge, the domain reseller — sits behind
an adapter interface. That decision is only useful if the adapters behave
predictably: a caller must be able to tell "the engine worked" from "the engine
refused" from "this deployment has no credentials for that engine", without
reading engine-specific payloads.

Two failure modes motivated the rules below, both observed in comparable
control planes:

1. A deployment without engine credentials wired a stub that returned
   `{ ok: true }`. The UI showed green dashboards over resources that did not
   exist.
2. A slow engine call had no deadline, so a hung socket held an API request open
   until the client gave up, and the job was left `running` forever.

## Decision

### 1. Five engine states, two of which are honest refusals

`EngineStatus` is `pending | running | succeeded | failed | degraded |
not_configured`. `not_configured` is a first-class outcome, not an error path.
An adapter for an engine this deployment has no credentials for is constructed
with `hostingNotConfigured(...)` and friends; every one of its operations
returns `not_configured` with a reason naming the missing configuration.

`SUCCEEDED` is reserved for work that actually happened. `statusIsHonest()`
exists so the worker can assert this before persisting a result.

### 2. Every call is bounded and every throw is contained

`withTimeout` races the engine call against a deadline and aborts it;
`guarded` turns a timeout or a thrown SDK error into an `AdapterErr`. An adapter
never lets an engine exception unwind into the API. The timer is always cleared.

### 3. Provider references carry the tenant

A `ProviderRef` records `organizationId` alongside the engine's own identifier.
The tenant boundary is never inferred from an engine's id, which we do not
control.

### 4. Jobs are idempotent, claimable and honestly terminal

The queue's key is `(organization_id, kind, idempotency_key)`; re-enqueuing the
same key returns the original job. A claim is exclusive and leased, and
`reapExpired` returns a lapsed lease to the queue so a crashed worker does not
wedge it.

Terminal states distinguish two kinds of non-success:

- `fail` — transient. Requeues while attempts remain, then `failed`.
- `terminate` — not worth retrying (unconfigured engine, no handler for the job
  kind). Goes straight to `failed`.

In no case does a non-successful job become `succeeded`. Getting this wrong was
a real bug in this phase: an unconfigured engine originally called `complete`,
which would have reported a deployment that never happened as done.

## Consequences

- The UI can render "not configured" honestly instead of inferring it.
- A deployment with no engine credentials is still runnable and testable; the
  fakes make all five states reachable in-process.
- The SQL queue implementation must match `InMemoryJobQueue`: a unique index on
  `(organization_id, kind, idempotency_key)` and `for update skip locked` on
  claim. This is asserted in the worker phase.

## Acceptance evidence

- `tests/adapters/honesty.test.ts` — 15 tests: every unconfigured operation,
  all five states, timeout and error containment, tenant on provider refs.
- `tests/adapters/queue.test.ts` — 8 tests: idempotency, single claim, retry
  budget, lease reaping, terminal failure.
- `tests/integration/worker-processing.test.ts` — 8 tests: end-to-end job
  processing, including the unconfigured path staying non-successful.
