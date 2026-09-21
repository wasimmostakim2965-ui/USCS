import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { startLogin } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { CloudNavigation, type Section, getNavigationLabel } from "@/components/CloudNavigation";
import AuthDialog from "@/components/AuthDialog";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  BookOpen,
  Box,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cloud,
  Code2,
  Command,
  Copy,
  Database,
  ExternalLink,
  FileKey2,
  Fingerprint,
  Globe2,
  GitBranch,
  Github,
  HardDrive,
  KeyRound,
  Layers3,
  LifeBuoy,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Timer,
  UploadCloud,
  UserRound,
  X,
  Zap,
} from "lucide-react";

const statusItems = [
  { label: "Domain provider", icon: Globe2, description: "Search and register domains" },
  { label: "Deployment provider", icon: Cloud, description: "Build and ship from GitHub" },
  { label: "Database", icon: Database, description: "Provision private Postgres" },
  { label: "Object storage", icon: HardDrive, description: "Private buckets and files" },
];

const securityChecks = [
  ["HTTPS & TLS", "Configuration required", LockKeyhole],
  ["WAF baseline", "Configuration required", ShieldCheck],
  ["Secret isolation", "Configuration required", FileKey2],
  ["Audit logging", "Ready when connected", Fingerprint],
  ["Private database", "Configuration required", Database],
  ["Origin protection", "Configuration required", Network],
] as const;

const quickActions = [
  { label: "Connect GitHub", section: "Developer" as Section, icon: Github },
  { label: "Search a domain", section: "Domains" as Section, icon: Globe2 },
  { label: "Create a project", section: "Projects" as Section, icon: Plus },
  { label: "Review security", section: "Security" as Section, icon: ShieldCheck },
];

function StatusPill({ tone = "muted", children }: { tone?: "muted" | "warning" | "success"; children: ReactNode }) {
  return <span className={`status-pill status-${tone}`}><span className="status-dot" />{children}</span>;
}

function SectionHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="section-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function EmptyState({ icon: Icon, title, body, action, onAction }: { icon: typeof Activity; title: string; body: string; action?: string; onAction?: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon size={20} strokeWidth={1.7} /></div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action && <button className="button button-primary" onClick={onAction}>{action}<ArrowUpRight size={15} /></button>}
    </div>
  );
}

function Overview({ onNavigate }: { onNavigate: (section: Section) => void }) {
  return (
    <>
      <SectionHeader
        eyebrow="Control plane / Overview"
        title="Good morning."
        description="One secure place to build, deploy, and operate your applications."
        action={<button className="button button-primary" onClick={() => onNavigate("Projects")}><Plus size={16} /> New project</button>}
      />

      <div className="notice-banner">
        <div className="notice-icon"><AlertTriangle size={18} /></div>
        <div className="notice-copy"><strong>Platform configuration required</strong><span>Connect your infrastructure providers to enable real domain, deployment, data, and security operations. USCS never presents simulated provider data.</span></div>
        <button className="button button-quiet" onClick={() => onNavigate("Settings")}>Review setup <ArrowUpRight size={15} /></button>
      </div>

      <div className="metric-grid">
        <MetricCard label="Projects" value="Not connected" detail="No deployment provider" onClick={() => onNavigate("Projects")} />
        <MetricCard label="Domains" value="Not connected" detail="Registrar required" onClick={() => onNavigate("Domains")} />
        <MetricCard label="Data resources" value="Not connected" detail="Database or storage required" onClick={() => onNavigate("Data")} />
        <MetricCard label="Security posture" value="Unknown" detail="Run checks after setup" onClick={() => onNavigate("Security")} />
      </div>

      <div className="content-grid two-thirds">
        <div className="panel setup-panel">
          <div className="panel-heading"><div><div className="eyebrow">Recommended path</div><h2>From idea to production</h2></div><span className="panel-kicker">4 steps</span></div>
          <div className="step-list">
            {[
              ["01", "Connect a provider", "Choose GitHub, a registrar, or a data provider.", "Developer" as Section, Github],
              ["02", "Create your first project", "Bring a repository or start from a secure template.", "Projects" as Section, Box],
              ["03", "Attach your domain", "Configure DNS and TLS without leaving the workspace.", "Domains" as Section, Globe2],
              ["04", "Review protection", "Confirm WAF, secrets, access, and audit settings.", "Security" as Section, ShieldCheck],
            ].map(([index, title, body, target, Icon]) => (
              <button className="step-row" key={index as string} onClick={() => onNavigate(target as Section)}>
                <span className="step-number">{index as string}</span><span className="step-copy"><strong>{title as string}</strong><small>{body as string}</small></span><ChevronRight size={16} className="step-arrow" />
              </button>
            ))}
          </div>
        </div>
        <div className="panel quick-panel">
          <div className="panel-heading"><div><div className="eyebrow">Shortcuts</div><h2>Quick actions</h2></div><Command size={17} className="muted-icon" /></div>
          <div className="quick-list">{quickActions.map(({ label, section }) => <button className="quick-row" key={label} onClick={() => onNavigate(section)}><span>{label}</span><ArrowUpRight size={14} /></button>)}</div>
          <div className="tip-box"><Sparkles size={15} /><span>Press <kbd>⌘ K</kbd> to jump anywhere.</span></div>
        </div>
      </div>

      <div className="content-grid two-thirds lower-grid">
        <div className="panel">
          <div className="panel-heading"><div><div className="eyebrow">Provider readiness</div><h2>Connection status</h2></div><button className="icon-button" aria-label="Refresh status" onClick={() => toast.info("Provider status refresh requires a connected provider.")}><RefreshCw size={16} /></button></div>
          <div className="provider-list">{statusItems.map(({ label, description, icon: Icon }) => <div className="provider-row" key={label}><span className="provider-icon"><Icon size={17} /></span><span className="provider-copy"><strong>{label}</strong><small>{description}</small></span><StatusPill>Not connected</StatusPill><button className="text-button" onClick={() => onNavigate(label === "Database" || label === "Object storage" ? "Data" : label === "Domain provider" ? "Domains" : "Developer")}>Configure <ArrowUpRight size={14} /></button></div>)}</div>
        </div>
        <div className="panel">
          <div className="panel-heading"><div><div className="eyebrow">Security center</div><h2>Baseline controls</h2></div><button className="text-button" onClick={() => onNavigate("Security")}>View all <ArrowUpRight size={14} /></button></div>
          <div className="security-mini-grid">{securityChecks.slice(0, 4).map(([label, status, Icon]) => <div className="security-mini" key={label as string}><Icon size={16} /><span><strong>{label as string}</strong><small>{status as string}</small></span></div>)}</div>
          <div className="security-foot"><StatusPill tone="warning">No score shown until checks run</StatusPill></div>
        </div>
      </div>

      <div className="panel activity-panel">
        <div className="panel-heading"><div><div className="eyebrow">Audit trail</div><h2>Recent activity</h2></div><button className="text-button" onClick={() => onNavigate("Observability")}>Open observability <ArrowUpRight size={14} /></button></div>
        <EmptyState icon={Activity} title="No activity yet" body="Security-sensitive actions will appear here once you connect a provider and create a resource." />
      </div>
    </>
  );
}

function MetricCard({ label, value, detail, onClick }: { label: string; value: string; detail: string; onClick: () => void }) {
  return <button className="metric-card" onClick={onClick}><div className="metric-top"><span>{label}</span></div><strong>{value}</strong><small>{detail}</small><span className="metric-link">Open {label.toLowerCase()} <ArrowUpRight size={13} /></span></button>;
}

function Projects({ onNavigate }: { onNavigate: (section: Section) => void }) {
  return <><SectionHeader eyebrow="Build / Projects" title="Projects" description="Deploy from GitHub, connect a domain, and manage each application from one control plane." action={<button className="button button-primary" onClick={() => toast.info("Connect a deployment provider to create a real project.")}><Plus size={16} /> New project</button>} /><div className="panel project-hero"><div className="project-hero-icon"><Box size={23} /></div><div><h2>No projects connected</h2><p>Projects appear here after a deployment provider is connected. USCS will detect the framework, run security checks, and keep deployment state auditable.</p><div className="inline-actions"><button className="button button-primary" onClick={() => onNavigate("Developer")}><Github size={16} /> Connect GitHub</button><button className="button button-secondary" onClick={() => toast.info("Templates require a configured deployment provider.")}><Sparkles size={16} /> Browse templates</button></div></div></div><div className="content-grid three"><InfoCard icon={GitBranch} title="Automatic deployments" text="Preview and production environments with explicit branch controls." /><InfoCard icon={ShieldCheck} title="Secure before ship" text="Dependency, secret, and configuration checks run before production." /><InfoCard icon={ArrowUpRight} title="Rollback-ready" text="Every deployment keeps its state, commit, logs, and rollback path." /></div></>;
}

function Deployments({ onNavigate }: { onNavigate: (section: Section) => void }) {
  return <><SectionHeader eyebrow="Build / Deployments" title="Deployments" description="Track source, build, security checks, and production state without guessing." action={<button className="button button-primary" onClick={() => onNavigate("Projects")}><Plus size={16} /> Start a deployment</button>} /><div className="panel"><div className="pipeline-head"><div><div className="eyebrow">Deployment pipeline</div><h2>Nothing is running</h2><p>Connect GitHub to see real deployment transitions. We will never label a deployment successful without provider confirmation.</p></div><StatusPill>Awaiting source</StatusPill></div><div className="pipeline"><PipelineStep label="Repository connected" icon={Github} /><PipelineStep label="Security scan" icon={ShieldCheck} /><PipelineStep label="Build" icon={Zap} /><PipelineStep label="Production live" icon={Cloud} /></div><div className="empty-inline"><Timer size={17} /><span>Build time, commit, branch, logs, and preview URLs appear after a real deployment.</span></div></div><div className="content-grid two"><InfoCard icon={RefreshCw} title="Rollback" text="Restore a known-good deployment after provider confirmation." /><InfoCard icon={MoreHorizontal} title="Deployment logs" text="Correlate application, build, and security events by request ID." /></div></>;
}

function PipelineStep({ label, icon: Icon }: { label: string; icon: typeof Activity }) { return <div className="pipeline-step"><span className="pipeline-icon"><Icon size={17} /></span><span>{label}</span><span className="pipeline-state">Waiting</span></div>; }

function Domains() {
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  return <><SectionHeader eyebrow="Build / Domains" title="Domains" description="Search, register, transfer, and secure domains through a replaceable registrar provider." action={<button className="button button-secondary" onClick={() => toast.info("A registrar provider is required before transfer or renewal actions are enabled.")}><ExternalLink size={15} /> Provider setup</button>} /><div className="panel domain-search"><div className="eyebrow">Find your domain</div><h2>Search for your perfect domain</h2><p>Availability and pricing are only shown from a live registrar connection.</p><div className="search-row"><div className="input-wrap"><Search size={17} /><input value={query} onChange={e => { setQuery(e.target.value); setSearched(false); }} placeholder="example.com or mycompany.ai" aria-label="Search for a domain" /><button className="clear-input" onClick={() => setQuery("")} aria-label="Clear domain search"><X size={15} /></button></div><button className="button button-primary" onClick={() => { setSearched(true); toast.info("No registrar connected — no availability result was returned."); }}>Search</button></div>{searched && <div className="result-message"><AlertTriangle size={17} /><div><strong>No live result returned</strong><span>{query ? `“${query}” was not checked because no registrar provider is connected.` : "Enter a domain to search after connecting a registrar provider."}</span></div></div>}</div><div className="content-grid three"><InfoCard icon={Globe2} title="Registration" text="Registration, renewal, transfer, WHOIS, and privacy depend on a live provider." /><InfoCard icon={Network} title="DNS & nameservers" text="Manage records and DNSSEC after a domain is attached to a project." /><InfoCard icon={LockKeyhole} title="Secure by default" text="TLS, domain locking, auto-renew, and expiration alerts are explicit controls." /></div></>;
}

function Data() {
  return <><SectionHeader eyebrow="Data" title="Databases & storage" description="Private data services with access controls, backups, and auditable operations." action={<button className="button button-primary" onClick={() => toast.info("Connect a data provider to provision a real resource.")}><Plus size={16} /> Create resource</button>} /><div className="content-grid two data-cards"><ResourceCard icon={Database} title="Databases" subtitle="PostgreSQL" bullets={["Private by default", "Roles and least privilege", "Backups and recovery visibility", "SQL, migrations, and audit logs"]} /><ResourceCard icon={HardDrive} title="Object storage" subtitle="Private buckets" bullets={["Signed URLs", "Lifecycle and retention", "Access policies", "Malware scanning where supported"]} /></div><div className="notice-banner notice-subtle"><div className="notice-icon"><LockKeyhole size={17} /></div><div className="notice-copy"><strong>Security boundary</strong><span>Production credentials never belong in browser code. Provider secrets are stored server-side and are never shown after creation.</span></div></div></>;
}

function ResourceCard({ icon: Icon, title, subtitle, bullets }: { icon: typeof Activity; title: string; subtitle: string; bullets: string[] }) { return <div className="panel resource-card"><div className="resource-head"><span className="resource-icon"><Icon size={20} /></span><div><h2>{title}</h2><span>{subtitle}</span></div><StatusPill>Not connected</StatusPill></div><ul>{bullets.map(b => <li key={b}><Check size={14} />{b}</li>)}</ul><button className="button button-secondary" onClick={() => toast.info(`${title} requires a configured provider.`)}>Configure {title.toLowerCase()} <ArrowUpRight size={14} /></button></div>; }

function Security() {
  return <><SectionHeader eyebrow="Security" title="Security center" description="Protection states are evidence-based. Unknown is better than a made-up score." action={<button className="button button-secondary" onClick={() => toast.info("Security checks require connected resources and providers.")}><RefreshCw size={15} /> Run checks</button>} /><div className="security-state"><div className="security-state-mark"><ShieldCheck size={25} /></div><div><div className="eyebrow">Overall state</div><h2>Configuration required</h2><p>Connect resources before USCS can verify TLS, WAF, DDoS, secrets, access, and backup controls.</p></div><StatusPill tone="warning">Unknown</StatusPill></div><div className="security-grid">{securityChecks.map(([label, status, Icon]) => <div className="security-check" key={label as string}><div className="check-top"><span className="check-icon"><Icon size={17} /></span><StatusPill tone={status === "Ready when connected" ? "muted" : "warning"}>{status as string}</StatusPill></div><strong>{label as string}</strong><p>Evidence will appear after the relevant provider is configured.</p><button className="text-button" onClick={() => toast.info(`${label} is not configured yet.`)}>View control <ArrowUpRight size={13} /></button></div>)}</div><div className="panel audit-panel"><div className="panel-heading"><div><div className="eyebrow">Security audit</div><h2>Append-oriented activity</h2></div><Fingerprint size={18} className="muted-icon" /></div><EmptyState icon={Fingerprint} title="No audit events yet" body="Security-sensitive actions will be recorded with actor, timestamp, resource, result, and correlation ID." /></div></>;
}

function Observability() {
  return <><SectionHeader eyebrow="Observability" title="Logs & performance" description="Searchable logs, metrics, errors, uptime, and alerts with correlation IDs." action={<button className="button button-secondary" onClick={() => toast.info("Export is available after a provider sends real events.")}><ArrowUpRight size={15} /> Export</button>} /><div className="filter-bar"><div className="input-wrap"><Search size={16} /><input placeholder="Search logs, requests, or correlation IDs" aria-label="Search observability" /></div><button className="filter-button">All projects <ChevronDown size={14} /></button><button className="filter-button">All severity <ChevronDown size={14} /></button><button className="filter-button">Last 24 hours <ChevronDown size={14} /></button></div><div className="content-grid three"><InfoCard icon={Activity} title="Logs" text="Application, deployment, and security logs with live updates where supported." /><InfoCard icon={Zap} title="Performance" text="Requests, latency, bandwidth, and status codes from a connected runtime." /><InfoCard icon={Bell} title="Alerts" text="Deployment, uptime, errors, security events, backups, billing, and domain expiry." /></div><div className="panel"><EmptyState icon={Activity} title="No observability data" body="Connect a deployment or runtime provider to start receiving real events. Filters remain available once data exists." action="Configure provider" onAction={() => toast.info("Observability requires a connected runtime provider.")} /></div></>;
}

function Developer() {
  return <><SectionHeader eyebrow="Developer" title="Integrations & secrets" description="Connect source control with minimum scopes and keep environment values server-side." action={<button className="button button-primary" onClick={() => toast.info("GitHub OAuth is not connected in this environment yet.")}><Github size={16} /> Connect GitHub</button>} /><div className="content-grid two"><div className="panel integration-card"><div className="integration-head"><span className="integration-icon github-icon"><Github size={21} /></span><div><h2>GitHub</h2><p>Repositories, branches, webhooks, previews, and commit status.</p></div><StatusPill>Not connected</StatusPill></div><div className="integration-note"><LockKeyhole size={15} /><span>USCS requests only the scopes needed to build and deploy. Tokens are protected, rotatable, and revocable.</span></div><button className="button button-secondary" onClick={() => toast.info("GitHub OAuth requires provider credentials and callback configuration.")}>Configure connection <ArrowUpRight size={14} /></button></div><div className="panel integration-card"><div className="integration-head"><span className="integration-icon"><KeyRound size={21} /></span><div><h2>Environment variables</h2><p>Project-scoped secrets for production, preview, and development.</p></div><StatusPill>Empty</StatusPill></div><div className="secret-list"><div><FileKey2 size={16} /><span>No secrets created</span></div><div><ShieldCheck size={16} /><span>Values are never displayed after creation</span></div><div><Fingerprint size={16} /><span>Access is audit logged</span></div></div><button className="button button-secondary" onClick={() => toast.info("Create a project before adding environment variables.")}>Open secrets manager <ArrowUpRight size={14} /></button></div></div><div className="panel developer-tools"><div className="panel-heading"><div><div className="eyebrow">Developer tooling</div><h2>Build with a clear contract</h2></div><Code2 size={18} className="muted-icon" /></div><div className="tool-row"><TerminalSquare size={17} /><span><strong>CLI</strong><small>Provision and inspect resources with scoped credentials.</small></span><StatusPill>Configuration required</StatusPill></div><div className="tool-row"><BookOpen size={17} /><span><strong>Documentation</strong><small>Architecture, API, security, provider adapters, and recovery guides.</small></span><button className="text-button" onClick={() => toast.info("Documentation workspace will open when published.")}>Open <ArrowUpRight size={14} /></button></div></div></>;
}

function Team({ onNavigate }: { onNavigate: (section: Section) => void }) { return <><SectionHeader eyebrow="Workspace / Team" title="Team & access" description="Separate identity, organization, and infrastructure privileges with explicit roles." action={<button className="button button-primary" onClick={() => toast.info("Invite flow requires an authenticated organization.")}><Plus size={16} /> Invite member</button>} /><div className="panel"><EmptyState icon={UserRound} title="No organization configured" body="Create or connect an organization to manage members, roles, permissions, and audit logs." action="Review settings" onAction={() => onNavigate("Settings")} /></div><div className="content-grid three"><InfoCard icon={UserRound} title="Members" text="Owner, admin, developer, viewer, billing, and security roles." /><InfoCard icon={LockKeyhole} title="Permissions" text="Authorization is enforced server-side, not only in the interface." /><InfoCard icon={Fingerprint} title="Audit logs" text="Role changes and invitations become append-only events." /></div></>; }
function Billing() { return <><SectionHeader eyebrow="Workspace / Billing" title="Billing" description="Subscriptions, usage, domain charges, invoices, and payment methods." action={<button className="button button-secondary" onClick={() => toast.info("Billing requires a real payment provider connection.")}><Settings2 size={15} /> Billing setup</button>} /><div className="panel"><EmptyState icon={Layers3} title="Billing provider not connected" body="No balances, invoices, payment methods, or charges are shown until a real payment provider is configured." action="Configure billing" onAction={() => toast.info("Payment provider configuration is required.")} /></div></>; }
function Settings() { return <><SectionHeader eyebrow="Workspace / Settings" title="Settings" description="Account, organization, security, notifications, privacy, and connected accounts." /><div className="settings-grid">{[[UserRound, "Account", "Profile and session preferences"], [LockKeyhole, "Security", "MFA, recovery, devices, and access"], [Bell, "Notifications", "Alerts and delivery channels"], [Github, "Connected accounts", "OAuth connections and revocation"], [CircleHelp, "Privacy", "Data access and retention"], [AlertTriangle, "Danger zone", "Destructive actions with explicit confirmation"]].map(([Icon, title, body]) => <button className="settings-tile" key={title as string} onClick={() => toast.info(`${title} settings are ready for configuration.`)}><span className="settings-icon"><Icon size={18} /></span><span><strong>{title as string}</strong><small>{body as string}</small></span><ChevronRight size={16} /></button>)}</div><div className="notice-banner notice-subtle"><div className="notice-icon"><LockKeyhole size={17} /></div><div className="notice-copy"><strong>Secure defaults</strong><span>HTTPS, secure cookies, rate limiting, private storage, and audit logging should be enabled where the underlying provider supports them.</span></div></div></>; }

function InfoCard({ title, text }: { icon?: typeof Activity; title: string; text: string }) { return <div className="panel info-card"><h3>{title}</h3><p>{text}</p><span className="info-arrow"><ArrowUpRight size={15} /></span></div>; }

function CommandPalette({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (section: Section) => void }) {
  const [query, setQuery] = useState("");
  const actions = useMemo(() => [...quickActions, { label: "Open billing", section: "Billing" as Section, icon: Layers3 }, { label: "Open settings", section: "Settings" as Section, icon: Settings2 }].filter(a => a.label.toLowerCase().includes(query.toLowerCase())), [query]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); onClose(); } if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [onClose]);
  if (!open) return null;
  return <div className="command-backdrop" onMouseDown={onClose}><div className="command-dialog" onMouseDown={e => e.stopPropagation()}><div className="command-search"><Search size={17} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search USCS" /><kbd>ESC</kbd></div><div className="command-label">Jump to</div>{actions.length ? actions.map(({ label, section, icon: Icon }) => <button className="command-row" key={label} onClick={() => { onNavigate(section); onClose(); }}><span className="quick-icon"><Icon size={16} /></span><span>{label}</span><span className="command-hint">{section}</span></button>) : <div className="command-empty">No matching action.</div>}<div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span></div></div></div>;
}

function LandingPage() {
  const [authOpen, setAuthOpen] = useState(false);
  const openAuth = () => setAuthOpen(true);
  return <div className="landing-page">
    <header className="landing-nav">
      <a className="landing-brand" href="#top" aria-label="USCS home"><span className="brand-mark"><span /></span><span><strong>USCS</strong><small>Unified cloud platform</small></span></a>
      <nav className="landing-links" aria-label="Main navigation"><a href="#platform">Platform</a><a href="#security">Security</a><a href="#developers">Developers</a><a href="#pricing">Pricing</a></nav>
      <div className="landing-actions"><button className="landing-signin" onClick={() => openAuth("signin")}>Sign in</button><button className="landing-cta" onClick={() => openAuth("signup")}>Get started <ArrowUpRight size={15} /></button></div>
    </header>
    <main id="top">
      <section className="landing-hero">
        <div className="hero-copy"><div className="hero-kicker"><span className="live-dot" />The operating system for modern applications</div><h1>Build the web.<br /><em>Without the glue.</em></h1><p>Domains, deployments, databases, storage, and security in one calm, beautifully simple workspace.</p><div className="hero-actions"><button className="landing-cta landing-cta-large" onClick={() => openAuth("signup")}>Create your workspace <ArrowUpRight size={17} /></button><button className="hero-text-button" onClick={() => document.getElementById("platform")?.scrollIntoView({ behavior: "smooth" })}>Explore the platform <ChevronRight size={16} /></button></div><div className="hero-note"><LockKeyhole size={14} /> Secure by default. No fake metrics. No hidden infrastructure surprises.</div></div>
        <div className="hero-visual" aria-label="USCS platform preview"><div className="hero-glow" /><div className="mini-window"><div className="mini-window-bar"><span className="mini-dots"><i /><i /><i /></span><span>app.uscs.io / overview</span><span className="mini-live">PREVIEW</span></div><div className="mini-window-body"><div className="mini-sidebar"><strong>USCS</strong><span className="mini-active">Overview</span><span>Projects</span><span>Domains</span><span>Security</span><span>Settings</span></div><div className="mini-content"><small>CONTROL PLANE / OVERVIEW</small><h3>Ship with confidence.</h3><div className="mini-cards"><div><small>Production</small><strong>Not connected</strong><span className="mini-line" /></div><div><small>Security</small><strong>Configuration</strong><span className="mini-line short" /></div></div><div className="mini-table"><span /><span /><span /><span /></div></div></div></div></div>
      </section>
      <section className="trusted-row"><span>Everything your product needs to run</span><div><b>DOMAINS</b><b>DEPLOYMENTS</b><b>DATA</b><b>SECURITY</b><b>OBSERVABILITY</b></div></section>
      <section className="landing-section" id="platform"><div className="section-intro"><div className="landing-eyebrow">One surface</div><h2>From first commit<br />to production.</h2><p>USCS turns the scattered work of running an application into one clear path. Simple enough for a solo builder, powerful enough for a serious team.</p></div><div className="feature-grid"><article className="feature-card feature-wide"><span className="feature-index">01 / BUILD</span><h3>Deploy without the dance.</h3><p>Connect GitHub, choose a branch, and let USCS detect your framework, run checks, and ship a real deployment.</p><div className="feature-foot"><GitBranch size={16} /> Preview environments · Rollbacks · Logs</div></article><article className="feature-card"><span className="feature-index">02 / OWN</span><h3>Your domain, finally in context.</h3><p>Search, connect DNS, and secure a domain next to the project it belongs to.</p><div className="feature-foot"><Globe2 size={16} /> Registrar-ready architecture</div></article><article className="feature-card"><span className="feature-index">03 / PROTECT</span><h3>Security is the starting line.</h3><p>Private data, scoped access, audit trails, and production checks are designed into the workflow.</p><div className="feature-foot"><ShieldCheck size={16} /> Evidence over empty scores</div></article></div></section>
      <section className="security-section" id="security"><div className="security-copy"><div className="landing-eyebrow">Security, not theatre</div><h2>Nothing is called<br /><em>protected</em> without proof.</h2><p>USCS makes the honest state visible. If a provider is not connected, you see “Configuration required”—not a made-up green check.</p><button className="hero-text-button" onClick={() => openAuth("signin")}>See the control plane <ArrowUpRight size={16} /></button></div><div className="security-list"><div><span>01</span><strong>Private by default</strong><small>Databases, buckets, and secrets start behind an explicit access boundary.</small></div><div><span>02</span><strong>Every action has a trail</strong><small>Deployments, DNS changes, access changes, and security events are auditable.</small></div><div><span>03</span><strong>Providers stay replaceable</strong><small>Your business logic is not locked to one registrar or deployment vendor.</small></div></div></section>
      <section className="final-cta" id="developers"><div><div className="landing-eyebrow">The quiet advantage</div><h2>Less infrastructure<br /><em>in your head.</em></h2><p>Start with a workspace. Add providers when you are ready.</p></div><button className="landing-cta landing-cta-large" onClick={openAuth}>Create your workspace <ArrowUpRight size={17} /></button></section>
    </main>
    <footer className="landing-footer"><span>© 2026 USCS</span><span>Built for people who ship.</span><span><a href="#security">Security</a><a href="#pricing">Pricing</a><button onClick={() => openAuth("signin")}>Sign in</button></span></footer>
    <AuthDialog open={authOpen} initialMode={authMode} onClose={() => setAuthOpen(false)} />
  </div>;
}

function DashboardApp({ user, logout }: { user: ReturnType<typeof useAuth>["user"]; logout: () => void }) {
  const [active, setActive] = useState<Section>("Overview");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const navigate = (section: Section) => { setActive(section); setMobileOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); };
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); } }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, []);
  const page = active === "Overview" ? <Overview onNavigate={navigate} /> : active === "Projects" ? <Projects onNavigate={navigate} /> : active === "Deployments" ? <Deployments onNavigate={navigate} /> : active === "Domains" ? <Domains /> : active === "Data" ? <Data /> : active === "Security" ? <Security /> : active === "Observability" ? <Observability /> : active === "Developer" ? <Developer /> : active === "Team" ? <Team onNavigate={navigate} /> : active === "Billing" ? <Billing /> : <Settings />;
  return <div className="app-shell">
    <CloudNavigation activeSection={active} onNavigate={navigate} collapsed={collapsed} onToggleCollapsed={() => setCollapsed(v => !v)} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} workspaceName={user?.name || "Your workspace"} />
    <main className="main-area"><header className="topbar"><div className="topbar-left"><button className="mobile-menu icon-button" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{getNavigationLabel(active)}</strong></div></div><div className="topbar-actions"><button className="global-search" onClick={() => setCommandOpen(true)}><Search size={16} /><span>Search</span><kbd>⌘ K</kbd></button><button className="icon-button" aria-label="Notifications" onClick={() => toast.info("No new notifications.")}><Bell size={17} /><span className="notification-dot" /></button><button className="user-menu" onClick={() => logout()} title="Sign out"><span className="user-avatar">{(user?.name || "U").slice(0, 1).toUpperCase()}</span><span className="user-name">{user?.name || "Account"}</span><ChevronDown size={14} /></button></div></header><div className="page-content">{page}<footer className="page-footer"><span>USCS control plane</span><span>Secure by default · Provider-agnostic architecture</span><button onClick={() => toast.info("Version details are available in the project documentation.")}><CircleHelp size={14} /> Help</button></footer></div></main><CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} onNavigate={navigate} />
  </div>;
}

export default function Home() {
  const auth = useAuth();
  if (auth.loading) return <div className="auth-loading"><div className="brand-mark"><span /></div><span>Loading your workspace…</span></div>;
  if (!auth.isAuthenticated) return <LandingPage />;
  return <DashboardApp user={auth.user} logout={auth.logout} />;
}
