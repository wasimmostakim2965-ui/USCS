# Dashboard UX plan — what the research says, and what we will do about it

This is the research output for the dashboard upgrade. It reads Vercel,
Supabase and Coolify as products — from user reviews, issue threads and docs —
and turns each finding into a decision for Cloud Wai. The point is not to copy a
layout; it is to keep what users actually reward and avoid what they actually
complain about, then go one step further where we can.

Sources are at the bottom. Claims about user sentiment below are drawn from
those sources, not invented.

## What Vercel gets right (keep)

- **A fast path from nothing to a running deployment.** Onboarding shows a list
  of repositories to import, auto-detects the framework, and creates the project
  from that — not a blank form asking the user to describe their app. Reviewers
  call deploying "a breeze" and preview deployments "fantastic".
- **One-click rollback** next to a deployment, and a deployment list that shows
  who, when, branch and status at a glance.
- **An observability view users actually open.** Function-invocation metrics
  were called "incredibly helpful".
- **A sidebar that shortens common paths.** The redesigned navigation is praised
  because "they can get to common things in fewer clicks".

## What Vercel gets wrong (avoid)

- **Logs history is too short.** `vercel logs` shows live logs "for at most 5
  minutes", and issues ask for `--since` / `--last` / `--follow`. A build log a
  user cannot look at after the fact is not an audit trail.
- **No organization-level aggregates.** Teams with many projects ask for an
  instances/invocations dashboard; per-project only does not scale.
- **Analytics considered incomplete**, especially for SPAs.
- **Navigation experiments that move familiar controls** produced threads titled
  "the dashboard — it sucks". Do not A/B the basics.
- **Environment variables are surprising**: `.env` is not read for deployments,
  and editing many vars on mobile has a popup bug.

## What Supabase gets right (keep — this is our Database model)

- **Spreadsheet-like Table Editor** and a **SQL editor with syntax highlighting
  and autocomplete**; both repeatedly praised. A junior dev shipped CRUD in
  three hours on it.
- **A built-in API explorer that generates code snippets** — the fastest way to
  teach the generated API.
- **RLS presented as the access model**, next to the data. Users single it out.
- **Saved queries** and an auth flow that "just works".

## What Supabase gets wrong (avoid)

- **The SQL editor loses an unsaved query when you navigate away** — the single
  most concrete complaint, with users asking for draft auto-save.
- **Features "hard to find in the UI"**, and the auth UI called "too basic".
- **Slow dashboard** on lower tiers (minutes to open the Table Editor).

## What Coolify gets right (keep — this is our hosting engine)

- **Clean UI with a real log viewer**: color-coded log levels and search.
- **One-click recovery**: find a dump, restore in one click.
- **Honest about being a deployment platform**, not an observability one.

## What Coolify gets wrong (avoid)

- **Deeper monitoring, preview deployments, backup and rollback clarity** are
  the named gaps.

## The synthesis: what Cloud Wai should do

The pattern across all three is the same. Users reward a **short, legible path
to a real result** and punish **anything that hides state or makes them re-do
work**. Combined with our honesty rule, the plan is:

1. **Never lose a user's work.** Supabase's worst complaint is a lost SQL draft.
   Any editor we ship (SQL, policy, future env vars) auto-saves or warns before
   discard.
2. **Logs must be historical and searchable, not a live window.** We already
   fetch a full tail from the engine; add filtering and a clear "this is the
   tail the engine returned" note (already there via `source`). Vercel's gap is
   our opening.
3. **Aggregate at the organization level.** Vercel lacks it. Our Billing/Usage
   section is exactly that surface — build it from `usage_records`.
4. **Onboard by importing reality, not by asking.** Our New Deployment form
   should lead with the git repository and branch, the way Vercel's import does.
5. **Every state is legible.** A status is the engine's, shown as
   configured / not configured / unknown — never a grey box the user must
   interpret. This is already our rule; extend it to every new section.
6. **Do not move familiar controls.** Keep the GitLab-style drill-in the owner
   chose; do not adopt Vercel's accordion or A/B the sidebar.

## Section-by-section decisions

| Section | Decision from research | Backend today |
|---|---|---|
| Landing | Public page, then a single "Open dashboard" path. Vercel has no public landing inside the app; ours is a separate route. | Missing — new |
| Overview | Keep stats + recent deployments + activity (Vercel Overview shape). Add org-level roll-up later. | Working |
| Deployments | Keep list + logs + rollback. Add log filtering and keep the build/runtime distinction. | Working |
| Domains | Project-scoped (fix the leak), then DNS-record display like Vercel's Domains. | Working, needs scoping fix |
| Database | Supabase shape: Overview, Table Editor, SQL Editor, Auth, Storage, API, Roles, Logs, Settings. **Blocked on the ADR-0011 decision** (see inventory). | Only Overview |
| Security | Keep the level picker + honest edge banner + policy history. | Working |
| Billing | Build from `usage_records`; org-level aggregate is the Vercel gap we close. | Schema only |
| Settings | Org profile + engine status + release gates. Add project-level settings page. | Working at org level |

## Sources

- Vercel: G2 reviews (g2.com/products/vercel/reviews); r/vercel "Vercel Analytics
  feels incomplete"; Vercel community "Projects Dashboard with Statistics",
  "Feedback on dashboard layout", "UI Bug in the mobile dashboard"; vercel/vercel
  issues #14147 (historical logs) and discussion #5015 (`.env`); Vercel changelog
  "Improved dashboard navigation".
- Supabase: Product Hunt / G2 review summaries (881 reviews; praises dashboard,
  RLS, table editor; complaints include "SQL editor loses your unsaved query",
  features hard to find, slow dashboard); supabase/supabase issue #31276;
  dashboard UI SQL Editor flashing discussion #33377; Supabase changelog.
- Coolify: Product Hunt reviews (clean UI, one-click services, SSL); Hacker News
  thread 33077464 (GUI, GitHub app setup); Trustpilot (4.0/5); temps.sh Coolify
  review 2026 (deployment platform, not observability); Cherry Servers and
  introserv Coolify vs Dokploy (log-level color coding, one-click recovery).
