/**
 * The public landing page.
 *
 * This is the one screen that renders without a session, so it makes no claim
 * the deployment cannot support: no uptime badge, no green "all systems
 * operational" dot, no fabricated availability. It describes what the software
 * is — a control plane that owns identity, deployments, data and policy, and
 * drives open-source engines behind its own adapters — and routes the visitor
 * into the dashboard.
 *
 * The page structure follows the current generation of infrastructure-product
 * sites: a sticky top navigation, a centred hero with one strong promise, a
 * deploy-flow illustration, a capabilities bento, a three-layer platform band,
 * the domain search in the Domains band where a domain belongs, a security
 * band, a comparison, pricing, and a columned footer. It is inspired by that
 * shape, not copied from it: the copy, the palette and the diagram are this
 * product's own.
 *
 * Section links scroll with `scrollIntoView` rather than `#anchor`: the app
 * routes on the URL hash, so an anchor would be parsed as a route and land on
 * not-found.
 */
import { Button, Icon, type IconName } from "@cloud-wai/ui/react";
import { DomainSearch } from "../components/domain-search.js";

/** The top navigation's in-page targets, paired with the label a visitor reads. */
const NAV = [
  { id: "platform", label: "Platform" },
  { id: "capabilities", label: "Capabilities" },
  { id: "domains", label: "Domains" },
  { id: "security", label: "Security" },
  { id: "pricing", label: "Pricing" },
] as const;

/**
 * The engines behind the adapters.
 *
 * Stated as text, not as borrowed logos: these are real systems the control
 * plane drives, and the point is that they are replaceable, not that they are
 * the product.
 */
const ENGINES = [
  "Coolify",
  "PostgreSQL",
  "MinIO",
  "Envoy",
  "Coraza",
  "CrowdSec",
  "Railpack",
  "Lambda",
] as const;

/**
 * The deploy flow, as an illustration.
 *
 * Deliberately a static example, labelled as one: the dashboard shows an
 * engine's real answer, so a scripted "ready" here would be the exact
 * fake-success this product refuses. The caption says so.
 */
const DEPLOY_STEPS = [
  { label: "Build", detail: "Railpack turns the repository into an image." },
  { label: "Deploy", detail: "The engine starts it behind a private origin." },
  { label: "Ready", detail: "The engine's own answer is written to the row." },
] as const;

/**
 * The platform's three layers.
 *
 * Kept as data so the band and the diagram cannot drift. Only the first layer
 * is the product; the other two are engines and the contract between them.
 */
const PILLARS: {
  readonly icon: IconName;
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
}[] = [
  {
    icon: "projects",
    kicker: "Control plane",
    title: "Identity, orgs, projects, policy",
    body: "Cloud Wai owns the contract: who you are, which tenant you belong to, what may be deployed, and what the audit log records. This layer is ours.",
  },
  {
    icon: "shield",
    kicker: "Hidden origin",
    title: "The application is not addressable",
    body: "Traffic reaches an application through the edge. The origin address is held by the edge adapter and is never published by policy or returned in a response.",
  },
  {
    icon: "database",
    kicker: "Engines",
    title: "Coolify, Postgres, MinIO, Envoy",
    body: "The execution machines. Each is reached through a Cloud Wai adapter with an explicit interface, a conformance check, and an honest answer when it cannot act.",
  },
];

/**
 * The capabilities bento.
 *
 * Each cell states a property the software enforces, not a promise. The `span`
 * controls how much of the grid the cell occupies, so the band reads as a
 * composition rather than a uniform row of boxes.
 */
const CAPABILITIES: {
  readonly icon: IconName;
  readonly title: string;
  readonly body: string;
  readonly span: "wide" | "normal";
}[] = [
  {
    icon: "projects",
    title: "Every tenant isolated by the database",
    body: "Scope is resolved from the session and enforced by row-level security in Postgres, not by a filter in the API. A client-supplied organization id is never the authority.",
    span: "wide",
  },
  {
    icon: "activity",
    title: "Honest state, everywhere",
    body: "An engine this deployment has no credentials for reports not configured. It never renders as a green badge, a zero balance, or a success the request invented.",
    span: "normal",
  },
  {
    icon: "deployments",
    title: "Durable, idempotent deploys",
    body: "A deploy is a leased job with an attempt count. A retry polls the build it already started instead of building a second one.",
    span: "normal",
  },
  {
    icon: "database",
    title: "A database system, not a data tab",
    body: "Tenant Postgres and object storage provisioned through the engine, with backups recorded as their own lifecycle and sub-pages that hand off to the engine's own console rather than faking an editor.",
    span: "wide",
  },
  {
    icon: "git",
    title: "Push to deploy",
    body: "A repository is connected once; a push or a pull request is HMAC-verified and enqueues the same build job the button does.",
    span: "normal",
  },
  {
    icon: "env",
    title: "Secrets that stay secret",
    body: "Values are encrypted at rest, never returned by a list, and never written to a log, an audit row or an error message.",
    span: "normal",
  },
];

/** How this differs from a deploy-button platform. */
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
      "An engine this deployment cannot act on reports not configured. A success is only ever the engine's own answer.",
  },
] as const;

/**
 * Plans.
 *
 * The prices are Cloud Wai's own offer, in euro — not a figure any engine
 * reported, so they are stated as the product's price rather than as a measured
 * result.
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

/** The footer's link columns. Every entry is a real in-page target or the dashboard. */
const FOOTER_COLUMNS: readonly {
  readonly heading: string;
  readonly links: readonly {
    readonly label: string;
    readonly target?: string;
    readonly dashboard?: boolean;
  }[];
}[] = [
  {
    heading: "Platform",
    links: [
      { label: "Architecture", target: "platform" },
      { label: "Capabilities", target: "capabilities" },
      { label: "Security", target: "security" },
      { label: "Domains", target: "domains" },
    ],
  },
  {
    heading: "Engines",
    links: [
      { label: "Coolify", target: "platform" },
      { label: "PostgreSQL", target: "platform" },
      { label: "MinIO", target: "platform" },
      { label: "Envoy & Coraza", target: "security" },
    ],
  },
  {
    heading: "Product",
    links: [
      { label: "Pricing", target: "pricing" },
      { label: "Compare", target: "compare" },
      { label: "Docs", dashboard: true },
      { label: "Dashboard", dashboard: true },
    ],
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
  // read as a route and land on not-found. Section links therefore scroll
  // directly instead of changing the hash.
  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const primaryLabel = signedIn ? "Open the dashboard" : "Sign in";

  return (
    <div className="landing">
      <header className="lnd-nav">
        <div className="lnd-nav__inner">
          <button
            type="button"
            className="lnd-brand"
            onClick={() => scrollTo("top")}
            aria-label="Cloud Wai — back to top"
          >
            <span className="lnd-brand__mark" aria-hidden="true">
              <span className="lnd-brand__glyph" />
            </span>
            <span className="lnd-brand__name">Cloud Wai</span>
          </button>
          <nav className="lnd-nav__links" aria-label="Sections">
            {NAV.map((item) => (
              <button
                type="button"
                key={item.id}
                className="lnd-nav__link"
                onClick={() => scrollTo(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="lnd-nav__actions">
            <button
              type="button"
              className="lnd-nav__link lnd-nav__link--quiet"
              onClick={onEnterDashboard}
            >
              {signedIn ? "Dashboard" : "Sign in"}
            </button>
            <Button variant="primary" size="sm" onClick={onEnterDashboard}>
              {signedIn ? "Open the dashboard" : "Get started"}
            </Button>
          </div>
        </div>
      </header>

      <span id="top" />

      <section className="lnd-hero">
        <div className="lnd-hero__glow" aria-hidden="true" />
        <p className="lnd-eyebrow">
          <span className="lnd-eyebrow__pip" aria-hidden="true" />
          Multi-tenant cloud control plane
        </p>
        <h1 className="lnd-hero__title">
          Ship on infrastructure
          <br />
          you actually own
        </h1>
        <p className="lnd-hero__lede">
          Cloud Wai owns identity, organizations, deployments, domains, data and security policy —
          and drives open-source engines behind its own adapters. It is not a wrapper around
          somebody else&apos;s SaaS, and it will not report a success an engine never performed.
        </p>
        <div className="lnd-hero__cta">
          <Button variant="primary" onClick={onEnterDashboard}>
            {primaryLabel}
          </Button>
          <button type="button" className="lnd-btn-ghost" onClick={() => scrollTo("platform")}>
            See how it is built
          </button>
        </div>

        <div className="lnd-terminal" role="img" aria-label="An illustration of a deployment flow">
          <div className="lnd-terminal__bar">
            <span className="lnd-terminal__dot" aria-hidden="true" />
            <span className="lnd-terminal__dot" aria-hidden="true" />
            <span className="lnd-terminal__dot" aria-hidden="true" />
            <span className="lnd-terminal__title mono">cloud-wai deploy</span>
          </div>
          <div className="lnd-terminal__body mono">
            <p>
              <span className="lnd-terminal__prompt">›</span> cloud-wai deploy --project web-app
            </p>
            <p className="lnd-terminal__ok">✔ build · image ready</p>
            <p className="lnd-terminal__ok">✔ deploy · engine accepted the build</p>
            <p className="lnd-terminal__ok">
              ✔ ready · the engine&apos;s own answer, written to the row
            </p>
            <p className="lnd-terminal__link">
              Production: <span className="lnd-terminal__url">https://web-app.example.cloud</span>
            </p>
          </div>
          <p className="lnd-terminal__caption">
            A deployment, illustrated. The dashboard shows an engine&apos;s real answer, never a
            scripted one — an engine this deployment cannot reach says so.
          </p>
        </div>

        <ul className="lnd-facts">
          <li>
            <span className="lnd-facts__key">Scope</span>
            <span className="lnd-facts__val">Enforced in Postgres by row-level security</span>
          </li>
          <li>
            <span className="lnd-facts__key">Origin</span>
            <span className="lnd-facts__val">Reachable only through the edge</span>
          </li>
          <li>
            <span className="lnd-facts__key">State</span>
            <span className="lnd-facts__val">Only ever the engine&apos;s own answer</span>
          </li>
        </ul>
      </section>

      <section className="lnd-engines" aria-label="Engines behind the adapters">
        <p className="lnd-engines__label">Driving engines you already trust</p>
        <div className="lnd-engines__row">
          {ENGINES.map((engine) => (
            <span className="lnd-engines__item" key={engine}>
              {engine}
            </span>
          ))}
        </div>
      </section>

      <section id="platform" className="lnd-band" aria-labelledby="platform-heading">
        <p className="lnd-kicker mono">01 — Platform</p>
        <h2 id="platform-heading" className="lnd-band__title">
          Three layers, one contract
        </h2>
        <p className="lnd-band__lede">
          The control plane is the only layer that is ours. Everything beneath it is an engine
          reached through an adapter, which is what lets a deployment swap the execution machines
          without changing the contract above them.
        </p>
        <div className="lnd-flow">
          {PILLARS.map((pillar, index) => (
            <article className="lnd-step" key={pillar.kicker}>
              <div className="lnd-step__head">
                <span className="lnd-step__glyph" aria-hidden="true">
                  <Icon name={pillar.icon} size={18} />
                </span>
                <span className="lnd-step__index mono">{String(index + 1).padStart(2, "0")}</span>
              </div>
              <span className="lnd-step__kicker">{pillar.kicker}</span>
              <h3 className="lnd-step__title">{pillar.title}</h3>
              <p className="lnd-step__body">{pillar.body}</p>
            </article>
          ))}
        </div>

        <div className="lnd-pipeline" aria-label="How a deployment is executed">
          {DEPLOY_STEPS.map((step, index) => (
            <div className="lnd-pipeline__step" key={step.label}>
              <span className="lnd-pipeline__num mono">{index + 1}</span>
              <span className="lnd-pipeline__label">{step.label}</span>
              <span className="lnd-pipeline__detail">{step.detail}</span>
              {index < DEPLOY_STEPS.length - 1 ? (
                <span className="lnd-pipeline__arrow" aria-hidden="true">
                  <Icon name="chevronRight" size={16} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section id="capabilities" className="lnd-band" aria-labelledby="capabilities-heading">
        <p className="lnd-kicker mono">02 — Capabilities</p>
        <h2 id="capabilities-heading" className="lnd-band__title">
          Where this goes beyond a deploy button
        </h2>
        <p className="lnd-band__lede">
          The hard parts a deploy-button platform leaves to you, answered here by the database and
          the edge rather than by an application convention.
        </p>
        <div className="lnd-bento">
          {CAPABILITIES.map((capability) => (
            <article className={`lnd-card lnd-card--${capability.span}`} key={capability.title}>
              <span className="lnd-card__glyph" aria-hidden="true">
                <Icon name={capability.icon} size={20} />
              </span>
              <h3 className="lnd-card__title">{capability.title}</h3>
              <p className="lnd-card__body">{capability.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="domains" className="lnd-band lnd-band--split" aria-labelledby="domains-heading">
        <div className="lnd-split__copy">
          <p className="lnd-kicker mono">03 — Domains</p>
          <h2 id="domains-heading" className="lnd-band__title">
            A domain is attached to a project, not to the hero
          </h2>
          <p className="lnd-band__lede">
            A hostname is verified by the edge and routed to the running application; it is created
            unverified and stays that way until the edge confirms it. Start by looking up a name —
            the answer here is about the deployment&apos;s registrar, never an invented
            availability.
          </p>
        </div>
        <div className="lnd-split__panel">
          <DomainSearch />
        </div>
      </section>

      <section
        id="security"
        className="lnd-band lnd-band--split lnd-band--alt"
        aria-labelledby="security-heading"
      >
        <div className="lnd-split__copy">
          <p className="lnd-kicker mono">04 — Security</p>
          <h2 id="security-heading" className="lnd-band__title">
            Policy, compiled — not a toggle
          </h2>
          <p className="lnd-band__lede">
            Risk levels and enforcement actions compile deterministically to Coraza and Envoy.
            Hostile host, path or origin input is refused before it becomes a rule. The origin stays
            private, so there is no address to reach directly.
          </p>
          <ul className="lnd-checks">
            <li>
              <Icon name="check" size={18} />A stale policy version is refused, so protection never
              rolls backwards.
            </li>
            <li>
              <Icon name="check" size={18} />
              An allow-list for verified crawlers, internal and trusted addresses — without
              weakening inspection.
            </li>
            <li>
              <Icon name="check" size={18} />A refused distribution opens an incident an operator
              can see and close.
            </li>
          </ul>
        </div>
        <div className="lnd-split__panel">
          <div className="lnd-code mono" aria-label="A compiled policy, abbreviated">
            <p className="lnd-code__comment"># compiled from organization policy, version 12</p>
            <p>SecRuleEngine On</p>
            <p>SecRule REQUEST_URI &quot;@rx (\.\./|/etc/passwd)&quot; \</p>
            <p className="lnd-code__indent">&quot;id:1001,phase:1,deny,status:403&quot;</p>
            <p>SecRule REQUEST_HEADERS:User-Agent &quot;@rx sqlmap&quot; \</p>
            <p className="lnd-code__indent">&quot;id:1002,phase:1,block&quot;</p>
            <p className="lnd-code__comment"># origin: private — no direct listener generated</p>
          </div>
        </div>
      </section>

      <section id="compare" className="lnd-band" aria-labelledby="compare-heading">
        <p className="lnd-kicker mono">05 — Difference</p>
        <h2 id="compare-heading" className="lnd-band__title">
          The same jobs, answered differently
        </h2>
        <div className="lnd-compare">
          <div className="lnd-compare__head" aria-hidden="true">
            <span className="lnd-compare__topic" />
            <span className="lnd-compare__col-label">A deploy-button platform</span>
            <span className="lnd-compare__col-label lnd-compare__col-label--us">Cloud Wai</span>
          </div>
          {COMPARISON.map((row) => (
            <div className="lnd-compare__row" key={row.topic}>
              <span className="lnd-compare__topic">{row.topic}</span>
              <p className="lnd-compare__cell">{row.generic}</p>
              <p className="lnd-compare__cell lnd-compare__cell--us">{row.cloudWai}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="pricing" className="lnd-band" aria-labelledby="plans-heading">
        <p className="lnd-kicker mono">06 — Pricing</p>
        <h2 id="plans-heading" className="lnd-band__title">
          Pricing
        </h2>
        <p className="lnd-band__lede">
          Per user, per month. The engine work runs on infrastructure you already operate, so the
          price is the control plane — not a markup on the compute beneath it.
        </p>
        <div className="lnd-plans">
          {PLANS.map((plan) => (
            <article
              className={plan.highlight ? "lnd-plan lnd-plan--highlight" : "lnd-plan"}
              key={plan.name}
            >
              {plan.highlight ? <span className="lnd-plan__flag">Most popular</span> : null}
              <h3 className="lnd-plan__name">{plan.name}</h3>
              <p className="lnd-plan__price">
                <span className="lnd-plan__amount">{plan.price}</span>
                <span className="lnd-plan__cadence">{plan.cadence}</span>
              </p>
              <p className="lnd-plan__tagline">{plan.tagline}</p>
              <ul className="lnd-plan__features">
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Icon name="check" size={16} />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button variant={plan.highlight ? "primary" : "default"} onClick={onEnterDashboard}>
                {plan.cta}
              </Button>
            </article>
          ))}
        </div>
      </section>

      <section className="lnd-cta-band" aria-labelledby="start-heading">
        <div className="lnd-cta-band__glow" aria-hidden="true" />
        <h2 id="start-heading" className="lnd-band__title">
          Bring your first project
        </h2>
        <p className="lnd-band__lede">
          Create a workspace, add a project, and connect an engine. Until an engine is configured,
          every affected section says so — you will never see a green badge for work that did not
          run.
        </p>
        <div className="lnd-hero__cta">
          <Button variant="primary" onClick={onEnterDashboard}>
            {signedIn ? "Go to your dashboard" : "Get started"}
          </Button>
          <button type="button" className="lnd-btn-ghost" onClick={() => scrollTo("platform")}>
            Read the architecture
          </button>
        </div>
      </section>

      <footer className="lnd-foot">
        <div className="lnd-foot__inner">
          <div className="lnd-foot__brand">
            <span className="lnd-brand__mark" aria-hidden="true">
              <span className="lnd-brand__glyph" />
            </span>
            <span className="lnd-foot__name">Cloud Wai</span>
            <p className="lnd-foot__note">
              Multi-tenant control plane for self-operated hosting and data services.
            </p>
          </div>
          {FOOTER_COLUMNS.map((column) => (
            <div className="lnd-foot__col" key={column.heading}>
              <h3 className="lnd-foot__heading">{column.heading}</h3>
              <ul>
                {column.links.map((link) => (
                  <li key={link.label}>
                    <button
                      type="button"
                      className="lnd-foot__link"
                      onClick={() =>
                        link.dashboard ? onEnterDashboard() : scrollTo(link.target ?? "top")
                      }
                    >
                      {link.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="lnd-foot__bar">
          <span className="lnd-foot__note">
            Version <span className="mono">{version}</span>
          </span>
          <span className="lnd-foot__note">
            Engine status is reported per workspace, from the engines this deployment actually holds
            credentials for — not from a status page.
          </span>
        </div>
      </footer>
    </div>
  );
}
