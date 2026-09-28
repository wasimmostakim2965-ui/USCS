/**
 * The public landing page.
 *
 * This is the one screen that renders without a session, so it must make no
 * claim the deployment cannot support. There is deliberately no "99.99% uptime"
 * badge and no green "All systems operational" dot: this page has no data, and
 * inventing a status here would be the exact fake-success the rest of the
 * product refuses. It describes what the software *is* — a control plane that
 * owns identity, deployments, data and policy, and drives open-source engines
 * behind its own adapters — and sends the visitor into the dashboard.
 *
 * It carries its own top navigation because it renders outside the dashboard
 * shell. The links scroll within the page rather than changing the URL: the
 * application routes on the hash, so an `#anchor` would be read as a route and
 * land on not-found. The domain search lives in the Domains section, where a
 * domain belongs, not in the hero — a domain is something you attach to an
 * application, and the page says so in the place it is used.
 */
import { Button, Icon } from "@cloud-wai/ui/react";
import { DomainSearch } from "../components/domain-search.js";

const DIFFERENTIATORS = [
  {
    icon: "database",
    title: "A database system, not a data tab",
    body: "Tenant Postgres and object storage provisioned through the engine, addressed by an engine handle this control plane never exposes, with backups recorded as their own lifecycle.",
  },
  {
    icon: "shield",
    title: "Edge security as policy, not a toggle",
    body: "Coraza and CrowdSec rules are compiled from a versioned organization policy and pushed to the edge. Hostile input is refused before it becomes a rule. The origin stays private.",
  },
  {
    icon: "projects",
    title: "Every tenant isolated by the database",
    body: "Scope is resolved from the session and enforced by row-level security in Postgres, not by a filter in the API. A client-supplied organization id is never the authority.",
  },
  {
    icon: "activity",
    title: "Honest state, everywhere",
    body: "An engine this deployment has no credentials for reports not_configured. It never renders as a green badge, a zero balance, or a success the request invented.",
  },
] as const;

const PILLARS = [
  {
    kicker: "Control plane",
    title: "Identity, orgs, projects, policy",
    body: "Cloud Wai owns the contract: who you are, which tenant you belong to, what may be deployed, and what the audit log records. This layer is ours.",
  },
  {
    kicker: "Hidden origin",
    title: "The application is not addressable",
    body: "Traffic reaches an application through the edge. The origin address is held by the edge adapter and is never published by policy or returned in a response.",
  },
  {
    kicker: "Engines",
    title: "Coolify, Postgres, MinIO, Envoy",
    body: "The execution machines. Each is reached through a Cloud Wai adapter with an explicit interface, a conformance check, and an honest answer when it cannot act.",
  },
] as const;

/**
 * Plans.
 *
 * The prices are Cloud Wai's own offer, in euro — not a figure any engine
 * reported, so they are stated as the product's price rather than as a measured
 * result. The entry price sits in the €30–€50/user/month band a production
 * platform is worth; Scale is a real ceiling, not a "contact us".
 */
const PLANS = [
  {
    name: "Free",
    price: "€0",
    cadence: "forever",
    tagline: "For evaluating the control plane end to end.",
    features: [
      "One organization, one project",
      "Deployments, domains and the audit log",
      "Engine status reported honestly",
      "Community support",
    ],
    cta: "Start on Free",
    highlight: false,
  },
  {
    name: "Pro",
    price: "€50",
    cadence: "per user / month",
    tagline: "For production projects that need the full pipeline.",
    features: [
      "Unlimited projects and deployments",
      "Preview deployments per pull request",
      "Tenant Postgres and object storage",
      "Compiled edge security policy",
      "Hard spend budgets that gate every build",
    ],
    cta: "Start with Pro",
    highlight: true,
  },
  {
    name: "Scale",
    price: "€50+",
    cadence: "per user / month",
    tagline: "For teams running many tenants on their own engines.",
    features: [
      "Everything in Pro",
      "Dedicated engine destinations per tenant",
      "Higher concurrency and retention",
      "Priority support",
    ],
    cta: "Talk to us",
    highlight: false,
  },
] as const;

/**
 * How this differs from a deploy-button platform.
 *
 * Kept as data so the left column cannot drift from the right one. Each row
 * states a capability the software actually has, not a promise: the third
 * column is why it matters to an operator, and none of it claims the deployment
 * already runs an engine it has no credentials for.
 */
const COMPARISON = [
  {
    topic: "Data",
    generic: "A managed database attached to a project.",
    cloudWai:
      "A database system: tenant Postgres and object storage provisioned through engines, backups recorded as their own lifecycle.",
  },
  {
    topic: "Security",
    generic: "A WAF toggle and a dashboard warning.",
    cloudWai:
      "A compiled, versioned policy pushed to the edge. Hostile input is refused before it becomes a rule; the origin stays private.",
  },
  {
    topic: "Isolation",
    generic: "A filter the application is asked to apply.",
    cloudWai:
      "Scope resolved from the session and enforced by row-level security in Postgres. A client-supplied organization id is never the authority.",
  },
  {
    topic: "State",
    generic: "A green badge that renders whether or not anything ran.",
    cloudWai:
      "An engine this deployment cannot act on reports not_configured. A success is only ever the engine's own answer.",
  },
] as const;

/** The top navigation's in-page targets, paired with the label a visitor reads. */
const NAV = [
  { id: "platform", label: "Platform" },
  { id: "capabilities", label: "Capabilities" },
  { id: "domains", label: "Domains" },
  { id: "pricing", label: "Pricing" },
] as const;

export function LandingPage({
  onEnterDashboard,
  signedIn,
  version,
}: {
  /** Route the visitor into the dashboard. */
  readonly onEnterDashboard: () => void;
  /** Whether a session exists, so the primary action can say what it will do. */
  readonly signedIn: boolean;
  /** The build's own version, read from the package, never hard-coded here. */
  readonly version: string;
}) {
  // The application routes on the URL hash, so an in-page `#anchor` would be
  // read as a route and land on not-found. Section links therefore scroll
  // directly instead of changing the hash.
  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const primaryLabel = signedIn ? "Open the dashboard" : "Sign in";

  return (
    <div className="landing">
      <header className="landing__topbar">
        <button
          type="button"
          className="landing__brand"
          onClick={() => scrollTo("top")}
          aria-label="Cloud Wai — back to top"
        >
          <span className="landing__brand-mark" aria-hidden="true">
            <span className="landing__brand-glyph" />
          </span>
          <span className="landing__brand-name">Cloud Wai</span>
        </button>
        <nav className="landing__nav" aria-label="Sections">
          {NAV.map((item) => (
            <button
              type="button"
              key={item.id}
              className="landing__nav-link"
              onClick={() => scrollTo(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="landing__nav-actions">
          <Button variant="primary" size="sm" onClick={onEnterDashboard}>
            {primaryLabel}
          </Button>
        </div>
      </header>

      <span id="top" />

      <section className="landing__hero">
        <div className="landing__hero-copy">
          <p className="landing__eyebrow">
            <span className="landing__pip" aria-hidden="true" />
            Multi-tenant cloud control plane
          </p>
          <h1 className="landing__title">
            The hidden-origin
            <br />
            cloud control plane
          </h1>
          <p className="landing__lede">
            Cloud Wai owns identity, organizations, deployments, domains, data and security policy —
            and drives open-source engines behind its own adapters. It is not a wrapper around
            somebody else&apos;s SaaS, and it will not report a success an engine never performed.
          </p>
          <div className="landing__cta">
            <Button variant="primary" onClick={onEnterDashboard}>
              {primaryLabel}
            </Button>
            <button
              type="button"
              className="landing__secondary"
              onClick={() => scrollTo("platform")}
            >
              How it is built
            </button>
          </div>
          <dl className="landing__facts">
            <div className="landing__fact">
              <dt>Scope</dt>
              <dd>Enforced in Postgres by row-level security</dd>
            </div>
            <div className="landing__fact">
              <dt>Origin</dt>
              <dd>Reachable only through the edge</dd>
            </div>
            <div className="landing__fact">
              <dt>State</dt>
              <dd>Only ever the engine&apos;s own answer</dd>
            </div>
          </dl>
        </div>
        <div className="landing__diagram" aria-hidden="true">
          <div className="landing__diagram-node landing__diagram-node--edge">
            <span className="landing__diagram-label">Edge</span>
            <span className="landing__diagram-note">TLS · WAF policy</span>
          </div>
          <span className="landing__diagram-wire" />
          <div className="landing__diagram-node landing__diagram-node--control">
            <span className="landing__diagram-label">Control plane</span>
            <span className="landing__diagram-note">identity · policy · audit</span>
          </div>
          <span className="landing__diagram-wire" />
          <div className="landing__diagram-stack">
            <div className="landing__diagram-node landing__diagram-node--engine">
              <span className="landing__diagram-label">Coolify</span>
            </div>
            <div className="landing__diagram-node landing__diagram-node--engine">
              <span className="landing__diagram-label">Postgres</span>
            </div>
            <div className="landing__diagram-node landing__diagram-node--engine">
              <span className="landing__diagram-label">MinIO</span>
            </div>
          </div>
        </div>
      </section>

      <section id="platform" className="landing__band" aria-labelledby="architecture-heading">
        <p className="landing__band-kicker mono">01 — Platform</p>
        <h2 id="architecture-heading" className="landing__band-title">
          Three layers, one contract
        </h2>
        <p className="landing__band-lede">
          The control plane is the only layer that is ours. Everything beneath it is an engine
          reached through an adapter, which is what lets a deployment swap the execution machines
          without changing the contract above them.
        </p>
        <div className="landing__flow">
          {PILLARS.map((pillar, index) => (
            <div className="landing__step" key={pillar.kicker}>
              <div className="landing__step-head">
                <span className="landing__step-index mono">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="landing__step-kicker">{pillar.kicker}</span>
              </div>
              <h3 className="landing__step-title">{pillar.title}</h3>
              <p className="landing__step-body">{pillar.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="capabilities" className="landing__band" aria-labelledby="features-heading">
        <p className="landing__band-kicker mono">02 — Capabilities</p>
        <h2 id="features-heading" className="landing__band-title">
          Where this goes beyond a deploy button
        </h2>
        <p className="landing__band-lede">
          Four capabilities a deploy-button platform leaves to you, answered here by the database
          and the edge rather than by an application convention.
        </p>
        <div className="landing__grid">
          {DIFFERENTIATORS.map((feature) => (
            <article className="landing__card" key={feature.title}>
              <span className="landing__card-glyph" aria-hidden="true">
                <Icon name={feature.icon} size={20} />
              </span>
              <h3 className="landing__card-title">{feature.title}</h3>
              <p className="landing__card-body">{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section
        id="domains"
        className="landing__band landing__band--domains"
        aria-labelledby="domains-heading"
      >
        <div className="landing__domains">
          <div className="landing__domains-copy">
            <p className="landing__band-kicker mono">03 — Domains</p>
            <h2 id="domains-heading" className="landing__band-title">
              A domain is attached to a project, not to the hero
            </h2>
            <p className="landing__band-lede">
              A hostname is verified by the edge and routed to the running application; it is
              created unverified and stays that way until the edge confirms it. Start by looking up
              a name — the answer here is about the deployment&apos;s registrar, never an invented
              availability.
            </p>
          </div>
          <div className="landing__domains-panel">
            <DomainSearch />
          </div>
        </div>
      </section>

      <section id="compare" className="landing__band" aria-labelledby="compare-heading">
        <p className="landing__band-kicker mono">04 — Difference</p>
        <h2 id="compare-heading" className="landing__band-title">
          The same jobs, answered differently
        </h2>
        <div className="compare">
          <div className="compare__head" aria-hidden="true">
            <span className="compare__topic" />
            <span className="compare__col-label">A deploy-button platform</span>
            <span className="compare__col-label compare__col-label--us">Cloud Wai</span>
          </div>
          {COMPARISON.map((row) => (
            <div className="compare__row" key={row.topic}>
              <span className="compare__topic">{row.topic}</span>
              <p className="compare__cell compare__cell--them">{row.generic}</p>
              <p className="compare__cell compare__cell--us">{row.cloudWai}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="landing__band" aria-labelledby="plans-heading">
        <p className="landing__band-kicker mono">05 — Pricing</p>
        <h2 id="plans-heading" className="landing__band-title">
          Pricing
        </h2>
        <p className="landing__band-lede">
          Per user, per month. The engine work runs on infrastructure you already operate, so the
          price is the control plane — not a markup on the compute beneath it.
        </p>
        <div className="plans">
          {PLANS.map((plan) => (
            <article className={plan.highlight ? "plan plan--highlight" : "plan"} key={plan.name}>
              {plan.highlight ? <span className="plan__flag">Most popular</span> : null}
              <h3 className="plan__name">{plan.name}</h3>
              <p className="plan__price">
                <span className="plan__amount">{plan.price}</span>
                <span className="plan__cadence">{plan.cadence}</span>
              </p>
              <p className="plan__tagline">{plan.tagline}</p>
              <ul className="plan__features">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <Button variant={plan.highlight ? "primary" : "default"} onClick={onEnterDashboard}>
                {plan.cta}
              </Button>
            </article>
          ))}
        </div>
      </section>

      <section className="landing__cta-band" aria-labelledby="start-heading">
        <h2 id="start-heading" className="landing__band-title">
          Bring your first project
        </h2>
        <p className="landing__band-lede">
          Create a workspace, add a project, and connect an engine. Until an engine is configured,
          every affected section says so — you will never see a green badge for work that did not
          run.
        </p>
        <div className="landing__cta">
          <Button variant="primary" onClick={onEnterDashboard}>
            {signedIn ? "Go to your dashboard" : "Get started"}
          </Button>
        </div>
      </section>

      <footer className="landing__foot">
        <div className="landing__foot-brand">
          <span className="landing__mark">Cloud Wai</span>
          <span className="landing__foot-note">
            Version <span className="mono">{version}</span>
          </span>
        </div>
        <p className="landing__foot-note">
          Engine status is reported per workspace, from the engines this deployment actually holds
          credentials for — not from a status page.
        </p>
      </footer>
    </div>
  );
}
