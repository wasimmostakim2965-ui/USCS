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

The authenticated dashboard uses a Vercel-style `AppShell` with a neutral light surface, dark-theme parity, responsive sidebar, top-bar scope context, avatar menu, and URL-backed section and child routes under `/dashboard/:section/:child`. Project drill-in routes use `/dashboard/projects/:id/:section`. Sidebar active state, breadcrumbs, deep links, browser refresh, and the Ctrl/⌘+K command palette all resolve from the same nested navigation contract in `client/src/pages/dashboard/navigation.ts`.

| Section | Current state |
| --- | --- |
| Overview and Projects | Production deployment card, rollback/visit gating, production checklist, observability/analytics honest states, project scope switcher, search, recents/usage/alerts tabs, and project cards backed by tRPC/Supabase |
| Deployments | Environment controls, protected environment variables, build-log polling, domain binding, rollback history, and adapter-aware status |
| Domains and Data | DNS/domain records, database/storage/backup control records, and provider-safe connection metadata |
| Security | Organization-scoped policy configuration with None/Normal/High/Ultimate cards, preview contract, auto-setup control, enforcement history, edge-event surfaces, and honest adapter status |
| Observability | Append-only events, live polling for logs, metrics/error/alert surfaces, and provider-aware empty states |
| Developer and Billing | Connection-required developer surfaces, repository/webhook metadata, usage/invoice/payment records, and gated checkout |
| Settings | Workspace identity, role-aware team controls, notification preferences, connected-account placeholder, and paginated audit log with filtering and CSV export |

Every resource query and mutation must remain organization-scoped and protected by Supabase RLS. Provider actions return an explicit `not_configured` or equivalent failure state until a real adapter is configured; UI placeholders must not be interpreted as successful infrastructure operations.

The repository is delivered in small, reviewable commits. Each feature commit is required to pass `pnpm build`, `pnpm check`, and `pnpm test` before it is pushed. The current suite includes router contract tests, adapter behavior tests, RLS-oriented foundation checks, and dashboard navigation regression tests. UI surfaces never fabricate infrastructure data: missing adapters render loading, empty, error, `not configured`, or `coming soon` states.

## Project shape

The browser application is under `client/`, the server and tRPC routers are under `server/`, shared types are under `shared/`, and ordered Supabase migrations are under `supabase/migrations/`. Dashboard sections live in their corresponding files under `client/src/pages/dashboard/`; reusable visual primitives live in `client/src/components/ui-kit/`, while `client/src/components/AppShell.tsx` owns only authenticated shell, context navigation, and route dispatch.
