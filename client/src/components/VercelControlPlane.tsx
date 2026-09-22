import { useMemo, useState } from "react";
import {
  Activity, AlertTriangle, BarChart3, Bell, Box, ChevronDown, ChevronRight, CircleHelp,
  Cloud, Code2, Database, ExternalLink, FileCode2, FolderGit2, Globe2, HardDrive,
  KeyRound, LayoutDashboard, LockKeyhole, Menu, MoreHorizontal, Network, Plus,
  Search, Server, Settings2, ShieldCheck, TerminalSquare, UserRound, Users, X, Zap
} from "lucide-react";
import { toast } from "sonner";

type Page =
  | "Overview" | "Projects" | "Deployments" | "Domains" | "Security"
  | "Observability" | "Storage" | "Functions" | "Team" | "Billing" | "Settings";

type SecurityPage = "Overview" | "Firewall" | "WAF" | "DDoS Protection" | "Bot Protection" | "Rate Limiting" | "Access Control" | "Secrets" | "API Security" | "Audit Log";

const nav: { label: string; icon: typeof LayoutDashboard; children?: string[] }[] = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Projects", icon: Box },
  { label: "Deployments", icon: Cloud },
  { label: "Domains", icon: Globe2 },
  { label: "Security", icon: ShieldCheck, children: ["Overview", "Firewall", "WAF", "DDoS Protection", "Bot Protection", "Rate Limiting", "Access Control", "Secrets", "API Security", "Audit Log"] },
  { label: "Observability", icon: Activity },
  { label: "Storage", icon: HardDrive },
  { label: "Functions", icon: TerminalSquare },
];

const utilityNav = [
  { label: "Team", icon: Users },
  { label: "Billing", icon: BarChart3 },
  { label: "Settings", icon: Settings2 },
];

function Status({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" }) {
  return <span className={`cp-status cp-status-${tone}`}><i />{children}</span>;
}

function Metric({ label, value, detail, onClick }: { label: string; value: string; detail: string; onClick?: () => void }) {
  return <button className="cp-metric" onClick={onClick}>
    <span>{label}</span><strong>{value}</strong><small>{detail}</small>
  </button>;
}

function Empty({ icon: Icon, title, body, action, onAction }: { icon: typeof Box; title: string; body: string; action?: string; onAction?: () => void }) {
  return <div className="cp-empty">
    <div className="cp-empty-icon"><Icon size={19} /></div>
    <h3>{title}</h3><p>{body}</p>
    {action && <button className="cp-button cp-button-primary" onClick={onAction}>{action}<ChevronRight size={15} /></button>}
  </div>;
}

export default function VercelControlPlane({ user, logout }: { user: { name?: string | null } | null; logout: () => void }) {
  const [page, setPage] = useState<Page>("Overview");
  const [securityPage, setSecurityPage] = useState<SecurityPage>("Overview");
  const [securityOpen, setSecurityOpen] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const go = (next: Page) => { setPage(next); setMobileOpen(false); window.scrollTo({ top: 0 }); };
  const initials = (user?.name || "U").trim().slice(0, 1).toUpperCase();

  const title = securityPage !== "Overview" && page === "Security" ? securityPage : page;

  return <div className={`cp-shell ${collapsed ? "cp-collapsed" : ""}`}>
    <aside className={`cp-sidebar ${mobileOpen ? "cp-mobile-open" : ""}`}>
      <div className="cp-brand">
        <div className="cp-brand-mark"><span /></div>
        {!collapsed && <><strong>USCS</strong><button className="cp-workspace-switcher" onClick={() => toast.info("Workspace switching will be enabled with organizations.")}>Personal <ChevronDown size={13} /></button></>}
        <button className="cp-mobile-close" onClick={() => setMobileOpen(false)}><X size={18} /></button>
      </div>

      <div className="cp-sidebar-scroll">
        <div className="cp-nav-label">{collapsed ? "" : "Workspace"}</div>
        <nav className="cp-nav">
          {nav.map(item => {
            const active = page === item.label;
            const Icon = item.icon;
            if (item.children) return <div key={item.label} className={`cp-nav-group ${active ? "is-active" : ""}`}>
              <button className="cp-nav-item" onClick={() => { go("Security"); setSecurityOpen(v => !v); }}>
                <Icon size={16} /><span>{!collapsed && item.label}</span>{!collapsed && <ChevronDown className={`cp-nav-chevron ${securityOpen ? "open" : ""}`} size={13} />}
              </button>
              {!collapsed && securityOpen && active && <div className="cp-subnav">
                {item.children.map(child => <button key={child} className={securityPage === child ? "is-active" : ""} onClick={() => { setPage("Security"); setSecurityPage(child as SecurityPage); setMobileOpen(false); }}>
                  <span className="cp-subdot" />{child}
                </button>)}
              </div>}
            </div>;
            return <button key={item.label} className={`cp-nav-item ${active ? "is-active" : ""}`} onClick={() => go(item.label as Page)}>
              <Icon size={16} /><span>{!collapsed && item.label}</span>
            </button>;
          })}
        </nav>

        {!collapsed && <div className="cp-nav-divider" />}
        {!collapsed && <div className="cp-nav-label">Manage</div>}
        <nav className="cp-nav">
          {utilityNav.map(item => {
            const Icon = item.icon;
            return <button key={item.label} className={`cp-nav-item ${page === item.label ? "is-active" : ""}`} onClick={() => go(item.label as Page)}>
              <Icon size={16} /><span>{!collapsed && item.label}</span>
            </button>;
          })}
        </nav>
      </div>

      <div className="cp-sidebar-bottom">
        <button className="cp-help" onClick={() => toast.info("Help center and documentation will be connected here.")}><CircleHelp size={16} />{!collapsed && "Help"}</button>
        <button className="cp-account" onClick={logout}>
          <span className="cp-avatar">{initials}</span>{!collapsed && <span className="cp-account-copy"><strong>{user?.name || "Account"}</strong><small>Sign out</small></span>}
          {!collapsed && <MoreHorizontal size={15} />}
        </button>
      </div>
    </aside>

    <main className="cp-main">
      <header className="cp-topbar">
        <div className="cp-top-left">
          <button className="cp-mobile-menu" onClick={() => setMobileOpen(true)}><Menu size={19} /></button>
          <div className="cp-breadcrumb"><span>Personal</span><ChevronRight size={13} /><strong>{title}</strong></div>
        </div>
        <div className="cp-top-actions">
          <button className="cp-search" onClick={() => setSearchOpen(true)}><Search size={15} /><span>Search</span><kbd>⌘ K</kbd></button>
          <button className="cp-icon-button" aria-label="Notifications" onClick={() => toast.info("No new notifications.")}><Bell size={16} /></button>
          <button className="cp-avatar cp-top-avatar" onClick={logout}>{initials}</button>
        </div>
      </header>

      <div className="cp-content">
        {page === "Overview" && <Overview onGo={go} />}
        {page === "Projects" && <Projects onGo={go} />}
        {page === "Deployments" && <Deployments onGo={go} />}
        {page === "Domains" && <Domains />}
        {page === "Security" && <Security page={securityPage} onPage={setSecurityPage} />}
        {page === "Observability" && <Observability />}
        {page === "Storage" && <ResourcePage title="Storage" icon={HardDrive} description="Buckets, objects, access policies, retention and delivery." />}
        {page === "Functions" && <ResourcePage title="Functions" icon={TerminalSquare} description="Serverless functions, runtime settings, invocations and logs." />}
        {page === "Team" && <Team />}
        {page === "Billing" && <Billing />}
        {page === "Settings" && <Settings />}
      </div>
    </main>

    {searchOpen && <CommandSearch onClose={() => setSearchOpen(false)} onGo={go} />}
  </div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="cp-page-header"><div><div className="cp-eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function Overview({ onGo }: { onGo: (p: Page) => void }) {
  return <>
    <PageHeader eyebrow="Workspace" title="Overview" description="Everything important about your cloud workspace, in one place."
      action={<button className="cp-button cp-button-primary" onClick={() => onGo("Projects")}><Plus size={15} /> New project</button>} />

    <div className="cp-scopebar">
      <div><span>Workspace</span><strong>Personal</strong></div>
      <div><span>Region</span><strong>Global</strong></div>
      <div><span>Environment</span><strong><i className="cp-live-dot" /> Production</strong></div>
      <Status tone="warn">Setup required</Status>
    </div>

    <div className="cp-metrics">
      <Metric label="Projects" value="0" detail="Create your first project" onClick={() => onGo("Projects")} />
      <Metric label="Deployments" value="0" detail="No releases yet" onClick={() => onGo("Deployments")} />
      <Metric label="Domains" value="0" detail="Connect a domain" onClick={() => onGo("Domains")} />
      <Metric label="Requests" value="—" detail="Waiting for traffic" onClick={() => onGo("Observability")} />
    </div>

    <div className="cp-grid cp-grid-main">
      <section className="cp-panel">
        <div className="cp-panel-head"><div><span>Projects</span><h2>Your projects</h2></div><button className="cp-text-button" onClick={() => onGo("Projects")}>View all <ArrowIcon /></button></div>
        <Empty icon={Box} title="Create your first project" body="Import a repository, configure its environment, and get a preview deployment." action="New project" onAction={() => onGo("Projects")} />
      </section>
      <section className="cp-panel">
        <div className="cp-panel-head"><div><span>Security</span><h2>Protection status</h2></div><button className="cp-text-button" onClick={() => onGo("Security")}>Open security <ArrowIcon /></button></div>
        <div className="cp-checks">
          <CheckRow label="Origin protection" detail="Waiting for deployment" />
          <CheckRow label="WAF" detail="Not configured" />
          <CheckRow label="DDoS protection" detail="Ready for provider" />
          <CheckRow label="Audit trail" detail="Available for workspace actions" good />
        </div>
      </section>
    </div>

    <section className="cp-panel cp-activity-panel">
      <div className="cp-panel-head"><div><span>Activity</span><h2>Recent activity</h2></div><button className="cp-icon-button" onClick={() => toast.info("Activity refresh will use the audit log API.")}>↻</button></div>
      <Empty icon={Activity} title="No activity yet" body="Deployments, DNS changes, security events, and team actions will appear here." />
    </section>
  </>;
}

function ArrowIcon() { return <ExternalLink size={13} />; }

function CheckRow({ label, detail, good = false }: { label: string; detail: string; good?: boolean }) {
  return <div className="cp-check-row"><span className={good ? "cp-check cp-check-good" : "cp-check"}>{good ? "✓" : "—"}</span><div><strong>{label}</strong><small>{detail}</small></div><ChevronRight size={14} /></div>;
}

function Projects({ onGo }: { onGo: (p: Page) => void }) {
  return <><PageHeader eyebrow="Projects" title="Projects" description="Applications are the core unit of deployments, domains, environments and runtime configuration."
    action={<button className="cp-button cp-button-primary" onClick={() => toast.info("Repository import will be connected to GitHub.")}><FolderGit2 size={15} /> Import Git repository</button>} />
    <div className="cp-toolbar"><div className="cp-input"><Search size={15} /><input placeholder="Search projects" /></div><button className="cp-filter">All <ChevronDown size={13} /></button><button className="cp-filter">Updated <ChevronDown size={13} /></button></div>
    <section className="cp-panel cp-large-empty"><Empty icon={Box} title="No projects yet" body="Connect GitHub to import a repository. Each project gets deployments, preview environments, domains, logs and settings in context." action="Connect GitHub" onAction={() => toast.info("GitHub connection will be connected here.")} /></section>
    <div className="cp-three"><Info title="Git integration" text="Branches and pull requests become preview deployments." icon={FolderGit2} /><Info title="Project domains" text="Production and preview domains stay attached to the project." icon={Globe2} /><Info title="Environment variables" text="Secrets are scoped by environment and never exposed in client code." icon={KeyRound} /></div>
  </>;
}

function Deployments({ onGo }: { onGo: (p: Page) => void }) {
  return <><PageHeader eyebrow="Deployments" title="Deployments" description="A release-centric view of production and preview environments."
    action={<button className="cp-button cp-button-primary" onClick={() => onGo("Projects")}><Plus size={15} /> New deployment</button>} />
    <div className="cp-tabs"><button className="active">All</button><button>Production</button><button>Preview</button><button>Failed</button></div>
    <div className="cp-three"><Metric label="Production" value="—" detail="No production deployment" /><Metric label="Preview" value="0" detail="No preview deployments" /><Metric label="Build health" value="—" detail="Connect a repository" /></div>
    <section className="cp-panel cp-table-panel"><div className="cp-panel-head"><div><span>Release history</span><h2>Deployments</h2></div><button className="cp-filter">Last 30 days <ChevronDown size={13} /></button></div>
      <div className="cp-table-head"><span>Deployment</span><span>Environment</span><span>Status</span><span>Created</span></div>
      <Empty icon={Cloud} title="No deployments yet" body="When a project is connected, every release will appear here with commit, build logs, preview URL and rollback controls." action="Open projects" onAction={() => onGo("Projects")} />
    </section>
  </>;
}

function Domains() {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"market" | "mine">("market");
  return <><PageHeader eyebrow="Domains" title={tab === "market" ? "Find a domain" : "My domains"} description={tab === "market" ? "Search, register, transfer and secure domains without leaving the control plane." : "Manage ownership, DNS, TLS, renewal and project attachment."}
      action={tab === "market" ? <button className="cp-button cp-button-secondary" onClick={() => toast.info("Registrar connection will be added in the domain provider phase.")}>Connect registrar</button> : <button className="cp-button cp-button-primary" onClick={() => setTab("market")}><Plus size={15} /> Buy domain</button>} />
    <div className="cp-tabs"><button className={tab === "market" ? "active" : ""} onClick={() => setTab("market")}>Market</button><button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>My domains</button></div>
    {tab === "market" ? <section className="cp-domain-search"><div><span>Domain market</span><h2>Find the name before you build.</h2><p>Live availability and pricing will come from the connected registrar. USCS never invents availability.</p></div>
      <div className="cp-search-row"><div className="cp-input"><Globe2 size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="example.com" /></div><button className="cp-button cp-button-primary" onClick={() => toast.info(query ? "Connect a registrar to search live availability." : "Enter a domain first.")}>Search</button></div>
      <div className="cp-domain-features"><Info title="DNS & nameservers" text="Records, nameservers and DNSSEC stay with the domain context." icon={Network} /><Info title="TLS & renewal" text="Certificates, auto-renew and expiration become visible controls." icon={LockKeyhole} /><Info title="Project attachment" text="Attach production domains directly to the project they serve." icon={Box} /></div>
    </section> : <section className="cp-panel"><div className="cp-panel-head"><div><span>Owned by this workspace</span><h2>My domains</h2></div><Status>0 domains</Status></div><Empty icon={Globe2} title="No domains yet" body="Domains purchased or transferred into this workspace will appear here." action="Browse market" onAction={() => setTab("market")} /></section>}
  </>;
}

function Security({ page, onPage }: { page: SecurityPage; onPage: (p: SecurityPage) => void }) {
  if (page === "Overview") return <SecurityOverview onPage={onPage} />;
  const descriptions: Record<SecurityPage, [string, string]> = {
    "Firewall": ["Firewall", "Create ordered request rules with explicit scope, action, preview and rollback."],
    "WAF": ["Web application firewall", "Managed and custom protections for application traffic."],
    "DDoS Protection": ["DDoS protection", "Traffic protection and mitigation controls at the edge."],
    "Bot Protection": ["Bot protection", "Detect, challenge and control automated traffic."],
    "Rate Limiting": ["Rate limiting", "Protect authentication and API endpoints from abusive request volume."],
    "Access Control": ["Access control", "Manage trusted identities, roles and protected resources."],
    "Secrets": ["Secrets", "Environment-scoped credentials with rotation and audit visibility."],
    "API Security": ["API security", "Protect APIs with authentication, schema and token controls."],
    "Audit Log": ["Security audit log", "Every security configuration change with actor, time and scope."],
    "Overview": ["Security", "Security overview"],
  };
  const [title, desc] = descriptions[page];
  return <><PageHeader eyebrow={`Security / ${page}`} title={title} description={desc} action={<button className="cp-button cp-button-primary" onClick={() => toast.info("This control will be enabled after the security provider layer is connected.")}><Plus size={15} /> Create rule</button>} />
    <div className="cp-security-context"><Status tone="warn">Provider required</Status><span>Scope: workspace</span><span>Environment: production</span></div>
    <section className="cp-panel cp-table-panel"><div className="cp-panel-head"><div><span>Configuration</span><h2>{title}</h2></div><button className="cp-filter">All status <ChevronDown size={13} /></button></div><div className="cp-table-head"><span>Name</span><span>Scope</span><span>Action</span><span>Status</span></div><Empty icon={ShieldCheck} title={`No ${page.toLowerCase()} configured`} body="USCS will show provider-backed state here. No simulated rules or fake security metrics." action="Open security overview" onAction={() => onPage("Overview")} /></section>
  </>;
}

function SecurityOverview({ onPage }: { onPage: (p: SecurityPage) => void }) {
  const findings = [
    ["Origin protection", "Connect a deployment provider", LockKeyhole],
    ["WAF baseline", "Managed rules not configured", ShieldCheck],
    ["DDoS protection", "Ready for edge provider", Zap],
    ["MFA enforcement", "Workspace security setting", KeyRound],
  ] as const;
  return <><PageHeader eyebrow="Security" title="Security overview" description="A control-plane view of protection, findings and security configuration."
    action={<button className="cp-button cp-button-secondary" onClick={() => toast.info("Security checks will run against connected providers.")}>Run checks</button>} />
    <div className="cp-security-hero"><div className="cp-security-score"><span>—</span><small>Not assessed</small></div><div><div className="cp-eyebrow">Workspace posture</div><h2>Build the protection boundary first.</h2><p>Security state is evidence-based. A control is only marked active when USCS can verify it.</p></div></div>
    <section className="cp-panel"><div className="cp-panel-head"><div><span>Action items</span><h2>What needs attention</h2></div><Status tone="warn">4 items</Status></div>
      <div className="cp-findings">{findings.map(([label, detail, Icon]) => <button key={label} onClick={() => onPage(label === "WAF baseline" ? "WAF" : label === "DDoS protection" ? "DDoS Protection" : label === "MFA enforcement" ? "Access Control" : "Firewall")}><span className="cp-finding-icon"><Icon size={16} /></span><span><strong>{label}</strong><small>{detail}</small></span><ChevronRight size={15} /></button>)}</div>
    </section>
    <div className="cp-three"><Info title="Firewall" text="Ordered request rules, IP controls and rate limits." icon={Network} onClick={() => onPage("Firewall")} /><Info title="WAF" text="Managed and custom web application protections." icon={ShieldCheck} onClick={() => onPage("WAF")} /><Info title="API security" text="Token, schema and endpoint protection." icon={Code2} onClick={() => onPage("API Security")} /></div>
  </>;
}

function Observability() {
  return <><PageHeader eyebrow="Observability" title="Observability" description="Understand requests, errors, logs and runtime health from one operational surface." action={<button className="cp-button cp-button-secondary" onClick={() => toast.info("Observability data will appear after a runtime is connected.")}>Refresh</button>} />
    <div className="cp-tabs"><button className="active">Overview</button><button>Logs</button><button>Metrics</button><button>Errors</button><button>Requests</button><button>Uptime</button></div>
    <div className="cp-three"><Metric label="Requests" value="—" detail="Waiting for traffic" /><Metric label="Errors" value="—" detail="No runtime data" /><Metric label="Latency" value="—" detail="No measurements" /></div>
    <section className="cp-panel"><div className="cp-panel-head"><div><span>Event stream</span><h2>Logs</h2></div><button className="cp-filter">Last 30 minutes <ChevronDown size={13} /></button></div><Empty icon={Activity} title="No logs yet" body="Connect a deployment or runtime to see searchable logs with timestamp, level, source and request ID." /></section>
  </>;
}

function ResourcePage({ title, icon: Icon, description }: { title: string; icon: typeof Box; description: string }) {
  return <><PageHeader eyebrow={title} title={title} description={description} action={<button className="cp-button cp-button-primary" onClick={() => toast.info(`${title} provisioning will be connected in the provider phase.`)}><Plus size={15} /> Create</button>} />
    <section className="cp-panel cp-large-empty"><Empty icon={Icon} title={`No ${title.toLowerCase()} yet`} body="Resources will appear here once the provider connection and server-side provisioning path are enabled." action="Configure provider" onAction={() => toast.info("Provider configuration will be added next.")} /></section>
  </>;
}

function Team() {
  return <><PageHeader eyebrow="Team" title="Members & roles" description="Control who can access the workspace and what they are allowed to change." action={<button className="cp-button cp-button-primary" onClick={() => toast.info("Member invitations will be connected to the RBAC backend.")}><Plus size={15} /> Invite member</button>} />
    <section className="cp-panel"><div className="cp-panel-head"><div><span>Workspace access</span><h2>Members</h2></div><Status>1 owner</Status></div><div className="cp-member-row"><span className="cp-avatar">U</span><div><strong>{`${"Workspace owner"}`}</strong><small>Owner · full workspace access</small></div><span className="cp-role">Owner</span></div></section>
  </>;
}

function Billing() {
  return <><PageHeader eyebrow="Billing" title="Usage & billing" description="Understand consumption, invoices and payment configuration before production scale." action={<button className="cp-button cp-button-secondary" onClick={() => toast.info("Billing provider connection will be added later.")}>Billing settings</button>} />
    <div className="cp-three"><Metric label="Current usage" value="—" detail="No billable resources" /><Metric label="This period" value="$0" detail="No charges" /><Metric label="Plan" value="Free" detail="Workspace plan" /></div>
    <section className="cp-panel cp-large-empty"><Empty icon={BarChart3} title="No billing activity" body="Usage and invoices will appear here once billable providers and resources are connected." /></section>
  </>;
}

function Settings() {
  const items = ["General", "Security & Privacy", "Authentication", "Connected providers", "Notifications", "API keys", "Danger zone"];
  return <><PageHeader eyebrow="Settings" title="Workspace settings" description="Configure account, security, integrations and operational preferences." />
    <div className="cp-settings-list">{items.map((item, i) => <button key={item} onClick={() => toast.info(`${item} settings will be connected to the backend in the implementation phase.`)}><span><strong>{item}</strong><small>{i === 1 ? "MFA, sessions and security policy" : i === 2 ? "OAuth providers and authentication policy" : "Workspace configuration"}</small></span><ChevronRight size={15} /></button>)}</div>
  </>;
}

function Info({ title, text, icon: Icon, onClick }: { title: string; text: string; icon: typeof Box; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return <Tag className="cp-info" onClick={onClick}><span className="cp-info-icon"><Icon size={17} /></span><strong>{title}</strong><p>{text}</p>{onClick && <ChevronRight size={14} />}</Tag>;
}

function CommandSearch({ onClose, onGo }: { onClose: () => void; onGo: (p: Page) => void }) {
  const items: { label: string; page: Page }[] = [...nav.filter(x => x.label !== "Security").map(x => ({ label: x.label, page: x.label as Page })), ...utilityNav.map(x => ({ label: x.label, page: x.label as Page })), { label: "Security", page: "Security" }];
  return <div className="cp-command-backdrop" onMouseDown={onClose}><div className="cp-command" onMouseDown={e => e.stopPropagation()}><div className="cp-command-input"><Search size={16} /><input autoFocus placeholder="Search USCS" /><kbd>ESC</kbd></div><div className="cp-command-list">{items.map(({ label, page }) => <button key={label} onClick={() => { onGo(page); onClose(); }}><span>{label}</span><ChevronRight size={14} /></button>)}</div></div></div>;
}
