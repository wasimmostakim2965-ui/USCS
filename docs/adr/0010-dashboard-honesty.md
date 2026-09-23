# Dashboard: URL-driven routes and an honesty-in-the-type view model

- Status: accepted
- Date: 2026-09-22

## Context

The dashboard is the one place a customer sees the control plane's state, so it
is where fabricated success would do the most damage. A green tile over an
engine this deployment has no credentials for is a lie the customer will act on.

The blueprint also constrains the dashboard's reach: it talks to the Cloud Wai
API and nothing else.

## Decision

### Routes are URLs

`parseRoute(path)` and `toPath(route)` are the whole router. A view is derivable
from a link, a refresh lands where the user was, and an unknown path is a
`not_found` rather than a silent fallback to a dashboard the user did not ask
for. The organization id appears in the path for readability, but it is never
what authorizes a request — the server resolves scope from the session whatever
the URL says.

### One API client, and no engine URL in it

`ApiClient.call()` posts `{ procedure, input }` to the API with the session
token. There is no other outbound call in the app, and no database or admin port
is referenced anywhere in the module. A missing session is refused locally rather
than sent as an unauthenticated request.

An HTML error page (a proxy's 502) is not parsed as a valid response; it becomes
a failed call.

### The view model cannot produce data from a bad response

`Section<T>` carries a `title` and a state that is one of `loading | empty |
ready(items) | degraded(reason) | error(message)`. `ready` is the only state
that holds items, and its constructor treats an empty list as `empty` — so a
blank panel says "Nothing here yet" rather than looking like a successful empty
result.

`sectionFrom()` is the single mapping from a response to a section, and it
checks `notConfigured` before `ok`. The server may answer 200 with an explicit
"this deployment cannot do that" marker; that renders as `degraded`, never as an
empty list and never as success.

`presentDeploymentStatus()` gives `not_configured` its own label ("Not
configured") and a neutral tone, deliberately distinct from `failed`. An
unconfigured engine is a deployment fact, not an error the customer caused.

## Consequences

- A component that renders a section cannot render success for a failed load:
  the data simply is not in the state.
- Adding a route means adding a case to `parseRoute`, `toPath` and `loadRoute`;
  the round-trip test catches an omission.
- The engine-status report is the natural next view; the API already exposes it
  through `engineReport()`, and the settings route reserves a section for it.

## Acceptance evidence

- `tests/web/routes.test.ts` — 7 tests: parsing, trailing slashes, encoding,
  unknown paths, and a round-trip over every route.
- `tests/web/view-model.test.ts` — 15 tests: empty vs ready, no data from a
  failed response, `not_configured` as degraded, the client's refusal without a
  session, an HTML error page, and status presentation.
- `tests/isolation/api-procedures.test.ts` — 6 tests over the mounted procedure
  table: every procedure refuses a session-less caller, every scoped procedure
  refuses a non-member.
