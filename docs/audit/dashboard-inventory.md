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

The section has nine sub-pages. Only Overview has a body; the other eight are
routes with an honest placeholder and no controls.

| Sub-page | Body | Controls | State |
|---|---|---|---|
| Overview | resources list | Provision resource, Back up | Working |
| Overview → Connection | text | none (prose only) | **Missing** |
| Table Editor | none | none | **Missing** |
| SQL Editor | none | none | **Missing** |
| Authentication | none | none | **Missing** |
| Storage | none | none | **Missing** |
| API | none | none | **Missing** |
| Roles & Extensions | none | none | **Missing** |
| Logs | none | none | **Missing** |
| Settings | none | none | **Missing** |

Backend reality for these: `data.list`, `data.provision`, `data.backup`,
`data.backups.list` exist. There is **no** procedure for reading tables, running
SQL, listing buckets/objects, reading auth users, or listing roles/extensions.
The `postgres` database adapter exposes health and provisioning; the deeper
Supabase-shaped surface is **contract-only or missing**, not merely unconfigured.

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

1. **No Billing section at all.** `usage_records` (organization-scoped, RLS
   `usage_records_select`) exists in the schema, and the sidebar brief asks for
   Billing, but there is no route, no page, no procedure and no store method.
   Nothing reads a usage row. This is the largest single missing section.
2. **No landing page.** `index.html` boots straight into the app. There is no
   public marketing/landing route, so the "landing page → dashboard" journey the
   brief describes does not exist yet.
3. **Database sub-pages are placeholders.** Eight of nine are honest but empty.
   Filling them needs new adapter surface (tables, SQL, buckets, auth users) and
   new procedures, which is the largest body of work.
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

## What is honest today and must stay honest

- An unconfigured engine is `not_configured`, never a green state.
- Engine-observed columns (`deployments.status`, `domains.verified`,
  `data_resources.state`, `security_policies.state`, `provider`) cannot be
  written by a client — migration `0006` and `0009`.
- The Database section says "not available in this build yet" rather than showing
  an empty table that looks like "no data".

## Build order for the upgrade

1. **Database sub-pages** — the differentiator; needs adapter + procedures.
2. **Billing** — new section; `usage_records` is already there.
3. **Landing page** — public route, then the app.
4. **Correctness gaps** — project-scoped domains, project Settings, dead prop.
5. **Polish** — the Vercel comparison pass.
