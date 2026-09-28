/**
 * The in-dashboard documentation.
 *
 * This is the user-facing subset of the repository's `docs/` tree, rendered
 * inside the app so a self-hosted deployment never needs the public site to be
 * reachable. It is a typed list, not prose in JSX, for the same reason
 * `navigation.ts` is typed: a section cannot reach the UI without a title, a
 * body and an honest status, and the docs cannot drift from the menu without a
 * test noticing.
 *
 * Two rules every section follows:
 *   * It describes the system that exists. A feature that is missing says so,
 *     with the reason, rather than describing a roadmap.
 *   * It names the repository document it summarizes (`source`), so a reviewer
 *     can check the user-facing claim against the operator-facing record.
 *
 * Images are our own inline SVG diagrams (`diagram`), never a copied asset. The
 * `DocsPage` renders the diagram and the prose; a section with no diagram is
 * valid and simply renders as text.
 */
import type { IconName } from "@cloud-wai/ui";

/** Truthful status of the surface a section documents. */
export type DocStatus = "wired" | "partial" | "engine" | "missing";

/** A tiny inline diagram, so the bundle carries no binary and nothing is copied. */
export interface DocDiagram {
  /** A human caption, also the SVG `aria-label`. */
  readonly caption: string;
  /** SVG path data, drawn in a 64×40 viewBox. */
  readonly paths: readonly string[];
}

export interface DocSection {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  readonly status: DocStatus;
  /** One sentence a user can act on. */
  readonly summary: string;
  /** What the page does and what a click lands on. */
  readonly body: readonly string[];
  readonly diagram?: DocDiagram;
  /** The repository document this section summarizes. */
  readonly source?: string;
}

export const DOC_STATUS_LABELS: Readonly<Record<DocStatus, string>> = {
  wired: "Built",
  partial: "Partly built",
  engine: "Needs an engine",
  missing: "Not built",
};

export const DOC_STATUS_DESCRIPTIONS: Readonly<Record<DocStatus, string>> = {
  wired: "The procedure, the page and a test exist in this repository.",
  partial: "The working part is real; the rest is named below rather than implied.",
  engine:
    "The procedure and page are real. The provider behind them is not configured in this deployment, so it reports not_configured instead of a fake result.",
  missing: "Deliberately absent. The reason is in the section, not hidden.",
};

export const DOC_SECTIONS: readonly DocSection[] = [
  {
    id: "projects",
    title: "Projects",
    icon: "projects",
    status: "wired",
    summary:
      "The workspace's applications: create one, open one, and see each one's production state.",
    body: [
      "Projects is the workspace's front page. It lists every application in this organization with its latest production deployment state, and is where a new project is created.",
      "Opening a project switches the sidebar from the workspace menu to that project's own menu — Overview, Deployments, Domains, Git, Environment, Database, Security and Settings.",
      "A project belongs to exactly one organization, and its URL always carries both, so a link cannot resolve to the wrong tenant.",
    ],
    source: "docs/adr/0004-control-plane-erd-rls.md",
  },
  {
    id: "overview",
    title: "Overview",
    icon: "overview",
    status: "wired",
    summary:
      "The project's production state at a glance: latest deployment, domains, Git, and a go-live checklist.",
    body: [
      "Overview is the project's top page. It shows the current production deployment and its URL, the most recent deployments, the connected Git repository, and this project's domains.",
      "It ends in a Production Checklist — connect Git, deploy once, add a domain, set environment variables, turn on protection — where each step is marked from a real row, never from the section merely existing.",
      "Clicking any deployment opens its detail and logs; clicking a checklist step links to the page that completes it.",
    ],
    source: "docs/plans/vercel-navigation-parity.md",
  },
  {
    id: "deployments",
    title: "Deployments",
    icon: "deployments",
    status: "wired",
    summary: "Build and release history, with rollback, promote, redeploy and cancel.",
    body: [
      "Deployments lists every build for this project in order: who started it, from which branch and commit, and whether it is queued, building, ready, failed or cancelled.",
      "Each row opens its own build and runtime logs. A ready production deployment can be rolled back to a previous commit in one action; a preview can be promoted to production; a past row can be redeployed; an in-flight build can be cancelled.",
      "A deployment request returns queued immediately and is executed by the worker off the request path, so the page stays responsive while a build runs.",
    ],
    diagram: {
      caption: "A deploy request becomes a durable job the worker claims, with logs per attempt.",
      paths: ["M4 8h14v6H4z", "M30 8h12v6H30z", "M50 8h10v6H50z", "M18 11h12", "M42 11h8"],
    },
    source: "docs/adr/0005-api-contracts-and-state-machines.md",
  },
  {
    id: "domains",
    title: "Domains",
    icon: "domains",
    status: "partial",
    summary: "Add, verify and remove the hostnames that serve this project.",
    body: [
      "Add a hostname, receive the DNS record the engine needs, then verify it. Verification is a real DNS check; an unverified domain is not an error, it is a pending step.",
      "Automatic TLS is provisioned by the engine once the domain is verified. The control plane records the domain and its state; it does not terminate TLS itself.",
      "Removing a domain detaches it from the project. A verified domain must be re-verified if its DNS record changes.",
    ],
    source: "docs/competitive/vercel-feature-matrix.md",
  },
  {
    id: "git",
    title: "Git",
    icon: "git",
    status: "wired",
    summary: "Connect a repository so a push deploys this project automatically.",
    body: [
      "Connect a GitHub, GitLab or Bitbucket repository, choose the production branch, and Cloud Wai creates a webhook. A push to that branch enqueues a deployment; a pull request opens a preview deployment.",
      "The webhook is HMAC-verified before it can start a build, and a push that would exceed an organization's hard spend cap is skipped with an audit record rather than answered dishonestly.",
      "Engine execution of the build requires the build engine to be configured; otherwise the deployment reports not_configured.",
    ],
    source: "docs/runbooks/build-plane.md",
  },
  {
    id: "env",
    title: "Environment",
    icon: "env",
    status: "wired",
    summary: "Variables injected into this project's builds and runtime, scoped per environment.",
    body: [
      "Set a variable for Production, Preview or Development. Values are encrypted at rest and never returned to the browser once saved; the list shows the key and whether it is build-time.",
      "Variables are pushed to the engine before each build, so a change is expressed as a redeploy rather than implying the running artifact already has it.",
    ],
    source: "docs/competitive/vercel-feature-matrix.md",
  },
  {
    id: "database",
    title: "Database",
    icon: "database",
    status: "engine",
    summary: "A hosted Postgres surface: tables, SQL, auth, storage, roles and backups.",
    body: [
      "Database is a third drill-in level: Workspace, then Project, then Database. Every sub-page is its own URL, so it can be linked, refreshed and bookmarked.",
      "Overview shows status and connection details; Table Editor, SQL Editor, Authentication, API and Settings hand off to the engine console, because the control plane never opens a tenant database (a recorded design decision, not a gap).",
      "Roles & Extensions includes backup and restore. Restoring is verified through the engine's own artifacts. Storage lists this project's buckets. Logs reads recent database and API logs.",
      "Provisioning and logs require the database and storage engines to be configured; until then each surface reports not_configured rather than inventing a database.",
    ],
    diagram: {
      caption: "Workspace → Project → Database is a third level; each sub-page is deep-linkable.",
      paths: ["M4 6h16v6H4z", "M26 6h14v6H26z", "M46 6h14v6H46z"],
    },
    source: "docs/adr/0004-control-plane-erd-rls.md",
  },
  {
    id: "security",
    title: "Security",
    icon: "shield",
    status: "engine",
    summary:
      "Protection level, attack mode, deny rules, trusted sources, rate limits and verified bots.",
    body: [
      "Security is the edge posture for your deployments. Set a protection level from none to critical, and turn on attack mode for a window when you are under attack.",
      "Our allow ladder leads the compiled policy: a forward-confirmed verified bot, an internal request and a trusted address are exempted before deny, rate-limit and challenge steps run, so a crawler or a webhook sender is not collateral damage.",
      "Custom deny rules, trusted sources (IP/CIDR/ASN) and per-route rate limits are all saved to the control plane and compiled into the edge artifact. The edge decisions page shows what was blocked, and incidents open automatically when a distribution is rejected.",
      "Applying a policy to a real edge requires the edge engine to be configured. Saved policy is real; a live edge is reported honestly until one exists.",
    ],
    source: "docs/adr/0003-threat-model.md",
  },
  {
    id: "observability",
    title: "Observability",
    icon: "pulse",
    status: "partial",
    summary: "Job throughput, failures and latency across the organization.",
    body: [
      "Observability rolls up the real orchestration jobs in this organization by state and kind, with a 14-day throughput series derived from job timestamps.",
      "It reports job activity, not host or container resource metrics: those, and distributed traces, are not built here and the page states that rather than showing an empty panel as if it were broken.",
    ],
    source: "docs/runbooks/slos.md",
  },
  {
    id: "audit",
    title: "Activity",
    icon: "activity",
    status: "wired",
    summary: "An append-only record of what changed, with CSV export.",
    body: [
      "Activity is the organization's audit log. No role can edit or delete an entry; the database enforces append-only.",
      "Export CSV downloads the entries currently loaded, and the caption says it is the loaded slice, not the full history, so a file that stopped never looks complete.",
    ],
    source: "docs/adr/0005-api-contracts-and-state-machines.md",
  },
  {
    id: "billing",
    title: "Billing",
    icon: "billing",
    status: "wired",
    summary: "Usage recorded for the organization, with a hard spend cap.",
    body: [
      "Billing reports the usage the engines actually confirmed, per metric. An organization with no recorded usage says so rather than showing a zero balance as if it were a fact.",
      "Budgets can be set as a hard cap. At the cap, new builds are refused before anything is enqueued — on a member deploy, a rollback and a Git push alike — which is the answer to the surprise-invoice complaint users raise about Vercel.",
    ],
    source: "docs/competitive/vercel-feature-matrix.md",
  },
  {
    id: "api-keys",
    title: "API keys",
    icon: "key",
    status: "wired",
    summary: "Programmatic access to the organization, scoped and revocable.",
    body: [
      "Mint a key, choose its scopes, and use it as a bearer token. A key is resolved to its owner, capped by that owner's current membership and the key's own scopes, and its last-use time is stamped.",
      "The secret is shown exactly once and stored hashed; it never appears in a list response, a log or an audit record.",
    ],
    source: "docs/adr/0005-api-contracts-and-state-machines.md",
  },
  {
    id: "settings",
    title: "Settings",
    icon: "settings",
    status: "wired",
    summary: "Organization profile, members and roles, and per-project configuration.",
    body: [
      "Workspace Settings covers the organization profile and its members. Roles are rank-bounded: a member cannot grant a rank above their own, enforced in the API and in row-level security.",
      "Project Settings covers the project name and slug, and links to Git, Environment Variables and Domains. A slug or execution model cannot be changed once the engine holds the application, and the field says why.",
    ],
    source: "docs/adr/0005-api-contracts-and-state-machines.md",
  },
  {
    id: "not-built",
    title: "What is not built",
    icon: "close",
    status: "missing",
    summary:
      "The Vercel features we do not ship, and why, so the gap is visible rather than hidden.",
    body: [
      "Analytics, Speed Insights, CDN cache controls, Feature Flags, Integrations, AI Gateway, Sandboxes, Workflows, Support and account-level webhooks are not built here. They are recorded as Missing in the feature matrix rather than shown as disabled buttons.",
      "The menu lists only what exists: a section with no page is not rendered, so there are no dead entries. This page is where that decision is made visible.",
      "Our two additions beyond Vercel are Database and Security, both above. They are our differentiators, so they are first-class rather than tucked into settings.",
    ],
    source: "docs/competitive/vercel-feature-matrix.md",
  },
];
