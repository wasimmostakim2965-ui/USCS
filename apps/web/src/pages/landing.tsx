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
