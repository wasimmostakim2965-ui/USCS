# Competitive positioning: what Cloud Wai does that Vercel does not

- Status: accepted
- Date: 2026-09-24

## Context

The product brief asks for a control plane that is not merely *as good as*
Vercel's dashboard but two steps ahead of it, and to be honest about where it
still is behind. A comparison written from memory is worthless: it ages, and it
tends to claim parity by listing features on both sides at the same altitude.
This record instead separates three things that are usually conflated:

1. **The surface** — the pages and controls a customer sees.
2. **The guarantee** — the property the system enforces, which is the part that
   is genuinely hard to copy.
3. **The gap** — what this repository has not built yet, named rather than
   implied.

It also corrects a naming mistake in the brief. **Parcel is not a cloud
platform.** It is a zero-configuration web-application *bundler* — a build tool
in the same category as Vite and esbuild — and it has no dashboard, deployment
product, edge network or tenancy model to compare against. Comparing Cloud Wai
to Parcel is comparing a control plane to a compiler. The only cloud platform in
the brief is Vercel, and the comparison below is against it.

## What Vercel's dashboard is made of

Drawn from Vercel's own documentation, so the comparison is against the real
product rather than a caricature:

- **Projects and deployments** — a project owns deployments; each deployment
  shows a status, the triggering commit, its URL, logs, and supports instant
  rollback and promotion to production.
- **Domains** — add, verify and attach hostnames, with DNS and TLS, plus
  project-level and team-level settings.
- **Settings at two levels** — team settings (2FA enforcement, SAML SSO,
  sensitive environment-variable policy, audit logs, RBAC, activity log) and
  project settings (environment variables, deployment protection, retention,
  ignored build step, runtime configuration).
- **Operate and protect** — a Firewall section (custom rules, rate limiting,
  attack mode, bot protection, IP blocking), Deployment Protection,
  Observability (functions, edge requests, errors, logs, plus Speed Insights and
  Web Analytics), and Audit Logs on the owner role.
- **Roles** — a team is the account that owns projects, members and the bill;
  access is role-based (owner among them), and audit logs are an owner-visible,
  enterprise capability.

Sources: Vercel Academy "Tour the Dashboard", `vercel.com/docs/projects`,
`vercel.com/docs/observability`, `vercel.com/security`.

## Where Cloud Wai is deliberately different

The differentiator is not the page list. It is that Cloud Wai **owns the
execution engines behind adapters** and refuses to report an outcome it did not
observe. Vercel is a closed platform: a customer deploys into Vercel's runtime,
on Vercel's terms. Cloud Wai composes open engines (Coolify for hosting,
PostgreSQL and MinIO for data, Envoy/Coraza for the edge) behind Cloud Wai-owned
adapters, and the control plane keeps the tenant, the policy and the audit trail.

Three guarantees follow from that, and each is enforced by a test in this
repository rather than by a policy statement:

| Guarantee | Why it is hard to copy | Evidence |
|---|---|---|
| No fabricated success | A status is written only from an engine's own answer. `succeeded` cannot be produced by an adapter that did not observe it, and a capability with no engine stays honestly `not_configured`. | `tests/adapters/honesty.test.ts`, `tests/contract/status.test.ts`, ADR-0010 |
| Tenant isolation at two layers | Scope comes from server-side membership, never from the request, and the same rules are enforced again in the database, because the browser can reach PostgREST directly. | `tests/isolation/*`, `tests/isolation/rls/10_isolation_probe.sql` |
| An adapter cannot invent an engine route | The adapter's HTTP calls are checked against the pinned engine's real route table; a path the engine does not expose fails the build. | `tests/engines/coolify.test.ts`, `tests/fixtures/coolify-routes.json`, gate 14 |

None of these is a dashboard feature; each is a property a reviewer can break
and watch the build fail. That is the sense in which the product is ahead: it is
built so that a green tile is always a fact.

## Where Cloud Wai is honestly behind Vercel

Naming these is the point of this record. A capability that is not built is not
claimed.

- **Observability.** Vercel ships function metrics, error tracking, logs, traces
  and analytics as first-class pages. Cloud Wai has a provider-health report and
  a redaction/telemetry *contract* (`packages/observability`) but no live metrics
  view. This is the largest surface gap.
- **Notifications.** Vercel delivers alerts about deployments, domains, account
  changes and usage across dashboard, email, push and SMS. Cloud Wai has none.
- **Edge controls in the dashboard.** Vercel exposes firewall rules, rate
  limiting, bot protection and IP blocking as editable UI. Cloud Wai compiles a
  policy to Coraza/Envoy and refuses hostile input (`packages/security`), but the
  rule editor and the live traffic view are not built, and gates 6–8 stay open
  until a real edge is deployed.
- **Environment variables, integrations and feature flags.** Not present.
- **Analytics and speed insights.** Not present.
- **A durable job writer from the API.** The queue, the worker and the SQL
  contract exist and are tested, but the API write paths still call their
  adapters synchronously on the request path and record only `audit_logs`; they
  do not yet enqueue into `orchestration_jobs`. This is ADR-0006 phase 3's one
  open item, and it is tracked in `AGENTS.md`, not hidden.

## What "two steps ahead" means concretely

Being ahead is a direction, not a claim, so it is broken into increments that
can each be finished and verified:

1. **Close the durable-writer gap** so every deploy, backup and policy command is
   a job with a lease, an attempt count and an honest terminal state. This turns
   the existing queue contract into the production path.
2. **Build the observability page on the engine's own data** — job pickup and
   completion latency, provider health over time, and a redacted log view — so
   the numbers come from `orchestration_jobs` and the adapters, never from a
   fabricated metric.
3. **Surface edge policy and its decisions** in the dashboard, driven by the
   compiled policy version, so a customer can see what was blocked without the
   UI pretending a rule is live before the edge confirms it.
4. **Notifications on state change**, delivered from audit-log transitions so a
   notification is always traceable to the row that caused it.

Each of these inherits the honesty rule: it is done when `pnpm verify:all` is
green and a test proves the property, not when the page renders.

## Consequences

- The comparison lives in version control and is updated in the same commit as
  the work it describes, so it cannot drift into marketing.
- "Two steps ahead" is testable: each increment above names its evidence.
- Parcel is recorded as out of scope, so the same mistake is not repeated.

## Acceptance evidence

This record itself; `docs/release-gates.md` for the enforced-versus-open status
of every guarantee cited above; and `AGENTS.md` for the durable-writer gap.
