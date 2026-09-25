# Dashboard inventory — every control, and whether it is real

This is the working list for the dashboard upgrade. It exists so a control is
never "probably fine": each row says what the control is, what it calls, and the
honest state of the thing behind it. A control that is not wired is marked
**coming soon** and renders disabled — it never pretends.

Status vocabulary:

- **Working** — the control calls a real procedure and shows the engine's answer.
- **Not configured** — the control calls a real procedure; the engine is absent,
  so it shows the adapter's `not_configured` and never a success.
- **Coming soon** — no procedure exists. Rendered disabled by `ComingSoon`.
- **Contract-only** — the adapter contract exists and is tested, but no procedure
  or page reaches it yet.
- **Missing** — nothing exists: no route, no page, no procedure.

## Legend of the three axes

A section can be working at one axis and missing at another. The upgrade closes
them in this order: route/page → procedure → adapter call → live engine.

## Workspace level

| Control / section | Where | What it calls | State |
|---|---|---|---|
| Organizations list | `OrganizationsPage` | `organizations.list` | Working |
| Create organization | `OrganizationsPage` | `organizations.create` | Working |
| Workspace switcher | `AppShell` | `organizations.list` (shared) | Working |
| Projects list | `ProjectsPage` | `projects.list` | Working |
| Create project | `ProjectsPage` | `projects.create` | Working |
| Open project (drill-in) | sidebar | route change | Working |
| API keys list | `ApiKeysPage` | `apiKeys.list` | Working |
| Create API key | `ApiKeysPage` | `apiKeys.create` | Working |
| Revoke API key | `ApiKeysPage` | `apiKeys.revoke` | Working |
| Activity list | `ActivityPage` | `audit.list` | Working |
| Organization profile | `SettingsPage` | `organizations.get` | Working |
| Engine status | `SettingsPage` | `providers.health` | Working |
| Release gates panel | `SettingsPage` | static list | Working (deliberately static) |

## Project level

| Control / section | Where | What it calls | State |
|---|---|---|---|
| Overview stats + recent deployments | `ProjectOverviewPage` | `projects.get`, `deployments.list`, `audit.list` | Working |
| Deployments list | `DeploymentsPage` | `deployments.list` | Working |
| New deployment | `DeploymentsPage` | `deployments.create` | Working |
| Deployment logs (build vs runtime) | `DeploymentsPage` | `deployments.logs` | Working |
| Rollback | `DeploymentsPage` | `deployments.rollback` | Working |
| Domains list | `DomainsPage` | `domains.list` (project-scoped) | Working |
| Add domain | `DomainsPage` | `domains.create` | Working |
| Verify domain | `DomainsPage` | `domains.verify` | Working |
| Remove domain | `DomainsPage` | `domains.remove` | Working |
| Rename project | `ProjectSettingsPage` | `projects.update` | Working |
| Security policy read | `SecurityPage` | `security.policy.get` | Working |
| Save policy draft | `SecurityPage` | `security.policy.save` | Working |
| Distribute to edge | `SecurityPage` | `security.policy.distribute` | Not configured |
| Security edge banner | `SecurityPage` | `providers.health` | Working |
| Project engine status | `SettingsPage` | `providers.health` | Working |

## Database section (the first differentiator)

The section has nine sub-pages. Two are real: Overview (resources list,
provision/backup controls) and Storage (a project-scoped bucket view backed by
the same `data.list` rows). The other seven are routes with an honest
placeholder that names the missing engine operation and no controls.

| Sub-page | Body | Controls | State |
|---|---|---|---|
| Overview | resources list | Provision resource, Back up | Working |
| Overview → Connection | text | none (prose only) | Working (prose) |
| Table Editor | honest placeholder | none | **Missing** — needs table introspection |
| SQL Editor | honest placeholder | none | **Missing** — needs query execution |
| Authentication | honest placeholder | none | **Missing** — needs auth-user listing |
| Storage | bucket view from `data.list` | Provision resource, Back up (database only) | Working |
| API | honest placeholder | none | **Missing** — needs schema introspection |
| Roles & Extensions | honest placeholder | none | **Missing** — needs role introspection |
| Logs | honest placeholder | none | **Missing** — needs a log stream |
| Settings | honest placeholder | none | **Missing** — needs engine configuration |

Backend reality for these: `data.list`, `data.provision`, `data.backup`,
`data.backups.list` exist. There is **no** procedure for reading tables, running
SQL, listing auth users, or listing roles/extensions. The `postgres` database
adapter exposes health and provisioning; the deeper Supabase-shaped surface is
**contract-only or missing**, not merely unconfigured.

The dispatch used to be a boolean flag plus one hard-coded component, so any
section flipped to "implemented" rendered the Storage view under another
section's title. It is now a `SECTION_COMPONENT` map (section → component), and
the Authentication placeholder test asserts the Storage view's controls are
absent. See ADR-0016.

## An architectural tension the Database upgrade must resolve first

The brief says the Database section is the first differentiator and must expose
the full Supabase surface (auth, table editor, API, storage). The repository's
own ADR-0011 says something different, and this must be settled before the eight
placeholder sub-pages are filled — otherwise they would be built on the wrong
foundation.

What ADR-0011 decided:

- Tenant databases are provisioned through **Coolify's** database API
  (`/databases/postgresql`, `/backups`), not a Supabase stack. There is no
  `DATABASE_ENGINE_URL`.
- **Cloud Wai never opens a PostgreSQL connection to a tenant database.** It
  holds no tenant data-plane credentials and "has no reason to issue SQL".

What the Database sub-pages imply (Table Editor reads/writes rows; SQL Editor
runs SQL; Authentication lists GoTrue users; Storage lists buckets/objects; API
shows PostgREST endpoints; Roles lists roles/extensions):

- every one of those needs a **data-plane** call into the tenant's own database,
  using tenant-scoped credentials. That is exactly the thing ADR-0011 says Cloud
  Wai does not do.

So the nine sub-pages cannot be honestly implemented by adding a thin procedure
over the current `DatabaseAdapter` (which is only
`provision` / `rotateCredentials` / `backup` / `restore` / `destroy`). Filling
them means one of:

1. **Reverse ADR-0011** and give each tenant a Supabase-shaped data plane whose
   control plane Cloud Wai calls with a tenant-scoped key. This is the only path
   that can deliver the brief's "full Supabase surface", and it needs a new
   adapter contract (`TenantDataPlane`) — which the hard rules currently forbid
   changing without an ADR.
2. **Keep ADR-0011** and make the Database section honest about being a
   Coolify-backed Postgres provisioner with backups, not a Supabase clone. The
   eight sub-pages would then be reduced to what Coolify's API can actually
   answer.

This is a decision for the owner, not something to paper over: the two options
produce different products. The inventory below records both the missing pages
and this fork, so the choice is explicit.

## Gaps found, ordered by severity

Items 1–3 below were open when this inventory was first written and are now
closed; they are kept, struck through, so the record of what was missing is not
quietly erased. Items 4–7 were fixed in the same period. Items 8–9 are later
findings from the same audit line.

1. **No Billing section at all.** ~~`usage_records` ... nothing reads a usage
   row.~~ **Fixed**: `billing.usage` procedure, `BillingPage`, and
   `listUsageRecords` on the store read real organization-scoped rows. Invoicing
   remains an honest not-configured (no payment provider), stated on the page.
2. **No landing page.** ~~`index.html` boots straight into the app.~~ **Fixed**:
   `LandingPage` at the root for a signed-out visitor, with the honesty
   constraints in ADR-0010, and now a registrar search box that states lookup is
   not configured.
3. **Database sub-pages are placeholders.** Partly fixed: Overview and Storage
   are real. **Seven remain missing** (Table Editor, SQL Editor, Authentication,
   API, Roles & Extensions, Logs, Settings), blocked by the ADR-0011 fork above.
4. **Domains are organization-scoped, not project-scoped.** ~~`domains.list` takes
   only `organizationId`~~ **Fixed**: `domains.list` accepts an optional
   `projectId`, the web loader and `DomainsPage` pass project scope, and a
   regression test proves project A does not see project B's hostnames.
5. **Project Settings was the workspace Settings.** ~~`projectNav`'s Settings
   entry routes to `{ name: "settings", organizationId }`~~ **Fixed**:
   `projectSettings` route + `ProjectSettingsPage`, backed by a new
   `projects.update` procedure. Renaming is guarded (`project:update`) and audited.
6. **`projectStatus` was dead.** ~~`AppShell` accepts `projectStatus` ...~~
   **Fixed**: the unused prop and its render branch were removed rather than left
   as a badge that can never appear.
7. **`ComingSoon` in the Database Connection card** ~~is two disabled buttons
   with no procedure behind them~~ **Fixed**: the two dead buttons are gone; the
   card is prose only, and the e2e test asserts no button is invented there.
8. **A Database sub-page could render another sub-page's body.** The dispatch was
   a boolean `implemented` flag plus one hard-coded component, so the first
   section enabled after Storage would render the Storage view under its own
   title. **Fixed**: a `SECTION_COMPONENT` map from section to component, with a
   test that the Authentication placeholder carries none of Storage's controls.
9. **The "brand-new tenant sees zero rows" check covered two tables.**
   `tests/isolation/rls/10_isolation_probe.sql` created the member-of-nobody
   fixture but asserted only organizations and projects. **Fixed**: probe 7 now
   sweeps all eleven tenant tables with a count guard, verified against a real
   PostgreSQL and by mutation.

## What is honest today and must stay honest

- An unconfigured engine is `not_configured`, never a green state.
- Engine-observed columns (`deployments.status`, `domains.verified`,
  `data_resources.state`, `security_policies.state`, `provider`) cannot be
  written by a client — migration `0006` and `0009`.
- The Database section says "not available in this build yet" rather than showing
  an empty table that looks like "no data".

## Build order for the upgrade

Done: Billing (2), Landing page (3), the correctness gaps (4), and the Storage
half of (1). Remaining, in order:

1. **The seven Database sub-pages** — still the differentiator, still blocked on
   the ADR-0011 fork: they need a `TenantDataPlane` adapter contract (table
   introspection, query execution, auth-user listing, role introspection) that
   the hard rules say must not be added without an ADR. Decide the fork first.
2. **Observability** — build the page on engine-owned data (job pickup and
   completion latency, provider health over time, redacted logs) so the numbers
   come from `orchestration_jobs` and the adapters, never a fabricated metric.
   This is the largest surface gap against Vercel (ADR-0013).
3. **Environment variables** — configuration as data, with a change that needs a
   redeploy expressed as a deployment, never a silent in-place edit.
4. **Polish** — the Vercel comparison pass; ADR-0016 is the current output.
