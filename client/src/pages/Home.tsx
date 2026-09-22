import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { useLocation } from "wouter";
import { startLogin } from "@/const";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";
import { useAuth } from "@/_core/hooks/useAuth";
import { CloudNavigation, type DomainView, type Section, getNavigationLabel } from "@/components/CloudNavigation";
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
  ScrollText,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Timer,
  UploadCloud,
  UserRound,
  Users,
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
        eyebrow="Workspace / Overview"
        title="Overview"
        description="A clear view of your projects, domains, deployments, and security posture."
        action={<button className="button button-primary" onClick={() => onNavigate("Projects")}><Plus size={16} /> New project</button>}
      />

      <div className="context-strip"><div><span className="context-label">Workspace</span><strong>Personal workspace</strong></div><div><span className="context-label">Environment</span><strong><span className="context-dot" /> Production</strong></div><div><span className="context-label">Region</span><strong>Global</strong></div><StatusPill tone="warning">Setup required</StatusPill></div>

      <div className="metric-grid">
        <MetricCard label="Projects" value="0" detail="No projects yet" onClick={() => onNavigate("Projects")} />
        <MetricCard label="Deployments" value="0" detail="No deployments yet" onClick={() => onNavigate("Deployments")} />
        <MetricCard label="Domains" value="0" detail="No domains yet" onClick={() => onNavigate("Domains")} />
        <MetricCard label="Security" value="Setup" detail="Review workspace controls" onClick={() => onNavigate("Security")} />
      </div>

      <div className="content-grid two-thirds overview-primary-grid">
        <div className="panel setup-panel"><div className="panel-heading"><div><div className="eyebrow">Get started</div><h2>Set up your workspace</h2></div><span className="panel-kicker">3 tasks</span></div><div className="setup-cards">
          <button className="setup-card" onClick={() => onNavigate("Developer")}><span className="setup-card-icon"><Github size={17} /></span><span><strong>Connect GitHub</strong><small>Import a repository and deploy your first project.</small></span><ChevronRight size={16} /></button>
          <button className="setup-card" onClick={() => onNavigate("Domains")}><span className="setup-card-icon"><Globe2 size={17} /></span><span><strong>Buy or connect a domain</strong><small>Search the market or attach a domain to a project.</small></span><ChevronRight size={16} /></button>
          <button className="setup-card" onClick={() => onNavigate("Security")}><span className="setup-card-icon"><ShieldCheck size={17} /></span><span><strong>Review security</strong><small>Set the baseline before production traffic arrives.</small></span><ChevronRight size={16} /></button>
        </div></div>
        <div className="panel quick-panel"><div className="panel-heading"><div><div className="eyebrow">Workspace status</div><h2>Provider connections</h2></div><button className="icon-button" aria-label="Refresh status" onClick={() => toast.info("Provider status refresh requires a connected provider.")}><RefreshCw size={16} /></button></div><div className="provider-list">{statusItems.map(({ label, description, icon: Icon }) => <div className="provider-row" key={label}><span className="provider-icon"><Icon size={17} /></span><span className="provider-copy"><strong>{label}</strong><small>{description}</small></span><StatusPill>Not connected</StatusPill></div>)}</div></div>
      </div>
      <div className="panel activity-panel"><div className="panel-heading"><div><div className="eyebrow">Activity</div><h2>Recent activity</h2></div><button className="text-button" onClick={() => onNavigate("Observability")}>View logs <ArrowUpRight size={14} /></button></div><EmptyState icon={Activity} title="No activity yet" body="Deployments, domain changes, security events, and team actions will appear here." /></div>
    </>
  );
}

function MetricCard({ label, value, detail, onClick }: { label: string; value: string; detail: string; onClick: () => void }) {
  return <button className="metric-card" onClick={onClick}><div className="metric-top"><span>{label}</span></div><strong>{value}</strong><small>{detail}</small><span className="metric-link">Open {label.toLowerCase()} <ArrowUpRight size={13} /></span></button>;
}

function Projects({ onNavigate }: { onNavigate: (section: Section) => void }) {
  return <><SectionHeader eyebrow="Projects" title="Projects" description="Each project is a complete application workspace: source, environments, domains, deployments, secrets, and logs." action={<button className="button button-primary" onClick={() => onNavigate("Developer")}><Github size={16} /> Import repository</button>} /><div className="workspace-toolbar"><div className="toolbar-search"><Search size={15} /><input placeholder="Search projects" aria-label="Search projects" /></div><button className="filter-button">All environments <ChevronDown size={14} /></button><button className="filter-button">All status <ChevronDown size={14} /></button></div><div className="project-empty panel"><div className="project-empty-visual"><div className="project-grid-icon"><Box size={26} /></div><span /><span /><span /></div><div className="project-empty-copy"><div className="eyebrow">No projects yet</div><h2>Start with a repository</h2><p>Import a GitHub repository, choose an environment, and get a verified preview URL. Production promotion stays explicit.</p><div className="inline-actions"><button className="button button-primary" onClick={() => onNavigate("Developer")}><Github size={16} /> Connect GitHub</button><button className="button button-secondary" onClick={() => toast.info("Templates will be available after a deployment provider is connected.")}><Sparkles size={16} /> Use a template</button></div></div></div><div className="project-capabilities content-grid three"><InfoCard icon={GitBranch} title="Git-based workflow" text="Preview every branch and connect production to an explicit release branch." /><InfoCard icon={Globe2} title="Domains in context" text="Attach domains to the project where DNS, TLS, and routing belong." /><InfoCard icon={ShieldCheck} title="Secure before ship" text="Review secrets, dependency checks, and protection before promotion." /></div></>;
}

function Deployments({ onNavigate }: { onNavigate: (section: Section) => void }) {
  return <><SectionHeader eyebrow="Deployments" title="Deployments" description="See what is live, what is in preview, and why a release succeeded or failed." action={<button className="button button-primary" onClick={() => onNavigate("Projects")}><Plus size={16} /> New deployment</button>} /><div className="surface-tabs deployment-tabs"><button className="surface-tab-active"><Activity size={15} /> All</button><button><Cloud size={15} /> Production</button><button><GitBranch size={15} /> Preview</button></div><div className="deployment-summary content-grid three"><div className="stat-panel"><span>Production</span><strong>—</strong><small>No production deployment</small></div><div className="stat-panel"><span>Preview</span><strong>0</strong><small>No preview builds</small></div><div className="stat-panel"><span>Build health</span><strong>—</strong><small>Connect a repository to measure</small></div></div><div className="panel deployment-table"><div className="panel-heading"><div><div className="eyebrow">Release history</div><h2>Deployments</h2></div><button className="filter-button">Last 30 days <ChevronDown size={14} /></button></div><div className="table-empty"><div className="table-empty-row table-head"><span>Deployment</span><span>Environment</span><span>Status</span><span>Created</span></div><EmptyState icon={Layers3} title="No deployments yet" body="Connect GitHub from Projects to see commit, branch, build logs, preview URL, and rollback actions here." action="Open projects" onAction={() => onNavigate("Projects")} /></div></div></>;
}

function PipelineStep({ label, icon: Icon }: { label: string; icon: typeof Activity }) { return <div className="pipeline-step"><span className="pipeline-icon"><Icon size={17} /></span><span>{label}</span><span className="pipeline-state">Waiting</span></div>; }

function Domains({ view, onViewChange }: { view: DomainView; onViewChange: (view: DomainView) => void }) {
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const market = view === "market";
  return <>
    <SectionHeader eyebrow="Workspace / Domains" title={market ? "Find your next domain" : "My domains"} description={market ? "Search availability, compare registrar pricing, and attach a domain to a project." : "Manage the domains owned by this workspace, their nameservers, and project assignments."} action={market ? <button className="button button-secondary" onClick={() => toast.info("Connect a registrar provider to enable domain purchasing.")}><ExternalLink size={15} /> Connect registrar</button> : <button className="button button-primary" onClick={() => onViewChange("market")}><Plus size={16} /> Buy a domain</button>} />
    <div className="surface-tabs" role="tablist" aria-label="Domain workspace">
      <button className={market ? "surface-tab-active" : ""} onClick={() => onViewChange("market")} role="tab" aria-selected={market}><Globe2 size={15} /> Market</button>
      <button className={!market ? "surface-tab-active" : ""} onClick={() => onViewChange("my-domains")} role="tab" aria-selected={!market}><Box size={15} /> My domains</button>
    </div>
    {market ? <>
      <div className="domain-search domain-search-premium">
        <div className="domain-search-copy"><div className="eyebrow">Domain market</div><h2>Own the name people remember.</h2><p>Search any domain. Real availability and price are shown only after a registrar is connected.</p></div>
        <div className="search-row"><div className="input-wrap"><Search size={17} /><input value={query} onChange={e => { setQuery(e.target.value); setSearched(false); }} placeholder="Search for a domain, e.g. acme.com" aria-label="Search for a domain" /><button className="clear-input" onClick={() => setQuery("")} aria-label="Clear domain search"><X size={15} /></button></div><button className="button button-primary" onClick={() => { setSearched(true); toast.info("Connect a registrar to return live availability."); }}>Search</button></div>
        {searched && <div className="result-message"><AlertTriangle size={17} /><div><strong>Registrar connection required</strong><span>{query ? `We did not guess availability for “${query}”. Connect a registrar to search live.` : "Enter a domain to begin a live search."}</span></div></div>}
      </div>
      <div className="content-grid three"><InfoCard icon={Globe2} title="Buy & transfer" text="Register, renew, transfer, and protect domains from one place." /><InfoCard icon={Network} title="DNS & nameservers" text="Manage records, nameservers, DNSSEC, and project routing after purchase." /><InfoCard icon={LockKeyhole} title="Secure by default" text="TLS, domain lock, auto-renew, and expiration alerts are explicit controls." /></div>
    </> : <div className="panel my-domains-panel"><div className="panel-heading"><div><div className="eyebrow">Owned by this workspace</div><h2>Your domains</h2></div><StatusPill>0 domains</StatusPill></div><EmptyState icon={Globe2} title="No domains yet" body="Domains you purchase or transfer will appear here with nameserver, renewal, and project controls." action="Browse domain market" onAction={() => onViewChange("market")} /></div>}
  </>;
}

function Data() {
  return <><SectionHeader eyebrow="Data services" title="Data" description="Provision databases and storage with private defaults, access policy, backup visibility, and lifecycle controls." action={<button className="button button-primary" onClick={() => toast.info("Choose a provider to provision a real resource.")}><Plus size={16} /> Create resource</button>} /><div className="surface-tabs"><button className="surface-tab-active"><Database size={15} /> Databases</button><button><HardDrive size={15} /> Storage</button><button><RefreshCw size={15} /> Backups</button></div><div className="data-health-strip"><div><span>Resources</span><strong>0</strong></div><div><span>Backups</span><strong>—</strong></div><div><span>Private access</span><strong>Default</strong></div><StatusPill tone="success">Secure defaults</StatusPill></div><div className="content-grid two data-cards"><ResourceCard icon={Database} title="PostgreSQL databases" subtitle="Tables, SQL, roles, RLS and migrations" bullets={["Private by default", "Roles and least privilege", "Backups and recovery visibility", "SQL, migrations, and audit logs"]} /><ResourceCard icon={HardDrive} title="Object storage" subtitle="Buckets, files, CDN and retention" bullets={["Signed URLs", "Lifecycle and retention", "Access policies", "Malware scanning where supported"]} /></div><div className="notice-banner notice-subtle"><div className="notice-icon"><LockKeyhole size={17} /></div><div className="notice-copy"><strong>Credentials stay server-side</strong><span>Production keys are scoped, rotatable, and never rendered into browser code.</span></div></div></>;
}

function ResourceCard({ icon: Icon, title, subtitle, bullets }: { icon: typeof Activity; title: string; subtitle: string; bullets: string[] }) { return <div className="panel resource-card"><div className="resource-head"><span className="resource-icon"><Icon size={20} /></span><div><h2>{title}</h2><span>{subtitle}</span></div><StatusPill>Not connected</StatusPill></div><ul>{bullets.map(b => <li key={b}><Check size={14} />{b}</li>)}</ul><button className="button button-secondary" onClick={() => toast.info(`${title} requires a configured provider.`)}>Configure {title.toLowerCase()} <ArrowUpRight size={14} /></button></div>; }

function Security() {
  return <><SectionHeader eyebrow="Security & protection" title="Security center" description="See what is protected, what needs attention, and the exact action required to reach a production baseline." action={<button className="button button-secondary" onClick={() => toast.info("Checks will run after a provider is connected.")}><RefreshCw size={15} /> Run checks</button>} /><div className="security-overview-grid"><div className="security-score-card"><div className="score-ring"><span>—</span></div><div><div className="eyebrow">Workspace posture</div><h2>Not assessed</h2><p>Connect a project or domain to begin evidence-based checks.</p></div></div><div className="security-finding-card"><div className="panel-heading"><div><div className="eyebrow">Prioritized work</div><h2>Next actions</h2></div><StatusPill tone="warning">3 setup items</StatusPill></div><button className="security-action-row" onClick={() => toast.info("Connect a deployment provider to verify TLS and origin protection.")}><LockKeyhole size={16} /><span><strong>Connect a deployment provider</strong><small>Required for TLS, origin and runtime checks</small></span><ChevronRight size={15} /></button><button className="security-action-row" onClick={() => toast.info("Connect a registrar to verify domain security.")}><Globe2 size={16} /><span><strong>Connect a domain provider</strong><small>Required for DNS, WAF and DDoS checks</small></span><ChevronRight size={15} /></button></div></div><div className="security-controls-panel panel"><div className="panel-heading"><div><div className="eyebrow">Control coverage</div><h2>Protection controls</h2></div><button className="filter-button">All controls <ChevronDown size={14} /></button></div><div className="security-control-table">{securityChecks.map(([label, status, Icon]) => <div className="security-control-row" key={label as string}><span className="security-control-icon"><Icon size={16} /></span><span><strong>{label as string}</strong><small>{status === "Ready when connected" ? "Will be verified after provider setup" : "Requires configuration"}</small></span><StatusPill tone="warning">Not assessed</StatusPill><button className="text-button" onClick={() => toast.info(`${label} requires a connected provider.`)}>Configure <ArrowUpRight size={13} /></button></div>)}</div></div><div className="panel audit-panel"><div className="panel-heading"><div><div className="eyebrow">Audit trail</div><h2>Security events</h2></div><Fingerprint size={18} className="muted-icon" /></div><EmptyState icon={Fingerprint} title="No security events" body="Firewall decisions, access changes, policy updates, and provider findings will appear here with actor and correlation ID." /></div></>;
}

function Observability() {
  return <><SectionHeader eyebrow="Observability" title="Observe your systems" description="Move from signal to cause with logs, requests, performance, errors, uptime, and alerts in one workspace." action={<button className="button button-secondary" onClick={() => toast.info("Export is available after a provider sends real events.")}><ArrowUpRight size={15} /> Export</button>} /><div className="observe-tabs surface-tabs"><button className="surface-tab-active"><ScrollText size={15} /> Logs</button><button><Activity size={15} /> Metrics</button><button><AlertTriangle size={15} /> Errors</button><button><Bell size={15} /> Alerts</button></div><div className="workspace-toolbar"><div className="toolbar-search"><Search size={15} /><input placeholder="Search logs, requests, or correlation IDs" aria-label="Search observability" /></div><button className="filter-button">All projects <ChevronDown size={14} /></button><button className="filter-button">All severity <ChevronDown size={14} /></button><button className="filter-button">Last 24 hours <ChevronDown size={14} /></button></div><div className="observe-kpis content-grid three"><div className="stat-panel"><span>Requests</span><strong>—</strong><small>No runtime connected</small></div><div className="stat-panel"><span>Error rate</span><strong>—</strong><small>No events received</small></div><div className="stat-panel"><span>p95 latency</span><strong>—</strong><small>No measurement yet</small></div></div><div className="panel logs-panel"><div className="panel-heading"><div><div className="eyebrow">Event stream</div><h2>Logs</h2></div><StatusPill>Waiting for provider</StatusPill></div><div className="log-table"><div className="log-row log-head"><span>Time</span><span>Level</span><span>Source</span><span>Message</span><span>Request ID</span></div><EmptyState icon={Activity} title="No events received" body="Connect a deployment or runtime provider to start receiving searchable logs and request context." action="Configure provider" onAction={() => toast.info("Observability requires a connected runtime provider.")} /></div></div></>;
}

function Developer() {
  return <><SectionHeader eyebrow="Developer" title="Integrations & secrets" description="Connect source control with minimum scopes and keep environment values server-side." action={<button className="button button-primary" onClick={() => toast.info("GitHub OAuth is not connected in this environment yet.")}><Github size={16} /> Connect GitHub</button>} /><div className="content-grid two"><div className="panel integration-card"><div className="integration-head"><span className="integration-icon github-icon"><Github size={21} /></span><div><h2>GitHub</h2><p>Repositories, branches, webhooks, previews, and commit status.</p></div><StatusPill>Not connected</StatusPill></div><div className="integration-note"><LockKeyhole size={15} /><span>Cloud Wai requests only the scopes needed to build and deploy. Tokens are protected, rotatable, and revocable.</span></div><button className="button button-secondary" onClick={() => toast.info("GitHub OAuth requires provider credentials and callback configuration.")}>Configure connection <ArrowUpRight size={14} /></button></div><div className="panel integration-card"><div className="integration-head"><span className="integration-icon"><KeyRound size={21} /></span><div><h2>Environment variables</h2><p>Project-scoped secrets for production, preview, and development.</p></div><StatusPill>Empty</StatusPill></div><div className="secret-list"><div><FileKey2 size={16} /><span>No secrets created</span></div><div><ShieldCheck size={16} /><span>Values are never displayed after creation</span></div><div><Fingerprint size={16} /><span>Access is audit logged</span></div></div><button className="button button-secondary" onClick={() => toast.info("Create a project before adding environment variables.")}>Open secrets manager <ArrowUpRight size={14} /></button></div></div><div className="panel developer-tools"><div className="panel-heading"><div><div className="eyebrow">Developer tooling</div><h2>Build with a clear contract</h2></div><Code2 size={18} className="muted-icon" /></div><div className="tool-row"><TerminalSquare size={17} /><span><strong>CLI</strong><small>Provision and inspect resources with scoped credentials.</small></span><StatusPill>Configuration required</StatusPill></div><div className="tool-row"><BookOpen size={17} /><span><strong>Documentation</strong><small>Architecture, API, security, provider adapters, and recovery guides.</small></span><button className="text-button" onClick={() => toast.info("Documentation workspace will open when published.")}>Open <ArrowUpRight size={14} /></button></div></div></>;
}

function Team({ onNavigate }: { onNavigate: (section: Section) => void }) { return <><SectionHeader eyebrow="Workspace / Team" title="Team & access" description="Separate identity, organization, and infrastructure privileges with explicit roles." action={<button className="button button-primary" onClick={() => toast.info("Invite flow requires an authenticated organization.")}><Plus size={16} /> Invite member</button>} /><div className="panel"><EmptyState icon={UserRound} title="No organization configured" body="Create or connect an organization to manage members, roles, permissions, and audit logs." action="Review settings" onAction={() => onNavigate("Settings")} /></div><div className="content-grid three"><InfoCard icon={UserRound} title="Members" text="Owner, admin, developer, viewer, billing, and security roles." /><InfoCard icon={LockKeyhole} title="Permissions" text="Authorization is enforced server-side, not only in the interface." /><InfoCard icon={Fingerprint} title="Audit logs" text="Role changes and invitations become append-only events." /></div></>; }
function Billing() { return <><SectionHeader eyebrow="Workspace / Billing" title="Billing" description="Subscriptions, usage, domain charges, invoices, and payment methods." action={<button className="button button-secondary" onClick={() => toast.info("Billing requires a real payment provider connection.")}><Settings2 size={15} /> Billing setup</button>} /><div className="panel"><EmptyState icon={Layers3} title="Billing provider not connected" body="No balances, invoices, payment methods, or charges are shown until a real payment provider is configured." action="Configure billing" onAction={() => toast.info("Payment provider configuration is required.")} /></div></>; }
function Admin() { return <><SectionHeader eyebrow="Workspace / Admin" title="Admin console" description="Governance, provider connections, audit visibility, and workspace-wide controls." action={<button className="button button-secondary" onClick={() => toast.info("Admin actions are restricted to workspace owners.")}><LockKeyhole size={15} /> Access policy</button>} /><div className="notice-banner notice-subtle"><div className="notice-icon"><ShieldCheck size={17} /></div><div className="notice-copy"><strong>Owner access required</strong><span>Administrative changes are protected by role checks on the server. This view is the control surface; it never grants access by itself.</span></div></div><div className="content-grid three"><InfoCard icon={Users} title="People & roles" text="Invite members, review roles, and revoke access with an audit trail." /><InfoCard icon={Cloud} title="Provider connections" text="Manage registrar, deployment, data, and observability integrations." /><InfoCard icon={ScrollText} title="Audit center" text="Review security-sensitive actions and export evidence when connected." /></div><div className="panel admin-table"><div className="panel-heading"><div><div className="eyebrow">Governance</div><h2>Recent administrative activity</h2></div><StatusPill>No events</StatusPill></div><EmptyState icon={Activity} title="No administrative events" body="Workspace changes will appear here once an owner connects a provider or changes access." /></div></>; }
function Settings() { return <><SectionHeader eyebrow="Workspace / Settings" title="Settings" description="Account, organization, security, notifications, privacy, and connected accounts." /><div className="settings-grid">{[[UserRound, "Account", "Profile and session preferences"], [LockKeyhole, "Security", "MFA, recovery, devices, and access"], [Bell, "Notifications", "Alerts and delivery channels"], [Github, "Connected accounts", "OAuth connections and revocation"], [CircleHelp, "Privacy", "Data access and retention"], [AlertTriangle, "Danger zone", "Destructive actions with explicit confirmation"]].map(([Icon, title, body]) => <button className="settings-tile" key={title as string} onClick={() => toast.info(`${title} settings are ready for configuration.`)}><span className="settings-icon"><Icon size={18} /></span><span><strong>{title as string}</strong><small>{body as string}</small></span><ChevronRight size={16} /></button>)}</div><div className="notice-banner notice-subtle"><div className="notice-icon"><LockKeyhole size={17} /></div><div className="notice-copy"><strong>Secure defaults</strong><span>HTTPS, secure cookies, rate limiting, private storage, and audit logging should be enabled where the underlying provider supports them.</span></div></div></>; }

function InfoCard({ title, text }: { icon?: typeof Activity; title: string; text: string }) { return <div className="panel info-card"><h3>{title}</h3><p>{text}</p><span className="info-arrow"><ArrowUpRight size={15} /></span></div>; }

function CommandPalette({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (section: Section) => void }) {
  const [query, setQuery] = useState("");
  const actions = useMemo(() => [...quickActions, { label: "Open billing", section: "Billing" as Section, icon: Layers3 }, { label: "Open settings", section: "Settings" as Section, icon: Settings2 }].filter(a => a.label.toLowerCase().includes(query.toLowerCase())), [query]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); onClose(); } if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [onClose]);
  if (!open) return null;
  return <div className="command-backdrop" onMouseDown={onClose}><div className="command-dialog" onMouseDown={e => e.stopPropagation()}><div className="command-search"><Search size={17} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search Cloud Wai" /><kbd>ESC</kbd></div><div className="command-label">Jump to</div>{actions.length ? actions.map(({ label, section, icon: Icon }) => <button className="command-row" key={label} onClick={() => { onNavigate(section); onClose(); }}><span className="quick-icon"><Icon size={16} /></span><span>{label}</span><span className="command-hint">{section}</span></button>) : <div className="command-empty">No matching action.</div>}<div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span></div></div></div>;
}

function LandingPage() {
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const openAuth = (mode: "signin" | "signup") => {
    setAuthMode(mode);
    setAuthOpen(true);
  };
  return <div className="landing-page">
    <header className="landing-nav">
      <a className="landing-brand" href="#top" aria-label="Cloud Wai home"><span className="brand-mark"><span /></span><span><strong>Cloud Wai</strong><small>Unified cloud platform</small></span></a>
      <nav className="landing-links" aria-label="Main navigation"><a href="#platform">Platform</a><a href="#security">Security</a><a href="#developers">Developers</a><a href="#pricing">Pricing</a></nav>
      <div className="landing-actions"><button className="landing-signin" onClick={() => openAuth("signin")}>Sign in</button><button className="landing-cta" onClick={() => openAuth("signup")}>Get started <ArrowUpRight size={15} /></button></div>
    </header>
    <main id="top">
      <section className="landing-hero">
        <div className="hero-copy"><div className="hero-kicker"><span className="live-dot" />The operating system for modern applications</div><h1>Build the web.<br /><em>Without the glue.</em></h1><p>Domains, deployments, databases, storage, and security in one calm, beautifully simple workspace.</p><div className="hero-actions"><button className="landing-cta landing-cta-large" onClick={() => openAuth("signup")}>Create your workspace <ArrowUpRight size={17} /></button><button className="hero-text-button" onClick={() => document.getElementById("platform")?.scrollIntoView({ behavior: "smooth" })}>Explore the platform <ChevronRight size={16} /></button></div><div className="hero-note"><LockKeyhole size={14} /> Secure by default. No fake metrics. No hidden infrastructure surprises.</div></div>
        <div className="hero-visual" aria-label="Cloud Wai platform preview"><div className="hero-glow" /><div className="mini-window"><div className="mini-window-bar"><span className="mini-dots"><i /><i /><i /></span><span>app.uscs.io / overview</span><span className="mini-live">PREVIEW</span></div><div className="mini-window-body"><div className="mini-sidebar"><strong>Cloud Wai</strong><span className="mini-active">Overview</span><span>Projects</span><span>Domains</span><span>Security</span><span>Settings</span></div><div className="mini-content"><small>CONTROL PLANE / OVERVIEW</small><h3>Ship with confidence.</h3><div className="mini-cards"><div><small>Production</small><strong>Not connected</strong><span className="mini-line" /></div><div><small>Security</small><strong>Configuration</strong><span className="mini-line short" /></div></div><div className="mini-table"><span /><span /><span /><span /></div></div></div></div></div>
      </section>
      <section className="trusted-row"><span>Everything your product needs to run</span><div><b>DOMAINS</b><b>DEPLOYMENTS</b><b>DATA</b><b>SECURITY</b><b>OBSERVABILITY</b></div></section>
      <section className="landing-section" id="platform"><div className="section-intro"><div className="landing-eyebrow">One surface</div><h2>From first commit<br />to production.</h2><p>Cloud Wai turns the scattered work of running an application into one clear path. Simple enough for a solo builder, powerful enough for a serious team.</p></div><div className="feature-grid"><article className="feature-card feature-wide"><span className="feature-index">01 / BUILD</span><h3>Deploy without the dance.</h3><p>Connect GitHub, choose a branch, and let Cloud Wai detect your framework, run checks, and ship a real deployment.</p><div className="feature-foot"><GitBranch size={16} /> Preview environments · Rollbacks · Logs</div></article><article className="feature-card"><span className="feature-index">02 / OWN</span><h3>Your domain, finally in context.</h3><p>Search, connect DNS, and secure a domain next to the project it belongs to.</p><div className="feature-foot"><Globe2 size={16} /> Registrar-ready architecture</div></article><article className="feature-card"><span className="feature-index">03 / PROTECT</span><h3>Security is the starting line.</h3><p>Private data, scoped access, audit trails, and production checks are designed into the workflow.</p><div className="feature-foot"><ShieldCheck size={16} /> Evidence over empty scores</div></article></div></section>
      <section className="security-section" id="security"><div className="security-copy"><div className="landing-eyebrow">Security, not theatre</div><h2>Nothing is called<br /><em>protected</em> without proof.</h2><p>Cloud Wai makes the honest state visible. If a provider is not connected, you see “Configuration required”—not a made-up green check.</p><button className="hero-text-button" onClick={() => openAuth("signin")}>See the control plane <ArrowUpRight size={16} /></button></div><div className="security-list"><div><span>01</span><strong>Private by default</strong><small>Databases, buckets, and secrets start behind an explicit access boundary.</small></div><div><span>02</span><strong>Every action has a trail</strong><small>Deployments, DNS changes, access changes, and security events are auditable.</small></div><div><span>03</span><strong>Providers stay replaceable</strong><small>Your business logic is not locked to one registrar or deployment vendor.</small></div></div></section>
      <section className="final-cta" id="developers"><div><div className="landing-eyebrow">The quiet advantage</div><h2>Less infrastructure<br /><em>in your head.</em></h2><p>Start with a workspace. Add providers when you are ready.</p></div><button className="landing-cta landing-cta-large" onClick={() => openAuth("signup")}>Create your workspace <ArrowUpRight size={17} /></button></section>
    </main>
    <footer className="landing-footer"><span>© 2026 Cloud Wai</span><span>Built for people who ship.</span><span><a href="#security">Security</a><a href="#pricing">Pricing</a><button onClick={() => openAuth("signin")}>Sign in</button></span></footer>
    <AuthDialog open={authOpen} initialMode={authMode} onClose={() => setAuthOpen(false)} />
  </div>;
}

function SubsectionSurface({ label, onNavigate }: { label: string; onNavigate: (section: Section) => void }) {
  const copy: Record<string, [string, string, string]> = {
    "All projects": ["Project workspace", "Projects are the operational unit for deployments, domains, data, and environment configuration.", "Create project"],
    "All deployments": ["Deployment history", "Every preview and production release will show its commit, environment, checks, logs, and rollback path.", "Start a deployment"],
    "Production": ["Production releases", "Promoted releases, live domains, runtime health, and rollback actions belong in this environment.", "Open projects"],
    "Preview": ["Preview environments", "Review branch builds safely before they are promoted to production.", "Connect GitHub"],
    "Tables": ["Table editor", "Browse schemas, relationships, policies, and row-level access for a connected database.", "Configure database"],
    "SQL editor": ["SQL editor", "Run reviewed queries and migrations with scoped credentials and an audit trail.", "Open documentation"],
    "Managed rules": ["Managed WAF rules", "Inspect provider rulesets, action mode, coverage, and the last evaluation result.", "Configure provider"],
    "Custom rules": ["Custom firewall rules", "Create ordered rules with a visible scope, action, preview, and rollback path.", "Review security"],
    "Events": ["Security events", "Investigate blocked requests, matched rules, actor, timestamp, and request context.", "Open observability"],
    "Live logs": ["Live logs", "Search application, deployment, security, and provider events with correlation IDs.", "Configure provider"],
    "Web vitals": ["Web performance", "Track latency and user-facing performance once a runtime sends real measurements.", "Connect deployment"],
    "Members": ["Workspace members", "Invite people with task-based roles and a clear project or workspace scope.", "Open team"],
    "Usage": ["Usage and spend", "See consumption by project, resource, environment, and billing period before cost becomes a surprise.", "Open billing"],
  };
  const [title, description, action] = copy[label] ?? [label, "This workspace is designed for explicit status, permissions, and provider-backed actions.", "Configure provider"];
  return <div className="subsection-surface"><div className="subsection-copy"><div className="eyebrow">{label}</div><h2>{title}</h2><p>{description}</p></div><div className="subsection-actions"><StatusPill>Provider required</StatusPill><button className="button button-secondary" onClick={() => { if (action.includes("project")) onNavigate("Projects"); else if (action.includes("security")) onNavigate("Security"); else if (action.includes("team")) onNavigate("Team"); else if (action.includes("billing")) onNavigate("Billing"); else if (action.includes("observability")) onNavigate("Observability"); else if (action.includes("deployment")) onNavigate("Deployments"); else toast.info(`${action} will be enabled after the provider connection is complete.`); }}>{action} <ArrowUpRight size={14} /></button></div></div>;
}

function FeaturePage({ label, section, onNavigate }: { label: string; section: Section; onNavigate: (section: Section) => void }) {
  const rules = ["Rule name", "Scope", "Action", "Status"];
  const logs = ["Time", "Level", "Source", "Message", "Request ID"];
  const projects = ["Project", "Environment", "Latest deployment", "Status"];
  const generic = ["Resource", "Scope", "Status", "Last updated"];
  const isDomain = section === "Domains";
  const isSecurity = section === "Security";
  const isObserve = section === "Observability";
  const isProject = section === "Projects";
  const columns = isSecurity ? rules : isObserve ? logs : isProject ? projects : generic;
  const title = label === "Market" ? "Domain market" : label === "My domains" ? "My domains" : label;
  const description = label === "Market" ? "Search and register a domain with live provider-backed availability." : label === "My domains" ? "Manage DNS, renewal, security, and project attachment for owned domains." : isSecurity ? "Configure this protection surface with scoped rules, explicit actions, and a complete change history." : isObserve ? "Investigate real events with filters, context, and correlation IDs." : isProject ? "Manage this project surface without losing environment or deployment context." : "Manage this workspace surface with clear status, scope, and next actions.";
  return <><SectionHeader eyebrow={`${section} / ${label}`} title={title} description={description} action={<button className="button button-primary" onClick={() => toast.info(`${label} requires a connected provider before changes can be saved.`)}><Plus size={16} /> {isSecurity ? "Create rule" : isObserve ? "Create alert" : isDomain ? "Add domain" : "Create"}</button>} /><div className="feature-context-bar"><div><span>Scope</span><strong>{isProject ? "Project workspace" : isDomain ? "Domain workspace" : section}</strong></div><div><span>Environment</span><strong>Production</strong></div><StatusPill tone="warning">Provider required</StatusPill></div>{isDomain && label === "Market" ? <div className="panel feature-search-panel"><div className="eyebrow">Search domains</div><h2>Find a name for your next project</h2><p>Availability, pricing, registration, and transfer actions will appear after a registrar is connected.</p><div className="search-row"><div className="input-wrap"><Search size={17} /><input placeholder="example.com" aria-label="Search domains" /></div><button className="button button-primary" onClick={() => toast.info("Connect a registrar for live availability.")}>Search</button></div></div> : <div className="panel feature-table-panel"><div className="panel-heading"><div><div className="eyebrow">{isObserve ? "Event stream" : isSecurity ? "Configuration" : "Resources"}</div><h2>{label}</h2></div><div className="feature-table-actions"><button className="filter-button">All status <ChevronDown size={14} /></button><button className="filter-button">Filter <ChevronDown size={14} /></button></div></div><div className="feature-table"><div className="feature-table-head">{columns.map((column) => <span key={column}>{column}</span>)}</div><EmptyState icon={isSecurity ? ShieldCheck : isObserve ? Activity : isDomain ? Globe2 : isProject ? Box : Layers3} title={`No ${label.toLowerCase()} yet`} body={isDomain && label === "My domains" ? "Domains you purchase or transfer will appear here with DNS, renewal, SSL, and project controls." : `Connect the relevant provider to load real ${label.toLowerCase()} data. Cloud Wai will not show simulated records.`} action={isDomain && label === "My domains" ? "Browse market" : "Configure provider"} onAction={() => isDomain && label === "My domains" ? onNavigate("Domains") : toast.info(`${label} requires provider setup.`)} /></div></div>}{(isSecurity || isObserve || isProject) && <div className="content-grid three feature-supporting-grid"><InfoCard icon={ShieldCheck} title="Scoped access" text="Actions are limited to the active workspace, project, environment, and role." /><InfoCard icon={Activity} title="Auditable state" text="Changes, provider responses, and failures appear with actor and correlation context." /><InfoCard icon={LockKeyhole} title="Safe by default" text="No destructive action is enabled until the provider and permission boundary are verified." /></div>}</>;
}

function DashboardApp({ user, logout }: { user: ReturnType<typeof useAuth>["user"]; logout: () => void }) {
  const [active, setActive] = useState<Section>("Overview");
  const [domainView, setDomainView] = useState<DomainView>("market");
  const [subSection, setSubSection] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const navigate = (section: Section) => { setActive(section); setSubSection(""); setMobileOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); };
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); } }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, []);
  const basePage = active === "Overview" ? <Overview onNavigate={navigate} /> : active === "Projects" ? <Projects onNavigate={navigate} /> : active === "Deployments" ? <Deployments onNavigate={navigate} /> : active === "Domains" ? <Domains view={domainView} onViewChange={setDomainView} /> : active === "Data" ? <Data /> : active === "Security" ? <Security /> : active === "Observability" ? <Observability /> : active === "Developer" ? <Developer /> : active === "Team" ? <Team onNavigate={navigate} /> : active === "Billing" ? <Billing /> : active === "Admin" ? <Admin /> : <Settings />;
  const page = subSection ? <FeaturePage label={subSection} section={active} onNavigate={navigate} /> : basePage;
  return <div className="app-shell">
    <CloudNavigation activeSection={active} onNavigate={navigate} collapsed={collapsed} onToggleCollapsed={() => setCollapsed(v => !v)} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} workspaceName={user?.name || "Your workspace"} domainView={domainView} onDomainView={(view) => { setDomainView(view); setActive("Domains"); setSubSection(view === "market" ? "Market" : "My domains"); }} onSubNavigate={(label) => setSubSection(label)} />
    <main className="main-area"><header className="topbar"><div className="topbar-left"><button className="mobile-menu icon-button" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={20} /></button><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{getNavigationLabel(active)}</strong>{subSection && <><ChevronRight size={14} /><span>{subSection}</span></>}</div></div><div className="topbar-actions"><button className="global-search" onClick={() => setCommandOpen(true)}><Search size={16} /><span>Search</span><kbd>⌘ K</kbd></button><button className="icon-button" aria-label="Notifications" onClick={() => toast.info("No new notifications.")}><Bell size={17} /><span className="notification-dot" /></button><button className="user-menu" onClick={() => logout()} title="Sign out"><span className="user-avatar">{(user?.name || "U").slice(0, 1).toUpperCase()}</span><span className="user-name">{user?.name || "Account"}</span><ChevronDown size={14} /></button></div></header><div className="page-content">{page}<footer className="page-footer"><span>Cloud Wai control plane</span><span>Secure by default · Provider-agnostic architecture</span><button onClick={() => toast.info("Version details are available in the project documentation.")}><CircleHelp size={14} /> Help</button></footer></div></main><CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} onNavigate={navigate} />
  </div>;
}

export function AuthCallback() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const completeOAuth = async () => {
      if (!supabase) {
        if (active) setError("Authentication is not configured for this deployment.");
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      const oauthError = params.get("error_description") || params.get("error");
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

      try {
        if (oauthError) throw new Error(oauthError);
        let exchangedSession: Session | null = null;
        if (code) {
          const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw exchangeError;
          exchangedSession = data.session;
        } else if (hashParams.get("access_token") && hashParams.get("refresh_token")) {
          const { data, error: hashError } = await supabase.auth.setSession({
            access_token: hashParams.get("access_token")!,
            refresh_token: hashParams.get("refresh_token")!,
          });
          if (hashError) throw hashError;
          exchangedSession = data.session;
        }

        const { data: { session: storedSession }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        const session = exchangedSession ?? storedSession;

        if (!session?.user) {
          throw new Error("No authenticated session was returned by Supabase.");
        }

        // Force a fresh app bootstrap after persistence. A client-side route
        // transition can mount Home before Supabase's storage event is visible
        // on mobile Chrome, briefly rendering the public landing page.
        if (active) window.location.replace("/dashboard");
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Unable to complete sign-in.");
        }
      }
    };

    void completeOAuth();
    return () => {
      active = false;
    };
  }, [setLocation]);

  if (error) {
    return (
      <div className="auth-loading" style={{ flexDirection: "column", gap: 12 }}>
        <strong>Sign-in could not be completed</strong>
        <span>{error}</span>
        <button className="button button-primary" onClick={() => setLocation("/")}>Back to sign in</button>
      </div>
    );
  }

  return <div className="auth-loading" aria-label="Completing sign-in" />;
}

export default function Home() {
  const auth = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (auth.loading || !auth.isAuthenticated || typeof window === "undefined") return;
    if (window.location.pathname !== "/dashboard") {
      // Keep the OAuth callback inside the SPA. The Supabase browser session is
      // already restored here, so there is no need to hard-reload the page.
      setLocation("/dashboard");
    }
  }, [auth.loading, auth.isAuthenticated, setLocation]);

  if (auth.loading) return <div className="auth-loading" aria-label="Loading" />;
  if (!auth.isAuthenticated) return <LandingPage />;
  return <DashboardApp user={auth.user} logout={auth.logout} />;
}
