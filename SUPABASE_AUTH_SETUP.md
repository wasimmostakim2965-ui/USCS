# Supabase authentication activation

The application now uses Supabase Auth's browser OAuth flow for the public **Sign in**, **Get started**, and **Create your workspace** actions. All three actions open the same production authentication dialog with **Google**, **GitHub**, and **GitLab** providers. The provider buttons call `supabase.auth.signInWithOAuth()` and use an explicit redirect URL; the app does not exchange OAuth tokens manually.

## Required deployment variables

Set these in the Vercel project environment, not in Git:

| Variable | Scope | Value |
|---|---|---|
| `VITE_SUPABASE_URL` | Browser + build | `https://lqaocykcxwnulirtykqy.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser + build | Supabase publishable/anon key |
| `VITE_SUPABASE_AUTH_REDIRECT_URL` | Browser + build | The exact production URL, for example `https://your-domain.example/` |
| `SUPABASE_URL` | Server | The same Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Server | The same publishable/anon key; never use a service-role key in browser code |
| `DATABASE_URL` | Server | The server-only PostgreSQL connection URI, if the application is migrated to Supabase Postgres |

The repository includes `.env.example` with safe placeholders only. No database password, service-role key, OAuth client secret, or access token belongs in GitHub, React code, `VITE_*` variables, logs, or error messages.

## Database migration

Apply `supabase/migrations/202609210001_initial_tenant_auth.sql` through the Supabase migration workflow before enabling tenant-owned resources. It creates `profiles`, `organizations`, `organization_members`, `projects`, and the append-only `audit_logs` foundation, provisions a personal workspace for a newly created Auth user, and enables RLS policies that scope access through organization membership. The account policy is explicit: an existing Supabase identity signs in, while a new identity is provisioned with a profile and owner workspace.

## Supabase dashboard configuration

In Supabase Authentication, enable Google, GitHub, and GitLab and enter each provider's client credentials in Supabase. Add the exact production redirect URL and the local development URL to the Supabase Auth URL configuration. Each OAuth provider must also allow the Supabase callback URL shown in the provider setup screen. Do not use arbitrary query-string redirects or a wildcard redirect policy.

## Session architecture

The browser client persists and refreshes the Supabase session. Each tRPC request forwards the current access token as an `Authorization: Bearer` header. The server verifies that token with `supabase.auth.getUser()` and treats the Supabase Auth UUID as authoritative. The legacy Manus user table is only a best-effort compatibility mirror; a temporary legacy database outage cannot turn a valid Supabase session into an unauthenticated request. The existing Manus cookie flow remains a backward-compatible fallback while deployments are migrated.

The app deliberately does not put a database password into source code. If a PostgreSQL URI contains reserved characters, construct it using a proper URI encoder or a managed secret configuration screen; do not hand-edit or guess an encoded password.

## Current database boundary

The repository's existing Drizzle schema is a MySQL-oriented application user table used by the legacy Manus runtime. The Supabase OAuth bridge can authenticate a Supabase identity and synchronize a prefixed identity into that existing table, but this does not claim that the entire resource database has already been migrated to Supabase Postgres. The reviewed migration in `supabase/migrations/202609210001_initial_tenant_auth.sql` is the initial Supabase-native tenant boundary; additional resource tables should extend it with organization or project ownership and RLS rather than bypassing it.
