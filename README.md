# Cloud Wai

Cloud Wai is a web-based control plane for self-operated hosting, data, security-edge, domains, and observability providers. It is **not** a downloadable `.exe`; a normal browser and an internet connection are required because authentication and control-plane data live in Supabase.

## Prerequisites

Install **Node.js LTS** (Node 20 or newer) and [pnpm](https://pnpm.io/installation). Verify them with:

```bash
node --version
pnpm --version
```

## Create a Supabase project

1. Create a free project at [supabase.com](https://supabase.com).
2. In the Supabase dashboard, open **SQL Editor**.
3. Run every SQL file in `supabase/migrations/` in filename order, from the oldest timestamp to the newest. Do not skip migrations.
4. In **Project Settings → API**, copy the project URL and the publishable key. Keep the service-role key server-only.
5. Enable the sign-in providers you want under **Authentication → Providers**, and add `http://localhost:3000/` to the Supabase Auth URL configuration while developing locally.

## Configure the local environment

Copy the safe example file and edit the values:

```bash
cp .env.example .env
```

Set these values in `.env`:

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

`SUPABASE_SERVICE_ROLE_KEY` is optional for local development and must never be exposed in a `VITE_*` variable or committed to Git. Leave it unset unless a server-only operation explicitly requires it. The hosting, database, and security-edge adapters intentionally remain `not_configured` until real self-operated servers and credentials are supplied.

## Install and run

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), sign in, and open the control plane. The workspace and project control-plane screens will work against Supabase. Hosting, database, and security-edge screens will honestly show empty or **not configured** states until their real provider adapters are available; no infrastructure data is fabricated.

## Verify a fresh clone

Run the complete local sanity check with one command:

```bash
pnpm verify
```

`pnpm verify` runs the production build, TypeScript check, and test suite in sequence. If a fresh clone has no dependencies yet, run `pnpm install` first.

## Control-plane surface and implementation state

The authenticated dashboard renders through a single design system defined in `client/src/styles/dashboard.css`. Its tokens live on the `.ds` wrapper, so the control plane can never leak styles into the marketing site. The type system is the open-source Geist family (self-hosted through `@fontsource-variable/geist`), which keeps the visual language dense, neutral and infrastructure-oriented without copying any vendor's proprietary interface.

The shell (`client/src/components/AppShell.tsx`) owns a grouped, expandable sidebar, a scope-aware breadcrumb bar, an account menu, mobile drawer behaviour and a Ctrl/⌘+K command palette. Sidebar groups, active state, breadcrumbs, deep links, browser refresh and the palette all resolve from one URL-backed contract in `client/src/pages/dashboard/navigation.ts` under `/dashboard/:section/:child` plus project drill-in routes at `/dashboard/projects/:id/:section`.

Every section is backed by a real tRPC procedure and renders four honest states — loading, empty, error and populated — instead of placeholder metrics.

| Section | Current state |
| --- | --- |
| Overview | Production deployment card with rollback/visit gating, checklist, activity/production/checklist tabs, project grid |
| Projects | Search, scope switcher, tabs (all/recents/usage/alerts), create-project mutation, project drill-in routing |
| Deployments | Environment tabs, detail view with build-log polling, deployment protection, environment variables, domain binding, rollback history |
| Domains | Registry list, registrar search, DNS record CRUD, nameserver delegation and DNSSEC toggle, SSL/TLS state |
| Data | Database instance provisioning, storage bucket provisioning, backups with create/restore |
| Security | None/Normal/High/Ultimate posture levels, policy preview, apply-to-edge, firewall/WAF/rate-limit/bot policy documents, edge events |
| Observability | Live polling log/metric/error/request streams, grouped error fingerprints, threshold alert creation |
| Developer | Git connection intent, repository linking, webhook configuration, API key creation and revocation |
| Team | Member invitations, role assignment, role reference |
| Billing | Usage periods, invoices, payment methods and a gated checkout |
| Settings | Workspace identity, account identity, notification preferences, connected accounts, paginated audit log with CSV export |

Every resource query and mutation remains organization-scoped and protected by Supabase RLS. Provider actions return an explicit `not_configured` or equivalent failure state until a real adapter is configured; UI placeholders must not be interpreted as successful infrastructure operations.

The repository is delivered in small, reviewable commits. Each feature commit is required to pass `pnpm build`, `pnpm check`, and `pnpm test` before it is pushed. The current suite includes router contract tests, adapter behavior tests, RLS-oriented foundation checks, and dashboard navigation regression tests. UI surfaces never fabricate infrastructure data: missing adapters render loading, empty, error, `not configured`, or `coming soon` states.

## Project shape

The browser application is under `client/`, the server and tRPC routers are under `server/`, shared types are under `shared/`, and ordered Supabase migrations are under `supabase/migrations/`. Dashboard sections live in their corresponding files under `client/src/pages/dashboard/`; reusable visual primitives live in `client/src/components/ui-kit/`, while `client/src/components/AppShell.tsx` owns only authenticated shell, context navigation, and route dispatch.
