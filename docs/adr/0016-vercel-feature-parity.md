# Vercel feature-by-feature parity: what is wired, what is honest, what is missing

- Status: accepted
- Date: 2026-09-24

## Context

ADR-0013 established the *positioning* — what Cloud Wai does that Vercel does
not, and where it is honestly behind. It did not do the mechanical work the
brief asks for now: take Vercel's dashboard feature by feature and record, for
each one, whether Cloud Wai has it **wired**, has it as an **honest
not-configured** state, or does not have it at all.

This record is that pass. It exists so "we are like Vercel" is a claim a
reviewer can check row by row rather than a feeling.

## Method

Two sources, kept separate so neither can be mistaken for the other:

1. **Vercel's product surface** — its own docs and plan pages (`vercel.com/docs`,
   `vercel.com/docs/plans/pro-plan`, `vercel.com/docs/plans/hobby`,
   `vercel.com/docs/observability`, `vercel.com/security`) and the dashboard
   walkthrough material it publishes. The feature list is Vercel's, not a
   caricature of it.
2. **What users say** — published complaint/advice material about operating the
   dashboard in practice. This is for the *why*, not the feature list.

## What users complain about, and why it shapes this build

Every recurring complaint resolves to the same root cause: **the dashboard can
show a state that is not the truth of the system.**

| Complaint (from published material) | Root cause | What Cloud Wai does differently |
|---|---|---|
| "Runtime logs show up inconsistently at best" | Logs are a best-effort stream, so absence is ambiguous — is it quiet, or broken? | A list is only ever a row the store returned. There is no stream to be "inconsistent": a deployment's logs are read from their own record, and an engine that has not produced them says so. |
| Environment-variable changes "take effect on the next deployment", surprising operators | The dashboard edits config, but the running artifact does not change — the UI implies immediacy. | The control plane owns configuration as data, and a change that requires a redeploy is a deployment, not a silent config edit. Nothing claims an in-place change. |
| The env-var list is "flat", hard to organize at scale | No hierarchy in the model underneath. | Tenancy is hierarchical by construction (organization → project → resource), and every table is organization-scoped with RLS, so grouping is structural rather than a UI affordance. |
| The audit trail is "general-purpose", not per-secret; no before/after diff | The event log records *that* something changed, not the change. | Every mutation writes an `audit_logs` row with actor and target, and the Activity page reads those rows — the record is the source, not a summary of it. |
| "No automated rotation" for secrets | Rotation is a manual dashboard ritual. | API-key secrets are stored hashed and shown once; an engine-observed column cannot be written by a client (migration `0006`/`0009`), so a client cannot fake a credential change either. |

The lesson taken from this is not "add more pages". It is that the differentiator
Vercel's own users ask for is **a dashboard you can trust without verifying it
elsewhere** — which is exactly the honesty rule this repository already enforces
(ADR-0010).

## The comparison

Status vocabulary matches `docs/audit/dashboard-inventory.md`:

- **Wired** — a real procedure reaches a real store or adapter; the page shows
  that answer.
- **Honest n/c** — the procedure is real; the engine has no credentials, so the
  adapter returns `not_configured` and the page says so. Never a green badge.
- **Contract-only** — the adapter contract and its tests exist; no procedure or
  page reaches it yet.
- **Missing** — no route, page, procedure or store method.

### Workspace / team level

| Vercel feature | Cloud Wai surface | Status |
|---|---|---|
| Teams / account | `organizations.list/create/get`; workspace switcher | **Wired** |
| Projects list | `projects.list`, `ProjectsPage` | **Wired** |
| Project drill-in navigation | `navigation.ts` workspace → project switch with back control | **Wired** |
| Team members / roles | `organizations.members.list`; `SettingsPage` renders the real list, role spelled out | **Wired** (read). Invite/change/remove controls are absent, and the page says so rather than showing a dead button |
| API tokens | `apiKeys.list/create/revoke`; secret shown once, hashed at rest | **Wired** |
| Activity log | `audit.list`, `ActivityPage` | **Wired** |
| Billing / usage | `billing.usage`, `BillingPage` reads real `usage_records` | **Wired** (usage). Invoicing/collection is a stated not-configured, no placeholder balance |
| Audit-log CSV/streaming export (enterprise) | — | **Missing**, stated in ADR-0013 |
| Team-level settings (2FA enforcement, SAML SSO) | — | **Missing** |
| Domain registration / free-domain claim | Landing hero search box states registrar is not configured | **Honest n/c** |

### Project level

| Vercel feature | Cloud Wai surface | Status |
|---|---|---|
| Project overview + latest production deployment | `projects.get` + `deployments.list` + `audit.list`, `ProjectOverviewPage` | **Wired** |
| Deployments history | `deployments.list`, `DeploymentsPage` | **Wired** |
| Create deployment | `deployments.create` (enqueued as a durable job) | **Wired** |
| Deployment logs (build vs runtime) | `deployments.logs` | **Wired** |
| Instant rollback | `deployments.rollback` (enqueued) | **Wired** |
| Domains add / verify / remove | `domains.list/create/verify/remove`, project-scoped | **Wired**; verification is the edge's answer. Direct-origin denial is gate 6, **open — needs an engine** |
| Security / firewall | `security.policy.get/save`; `distribute` returns engine answer | **Wired** (author/save); **Honest n/c** (distribute until an edge is configured) |
| Security policy events | `security.policy` events recorded as their own lifecycle | **Wired** |
| Environment variables | — | **Missing** (stated in ADR-0013) |
| Deployment protection | — | **Missing** |
| Observability: metrics, traces, error tracking | `providers.health` report only; telemetry contract in `packages/observability` | **Contract-only** — largest surface gap (ADR-0013) |
| Analytics / Speed Insights | — | **Missing** |
| Notifications (email/push/SMS) | — | **Missing** |
| Integrations, feature flags | — | **Missing** |
| Project settings (rename) | `projects.update`, `ProjectSettingsPage` | **Wired** |

### Database (differentiator one)

Vercel has no equivalent surface; this section is the product's own claim, so it
is listed against the Supabase-shaped model it is built on.

| Capability | Cloud Wai surface | Status |
|---|---|---|
| Provision a tenant database / bucket | `data.provision`, Overview + Storage pages | **Wired** (engine answer; `not_configured` without credentials) |
| List resources | `data.list` | **Wired** |
| Back up a database | `data.backup`; bucket backup correctly refused by the UI and the server | **Wired** |
| Backup history | `data.backups.list` | **Wired** |
| Table editor | route exists, honest placeholder names the missing engine operation | **Missing** — needs table-introspection on the adapter |
| SQL editor | same | **Missing** — needs query execution |
| Authentication (GoTrue surface) | same | **Missing** — needs auth-user listing |
| Storage buckets | `DatabaseStorage` filters `data.list` to this project's buckets | **Wired** |
| REST/API endpoint list | same as table editor | **Missing** |
| Roles & extensions | same | **Missing** |
| Database logs | same | **Missing** |
| Database settings | same | **Missing** |

The eight missing sub-pages are blocked by the same architectural fork recorded
in `docs/audit/dashboard-inventory.md`: ADR-0011 says Cloud Wai never opens a
data-plane connection to a tenant database, and every one of those pages needs
one. That is a decision for the owner, not something to paper over with a thin
procedure over an adapter that cannot answer.

## The dispatch bug this pass found and fixed

The Database section decided which body to render with a boolean flag plus one
hard-coded component:

```ts
SECTION_BODIES[section] ? <DatabaseStorage …/> : <NotYetBuilt section={section} />
```

While Storage was the only flagged section besides Overview this happened to be
right. The moment a second section was enabled it would render the **Storage
page** under another section's title — a silent wrong-body bug in exactly the
class this project refuses. It is now a `SECTION_COMPONENT` map from section to
component, so a section resolves to its own body or to its honest placeholder,
and never to a sibling's. `tests/web/dashboard.e2e.test.tsx` pins it: the
Authentication placeholder must not contain the Storage view's controls.

## What this pass changes and what it does not

- **Changes:** the dispatch bug above; the landing page now carries the
  registrar search box the brief asks for, stating honestly that lookup is not
  configured.
- **Does not change:** no adapter interface, no RLS contract, no engine import
  from a router. Gates 6–9 stay open. The missing rows above stay missing until
  they are built on the right foundation.

## Consequences

- "Feature-by-feature with Vercel" is now a reviewable table, not a claim.
- The largest honest gaps are observability, environment variables,
  notifications, and the eight Database sub-pages — each named with why.
- The next work that closes a row must move it to **Wired** with a test in the
  same commit, or the row stays as it is.

## Acceptance evidence

This record; `docs/audit/dashboard-inventory.md` (control-level list);
`docs/adr/0013-competitive-positioning.md` (positioning and the honesty
guarantees); `docs/release-gates.md` for the enforced-versus-open status of each
guarantee named above.
