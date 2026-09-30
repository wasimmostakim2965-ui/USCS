# Vercel navigation parity — the menu, every page, and what each one does

This is the design record for making Cloud Wai's dashboard navigation match
Vercel's 2026 dashboard, so a developer who knows Vercel can operate Cloud Wai
without reading a manual. It is written against Vercel's *actual* current
navigation — the February 2026 redesign that turned the old horizontal project
tabs into one resizable sidebar with consistent team/project levels — not
against a remembered older layout.

It also settles the one place we deliberately go past Vercel: **Database** and
**Security** are first-class, because they are our differentiators (a hosted
Postgres surface Vercel does not have, and an edge-security surface that is a
sibling of Vercel's Firewall but with an honest engine boundary).

## Sources (read this pass, kept separate)

- `vercel.com/changelog/dashboard-navigation-redesign-rollout` — the redesign is
  the default as of 2026-02-26: a resizable sidebar (tabs moved into it), one
  consistent set of tabs across team and project levels, items reordered by
  common workflow, "projects as filters", and a mobile floating bottom bar.
- `vercel.com/changelog/new-dashboard-navigation-available` — the opt-in beta
  that describes the same shape.
- A complete, screen-by-screen walkthrough of the left menu, including the page
  purpose and screenshot for each item (note.com/kawano_hiroki, 2026) — used for
  *what each page does and where a click lands*, never copied.

No Vercel account data, screenshot, string or asset is copied into this
repository. The images below are links to Vercel's own CDN so a reader can see
the reference in place; they are not vendored.

## The Vercel menu, item by item, with what each page does

Vercel's sidebar is the same list at team level and at project level; the
"projects as filters" control switches between the two versions of the page in
one click. Read top to bottom, this is the 2026 list:

| # | Menu item | Page purpose | Clicking it | Reference screenshot |
|---|---|---|---|---|
| 1 | Overview | Project's top page: production status, latest deployment, domains, connected Git repo, and a "Production Checklist" of go-live steps (connect Git, add a domain, enable analytics). | Opens the project summary (or the team summary at team level). | [Overview](https://assets.st-note.com/img/1776852729-7anvh0OQbx39YetP51wLzAWH.png?width=1200) |
| 2 | Deployments | Full deployment history: when, who, which branch, which status (success/failure/building). The recovery surface — find the bad deploy, then Instant Rollback. | Chronological list; each row drills into that deployment's detail and logs. | [Deployments](https://assets.st-note.com/img/1776853373-MeTHQVNoA19YJpirz0EIylwk.png?width=1200) |
| 3 | Logs | Real-time build/runtime logs of the deployment, including errors and function executions. The debugging surface. | Live log stream, filterable. | [Logs](https://assets.st-note.com/img/1776853535-isjqmIYtU2dBrGTLZynA7eQV.png?width=1200) |
| 4 | Analytics | Privacy-first, cookie-less traffic: page views, most-viewed pages, countries. | Traffic charts. | [Analytics](https://assets.st-note.com/img/1776853656-iwxpuGQWIdh9BbUNAflam0Sg.png?width=1200) |
| 5 | Speed Insights | Real-user Core Web Vitals (LCP, FID/INP, CLS) — the perceived-speed surface that also affects SEO. | Vitals charts per route. | [Speed Insights](https://assets.st-note.com/img/1776853750-DXFMEwpSOl6hR2QI0Zmr79i5.png?width=1200) |
| 6 | Observability | One level above Logs: traces, metrics, execution paths and durations. Has its own sub-tabs (logs/traces/metrics). | Trace/metric views. | [Observability](https://assets.st-note.com/img/1776854763-ZKJeRB3MpD68a5AFUIfSdzmw.png?width=1200) |
| 7 | Firewall | WAF and DDoS controls: block IPs, restrict regions, attack mode. Security posture of the running app. | Rule editor + posture. | [Firewall](https://assets.st-note.com/img/1776855187-QbG1UgTkiJ5Z4XKFWVrsjH6M.png?width=1200) |
| 8 | CDN | Global content delivery: cache status, purge a specific path, edge network settings. | Cache controls + sub-menu. | [CDN](https://assets.st-note.com/img/1776855335-RGQN8IaAkxBHfh1U2VzJT5Zy.png?width=1200) |
| 9 | Domains | Attach a custom domain, see DNS guidance, get automatic HTTPS on attach. | Domain list + add/verify. | [Domains](https://assets.st-note.com/img/1776856608-K3vJsbTUraRhmtoPOQYwklfe.png?width=1200) |
| 10 | Integrations | One-click links to external services (Supabase, PlanetScale, Sentry, Datadog, Slack). | Integration catalogue. | [Integrations](https://assets.st-note.com/img/1776856735-Xr3T9h6QiuOZHEFSlLvDWYtJ.png?width=1200) |
| 11 | Storage | Manage KV, Postgres, Blob and Edge cache — the data surfaces. | Storage resource list. | [Storage](https://assets.st-note.com/img/1776856921-9iA8zN0TE4Ys1fmenGLkDPW2.png?width=1200) |
| 12 | Flags | Feature flags: rollout percentages, per-user targeting, A/B tests without redeploying. | Flag list + targeting. | [Flags](https://assets.st-note.com/img/1776857020-vLlxaq206nFKbTNXu9PIf3WJ.png?width=1200) |
| 13 | Agent | An AI agent that analyses the repo, suggests improvements and diagnoses deploy errors. | Chat/diagnosis. | [Agent](https://assets.st-note.com/img/1776858662-Jw5bnA93GBurZIFWfjNV0xdU.png?width=1200) |
| 14 | AI Gateway | One place to route/model AI API calls, with caching, cost/usage monitoring and rate limits. | Gateway config + usage. | [AI Gateway](https://assets.st-note.com/img/1776858800-votLA208XwJzIqpkFSO5eBu1.png?width=1200) |
| 15 | Sandboxes | Isolated, disposable environments to test code without touching production. | Sandbox list. | [Sandboxes](https://assets.st-note.com/img/1776858965-JNpRb9u0zPXQmZ5812SkWjrx.png?width=1200) |
| 16 | Workflows | Pre/post-deploy automation: run tests before deploy, gate a deploy on conditions. | Workflow definitions. | [Workflows](https://assets.st-note.com/img/1776859022-Gc2ad6qEoxP1DfTIyX8ntgWM.png?width=1200) |
| 17 | Usage | Resource consumption for the billing period: bandwidth, function executions/duration, build minutes, storage. The basis for deciding to upgrade. | Usage breakdown. | [Usage](https://assets.st-note.com/img/1776859166-iHWvTwdzsIOQlVpuJaCceLS0.png?width=1200) |
| 18 | Support | Contact support; response type depends on plan. | Support form. | [Support](https://assets.st-note.com/img/1776859327-jZaEAo6eYrlBwLF7iIfWRc9D.png?width=1200) |
| 19 | Settings | All project configuration, with sub-menus: General, Environments (domains shortcut), Environment Variables, Git, Functions (region/timeout), Security. | Settings sub-nav. | [Settings](https://assets.st-note.com/img/1776859446-xXy8ZkG9gSvmfaiLTEJDCnj5.png?width=1200) |

Vercel's own summary is that a beginner needs only **Overview, Deployments and
Logs** to cover most daily work; the rest are learned as needed. Our ordering
follows the same "most common workflow first" rule, so those three are the first
three in the project menu.

## How Cloud Wai maps onto that menu

Status vocabulary is the same as `docs/audit/source-audit-2026-09.md`:
**Wired** (procedure + page + test), **Partial**, **Honest n/c** (procedure real,
engine unconfigured), **Missing**.

### Workspace (team) level

| Vercel | Cloud Wai | Status |
|---|---|---|
| Overview (team) | `Projects` (`projects.list`) — the team's applications | Wired |
| Deployments | `Activity` (org audit log) approximates "what changed", not a deploy list; deployments are project-scoped | Partial by design |
| Logs / Observability | `Observability` (`observability.jobs`) — job roll-up now with per-state/kind charts and 14-day throughput | Partial |
| Usage | `Billing` (`billing.usage`) with hard spend cap | Wired (usage read) + cap |
| Analytics / Speed Insights | none | Missing |
| Integrations | none | Missing |
| Flags / Agent / AI Gateway / Sandboxes / Workflows / CDN | none | Missing (out of model) |
| Support | none | Missing |
| Settings | `Settings` (`organizations.get`, members) and `API keys` | Wired |
| Projects as filters | workspace switcher in the top bar switches team without leaving the page | Wired |
| Mobile bottom bar | compact responsive nav (sidebar becomes an off-canvas drawer) | Wired |

### Project level

| Vercel | Cloud Wai | Status |
|---|---|---|
| Overview | `Overview` (`projects.get` + latest deployment + checklist below) | Wired |
| Deployments | `Deployments` (`deployments.list/create/rollback/redeploy/promote/cancel/logs`) | Wired |
| Logs | the deployment logs drawer (per-attempt) | Wired |
| Analytics / Speed Insights | none | Missing |
| Observability | workspace `Observability` (job-derived) | Partial |
| Firewall | `Security` — see the dedicated section | Wired (author) / Honest n/c (edge) |
| CDN | none (engine-side) | Honest n/c |
| Domains | `Domains` (`domains.list/create/verify/remove`) + `Git` + `Environment` | Wired |
| Storage / data | `Database` — see the dedicated section | Wired / Honest n/c |
| Flags / Agent / AI Gateway / Sandboxes / Workflows | none | Missing |
| Usage | workspace `Billing` | Wired |
| Support | none | Missing |
| Settings | `Settings` (project) with Git/Env/Domains shortcuts | Wired |

### The Production Checklist (Overview)

Vercel's Overview ends in a "Production Checklist" that walks the operator
through go-live. Ours must be the same *shape* and honest: a small list of
concrete steps, each with its real state, computed from real rows — never a
checkmark that is green because a section exists.

The steps, in the order Vercel uses and our data supports:

1. Connect a Git repository — state from `git.links.list`.
2. Deploy once — state from `deployments.list` (first `succeeded`).
3. Add a custom domain — state from `domains.list` (any verified).
4. Set environment variables — state from `env.list`.
5. Turn on protection — state from `security.policy.get` (a non-default level).

Each row links to its own page. A row whose engine is unconfigured says so
rather than showing a spinner forever.

## The two deliberate additions

### Database (our differentiator one)

Vercel's nearest surface is **Storage** (KV/Postgres/Blob). Ours is deeper: a
full Postgres control surface, reached as a third drill-in level
Workspace → Project → Database, and every sub-page is deep-linkable.

| Sub-page | Purpose | Backing procedure | Status |
|---|---|---|---|
| Overview | Project DB status, connection details | `data.list` | Wired / Honest n/c |
| Table Editor | Browse/edit rows through the engine console | `data.list` + `engineConsole` | Wired (handoff) |
| SQL Editor | Run SQL in the engine | `engineConsole` | Wired (handoff) |
| Authentication | Users/sessions/providers (engine surface) | `engineConsole` | Wired (handoff) |
| Storage | Buckets for the project | `data.list` | Wired |
| API | REST endpoints exposed | `engineConsole` | Wired (handoff) |
| Roles & Extensions | Roles, extensions, backups | `data.list` + backups/restores | Wired |
| Logs | Recent DB/API logs | `data.logs` | Wired / Honest n/c |
| Settings | Engine settings | `engineConsole` | Wired (handoff) |

The handoff rows are deliberate: per ADR-0011 the control plane never opens the
tenant database, so editing happens on the engine console. That is a design
decision recorded, not a gap hidden.

### Security (our differentiator two)

Vercel calls it **Firewall**. Ours is the same idea with two differences worth
naming: our allow ladder leads the compiled policy (verified bots, internal,
trusted sources **before** deny/ratelimit/challenge), and every surface is
honest about whether a live edge exists.

| Capability | Backing | Status |
|---|---|---|
| Protection level (none/low/med/high/critical) | `security.policy.get/save` | Wired |
| Attack mode + timed window | `saveSecurityPolicy` | Wired |
| Distribute to the edge | `security.policy.distribute` | Wired (honest n/c without a live edge) |
| Custom deny rules | `security.rules.*` | Wired |
| Trusted sources (IP/CIDR/ASN) | `security.trustedSources.*` | Wired |
| Rate limits | `security.rateLimits.*` | Wired |
| Verified-bot allow-list | `security.bots.list` | Wired |
| Edge decisions (what was blocked) | `security.events.list` | Wired (read) |
| Incidents | `security.incidents.list/transition` | Wired |

**Placement decision.** Security's policy is organization-wide today
(`security_policies` is keyed by `organization_id`, no `project_id`), but Vercel
exposes Firewall under the project. We keep the project entry (parity, and it is
where an operator looks) *and* the page states the scope in prose so the
placement never implies a per-project policy the schema cannot hold. When a
project-scoped policy lands, the page gains a project selector and the entry
becomes genuinely per-project — the route does not change.

## How a section with sub-items is navigated (drill-in, not accordion)

Vercel does not expand a section's sub-items inline under the section row. It
*replaces* the sidebar: opening Firewall shows a Back control and the section's
own sub-items (Overview / Traffic / Rules / Audit Log) in place of the section
list, exactly as the Database level replaces the project menu. Confirmed against
the owner's screenshots: `Screenshot_20260930-114246` (Firewall) shows `< Firewall`
then the four sub-items and no section list; `...114343` (Flags), `...114407`
(AI Gateway), `...114416` (Sandboxes), `...114449` (Usage), `...114501`
(Settings) and `...114351` (Agent) all do the same. In the *unentered* project
sidebar (`...114304`, `...114334`, …) those same sections carry a trailing `>`
chevron — the signpost that a click drills in.

Cloud Wai follows that shape for the five sections the reference splits —
**Firewall, CDN, Storage, Flags, AI Gateway** — and for **Database**, which was
already a drill-in level:

- The sidebar level is `sub`: a flat list of the section's sub-items, with the
  Back control above them. `backTargetFor` sends Back to the section list's own
  level (Projects at workspace level, the project at project level).
- The section row carries a trailing chevron (`item.hasSubMenu`), drawn only for
  a section that has sub-items. A single-page section is a plain destination.
- The sub-items are `SECTION_SUBS[section]`, the same list the page renders as
  tabs, so the sidebar and the page cannot disagree.
- The command palette still offers every section *and* every sub-item, so Find
  reaches "Rules" even while the sidebar is showing something else. The palette
  reads the undrilled `baseNav`, never the replaced sidebar.

## The in-dashboard documentation surface

The owner's instruction is that a user can open the menu and read the whole
system: what each menu item is, what its page does, and where a click goes, with
pictures. Vercel ships this as its public docs (`vercel.com/docs`), separate
from the dashboard. We put a **Docs** entry in the menu that renders the same
content inside the app, because a self-hosted deployment cannot assume the
public site is reachable.

Design:

- Route `docs` at `/docs`, workspace level, first-class menu item.
- Content source: `apps/web/src/docs/content.ts`, a typed list of sections, so a
  section cannot exist in the UI without a title, body and (where useful) an
  image. This mirrors how `navigation.ts` is the single source for the sidebar.
- Each section covers one menu item: what it is, what the page does, what a
  click does, and its honest status.
- **The menu map is generated, not written.** `apps/web/src/docs/menu-map.ts`
  derives the whole three-level map from `workspaceNav` / `projectNav` /
  `databaseNav` — the same functions the sidebar reads — plus `toPath` for each
  entry's deep-linkable path. A new sidebar entry therefore appears in the Docs
  page automatically and a removed one disappears with it; the docs cannot
  describe a menu that does not exist. `tests/web/docs.test.ts` pins it by
  building the map and comparing it, entry for entry, to the three `*Nav`
  lists. When no project is open, the project and Database levels are still
  described, but their entries are marked unreachable, rendered without a link
  and shown with a `:project` path placeholder — so the page never offers a
  navigation that would not resolve.
- **One search box** filters both the menu map and the detailed sections at
  once, so a reader looking for a word lands on the map row and the section
  together; an empty result says so with `EmptyState` rather than rendering a
  blank column. The result count ("N of M entries match") is honest about the
  slice, exactly as the Activity page's CSV caption is.
- Images: our own diagrams/screenshots, committed under `apps/web/public/docs/`,
  never Vercel's assets. Where a diagram is enough, an inline SVG is used so the
  bundle carries no binary — and now every documented section carries one, plus
  a workspace → project → database overview diagram in the introduction.
- Honesty: a docs section for a Missing feature says "not built" with the reason
  (same rule as every page).

This is additive: it does not duplicate `docs/` in the repo (which is for
operators and reviewers); it is the user-facing subset, and the two are kept in
sync by naming the repo doc each section summarizes.

**Delivered.** `menu-map.ts`, the expanded `content.ts` (a section diagram per
entry, a `DOC_INTRO`, and the Database and Security differentiators documented
first-class), the rebuilt `DocsPage` (menu map + search + both result counts),
the new `docs__menu` styles in `packages/ui/src/styles.css`, and the tests:
`tests/web/docs.test.ts` (20 tests, including the map-mirrors-the-sidebar,
documents-every-entry, reachable-path and project-not-open cases) and four
end-to-end cases in `tests/web/dashboard.e2e.test.tsx` (the map renders with
real links and `:project` placeholders, and the search filters both lists).

## Honesty rules carried over (do not break these)

- A menu entry exists only with a route; a route exists only with a page. No
  dead links, no "coming soon" buttons that do nothing.
- A page for an unconfigured engine says `not_configured`; it never shows a fake
  success or a fake zero.
- A checklist step is green only when the real row says so.
- A docs section describes the system that exists, not a roadmap.

## Implementation order

1. **Security** entry stays project-scoped with the scope note; confirm it is
   reachable and complete. (This pass: verify, no code needed.)
2. **Production Checklist** on the project Overview, computed from real rows.
3. **Docs** menu entry and page, content module first.
4. Remaining Vercel items (Analytics, Flags, Integrations, Support, …) remain
   explicitly **Missing** in the feature matrix; the nav lists only what exists,
   and the Docs page explains the difference so the gap is visible, not hidden.
