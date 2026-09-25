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
 */
import { useState } from "react";
import { Button, Icon } from "@cloud-wai/ui/react";

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
  // read as a route and land on not-found. The section link therefore scrolls
  // directly instead of changing the hash.
  const scrollToArchitecture = () => {
    document.getElementById("architecture")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const [domainQuery, setDomainQuery] = useState("");

  return (
    <div className="landing">
      <section className="landing__hero">
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
        <form
          className="landing__search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            document.getElementById("domain-search-note")?.scrollIntoView({
              behavior: "smooth",
              block: "nearest",
            });
          }}
        >
          <label className="landing__search-label" htmlFor="landing-domain-search">
            Find a domain
          </label>
          <div className="landing__search-row">
            <span className="landing__search-glyph" aria-hidden="true">
              <Icon name="domains" size={18} />
            </span>
            <input
              id="landing-domain-search"
              className="landing__search-input"
              type="search"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="your-company.com"
              value={domainQuery}
              onChange={(event) => setDomainQuery(event.target.value)}
            />
            <Button type="submit" variant="primary" disabled={domainQuery.trim() === ""}>
              Search
            </Button>
          </div>
        </form>
        <p id="domain-search-note" className="landing__search-note">
          Search is here; registrar lookup is not. Domain registration needs a provider this
          deployment has not configured, so this box will not invent an availability result.
        </p>
        <div className="landing__cta">
          <Button variant="primary" onClick={onEnterDashboard}>
            {signedIn ? "Open the dashboard" : "Sign in"}
          </Button>
          <button type="button" className="landing__secondary" onClick={scrollToArchitecture}>
            How it is built
          </button>
        </div>
      </section>

      <section id="architecture" className="landing__band" aria-labelledby="architecture-heading">
        <h2 id="architecture-heading" className="landing__band-title">
          Three layers, one contract
        </h2>
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

      <section className="landing__band" aria-labelledby="features-heading">
        <h2 id="features-heading" className="landing__band-title">
          Where this goes beyond a deploy button
        </h2>
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

      <section className="landing__band" aria-labelledby="compare-heading">
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
        <div>
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
