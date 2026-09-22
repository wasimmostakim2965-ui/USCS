import { useState, type ReactNode } from "react";
import "@/styles/control-plane.css";
import {
  Activity, AlertTriangle, BarChart3, Bell, Box, ChevronDown, ChevronRight, CircleHelp,
  Cloud, Code2, Database, ExternalLink, FileCode2, FolderGit2, Globe2, HardDrive,
  KeyRound, LayoutDashboard, LockKeyhole, Menu, MoreHorizontal, Network, Plus,
  Search, Server, Settings2, ShieldCheck, TerminalSquare, UserRound, Users, X, Zap
} from "lucide-react";
import { toast } from "sonner";

type Page =
  | "Overview" | "Projects" | "Deployments" | "Domains" | "Security"
  | "Observability" | "Firewall" | "Usage" | "Storage" | "Functions" | "Team" | "Billing" | "Settings" | "Help";

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

function Status({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" }) {
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
  const [securityOpen, setSecurityOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [projectSetting, setProjectSetting] = useState("General");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [project, setProject] = useState<string | null>(null);

  const go = (next: Page) => { setPage(next); setMobileOpen(false); window.scrollTo({ top: 0 }); };
  const initials = (user?.name || "U").trim().slice(0, 1).toUpperCase();
  const projectMode = Boolean(project);
  const title = projectSettingsOpen ? "Project Settings" : securityPage !== "Overview" && page === "Security" ? securityPage : page;

  const workspaceItems: { label: Page; icon: typeof LayoutDashboard }[] = [
    { label: "Overview", icon: LayoutDashboard },
    { label: "Projects", icon: FolderGit2 },
    { label: "Deployments", icon: Cloud },
    { label: "Domains", icon: Globe2 },
    { label: "Observability", icon: Activity },
    { label: "Firewall", icon: ShieldCheck },
    { label: "Usage", icon: BarChart3 },
  ];

  const projectItems: { label: Page; icon: typeof LayoutDashboard }[] = [
    { label: "Overview", icon: LayoutDashboard },
    { label: "Deployments", icon: Cloud },
    { label: "Domains", icon: Globe2 },
    { label: "Observability", icon: Activity },
    { label: "Firewall", icon: ShieldCheck },
  ];

  const projectSettings = [
    ["General", "Project identity and runtime defaults"],
    ["Build & Deployment", "Framework, build command and deployment behavior"],
    ["Environment Variables", "Environment-scoped configuration and secrets"],
    ["Git", "Repository, branches, hooks and deploy rules"],
    ["Integrations", "Connected apps and providers"],
    ["Deployment Protection", "Preview and production access controls"],
    ["Functions", "Runtime, memory, timeout and regions"],
    ["Cron Jobs", "Scheduled jobs and execution policy"],
    ["Members", "Project access and roles"],
    ["Webhooks", "Project event delivery"],
    ["Drains", "Logs, traces and analytics destinations"],
    ["Security", "Fork protection, retention and visibility"],
    ["Advanced", "Directory, skew and advanced runtime controls"],
  ];

  return <div className={`cp-shell ${collapsed ? "cp-collapsed" : ""} ${projectMode ? "cp-project-mode" : ""}`}>
    <aside className={`cp-sidebar ${mobileOpen ? "cp-mobile-open" : ""}`}>
      <div className="cp-brand">
        <div className="cp-brand-mark"><span /></div>
        {!collapsed && <button className="cp-brand-workspace" onClick={() => { setProject(null); setProjectSettingsOpen(false); go("Overview"); }}>
          <strong>USCS</strong><span>Workspace</span><ChevronDown size={12} />
        </button>}
        <button className="cp-collapse-button" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={() => setCollapsed(v => !v)}>{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button>
        <button className="cp-mobile-close" onClick={() => setMobileOpen(false)}><X size={18} /></button>
      </div>

      <div className="cp-sidebar-scroll">
        {!collapsed && projectMode ? <div className="cp-project-switcher">
          <button onClick={() => { setProject(null); setProjectSettingsOpen(false); go("Projects"); }}>
            <span className="cp-project-dot" /><span className="cp-project-name">{project}</span><ChevronDown size={12} />
          </button>
        </div> : !collapsed && <div className="cp-workspace-row"><span>Workspace</span><strong>Personal</strong><ChevronDown size={12} /></div>}

        <div className="cp-nav-label">{collapsed ? "" : projectMode ? "Project" : "Workspace"}</div>
        <nav className="cp-nav">
          {(projectMode ? projectItems : workspaceItems).map(item => {
            const Icon = item.icon;
            const active = page === item.label && !projectSettingsOpen;
            return <button key={item.label} className={`cp-nav-item ${active ? "is-active" : ""}`} onClick={() => { setProjectSettingsOpen(false); go(item.label); }}>
              <Icon size={16} /><span>{!collapsed && item.label}</span>
            </button>;
          })}
        </nav>

        {projectMode && !collapsed && <>
          <div className="cp-nav-divider" />
          <div className="cp-nav-label">Project Settings</div>
          <nav className="cp-nav cp-settings-nav">
            {projectSettings.map(([label, detail]) => <button key={label} className={`cp-nav-item cp-nav-settings-item ${projectSettingsOpen && title === label ? "is-active" : ""}`} title={detail}
              onClick={() => { setProjectSetting(label); setProjectSettingsOpen(true); setPage("Settings"); setSecurityPage("Overview"); setMobileOpen(false); }}>
              <Settings2 size={15} /><span>{label}</span>
            </button>)}
          </nav>
        </>}

        {!collapsed && <div className="cp-nav-divider" />}
        <div className="cp-nav-label">{collapsed ? "" : "Manage"}</div>
        <nav className="cp-nav">
          {(projectMode
            ? [{ label: "Team", icon: Users }, { label: "Settings", icon: Settings2 }]
            : [{ label: "Team", icon: Users }, { label: "Settings", icon: Settings2 }]
          ).map(item => {
            const Icon = item.icon;
            return <button key={item.label} className={`cp-nav-item ${page === item.label && !projectSettingsOpen ? "is-active" : ""}`} onClick={() => { setProjectSettingsOpen(false); go(item.label as Page); }}>
              <Icon size={16} /><span>{!collapsed && item.label}</span>
            </button>;
          })}
        </nav>
      </div>

      <div className="cp-sidebar-bottom">
        <button className="cp-help" onClick={() => go("Help")}><CircleHelp size={16} />{!collapsed && "Help"}</button>
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
          <div className="cp-breadcrumb">
            <button onClick={() => { setProject(null); setProjectSettingsOpen(false); go("Overview"); }}>{project ? "Personal" : "USCS"}</button>
            {project && <><ChevronRight size={13} /><button className="cp-crumb-project" onClick={() => go("Overview")}>{project}</button></>}
            <ChevronRight size={13} /><strong>{title}</strong>
          </div>
        </div>
        <div className="cp-top-actions">
          <button className="cp-search" onClick={() => setSearchOpen(true)}><Search size={15} /><span>Search</span><kbd>Ctrl K</kbd></button>
          <button className="cp-icon-button" aria-label="Notifications" onClick={() => toast.info("No new notifications.")}><Bell size={16} /></button>
          <button className="cp-avatar cp-top-avatar" onClick={logout}>{initials}</button>
        </div>
      </header>

      <div className="cp-content">
        {projectSettingsOpen ? <ProjectSettingsPanel project={project || "Project"} settings={projectSettings} selected={projectSetting} onSelect={setProjectSetting} /> :
          page === "Overview" && <Overview onGo={go} onProject={(name) => { setProject(name); go("Overview"); }} project={project} /> }
        {page === "Projects" && !projectSettingsOpen && <Projects onGo={go} onProject={(name) => { setProject(name); go("Overview"); }} />}
        {page === "Deployments" && !projectSettingsOpen && <Deployments onGo={go} />}
        {page === "Domains" && !projectSettingsOpen && <Domains />}
        {page === "Security" && !projectSettingsOpen && <Security page={securityPage} onPage={setSecurityPage} />}
        {page === "Observability" && !projectSettingsOpen && <Observability />}
        {page === "Firewall" && !projectSettingsOpen && <Security page="Firewall" onPage={setSecurityPage} />}
        {page === "Usage" && !projectSettingsOpen && <Billing />}
        {page === "Team" && !projectSettingsOpen && <Team />}
        {page === "Settings" && !projectSettingsOpen && <Settings />}
        {page === "Help" && !projectSettingsOpen && <Help />}
      </div>
    </main>

    {searchOpen && <CommandSearch onClose={() => setSearchOpen(false)} onGo={go} />}
  </div>;
}

function ProjectSettingsPanel({ project, settings, selected, onSelect }: { project: string; settings: string[][]; selected: string; onSelect: (name: string) => void }) {
  const current = settings.find(([name]) => name === selected) || settings[0];
  return <><PageHeader eyebrow={`Project / ${project}`} title={current[0]} description={current[1]} action={<button className="cp-button cp-button-primary" onClick={() => toast.info(`${current[0]} changes will be persisted through the project settings API.`)}>Save changes</button>} />
    <div className="cp-settings-layout">
      <nav className="cp-settings-sidebar">{settings.map(([name, detail]) => <button key={name} className={selected === name ? "active" : ""} onClick={() => onSelect(name)}><span>{name}</span><small>{detail}</small></button>)}</nav>
      <section className="cp-panel cp-settings-editor">
        <div className="cp-panel-head"><div><span>Configuration</span><h2>{current[0]}</h2></div><Status>Not configured</Status></div>
        <div className="cp-settings-body">
          <div className="cp-form-row"><div><strong>Project scope</strong><small>All settings are scoped to the selected project.</small></div><span className="cp-value">{project}</span></div>
          <div className="cp-form-row"><div><strong>Provider state</strong><small>USCS will only display verified provider-backed configuration.</small></div><Status tone="warn">Provider required</Status></div>
          <div className="cp-form-row"><div><strong>{current[0]} controls</strong><small>Configure this surface after its backend provider and audit path are connected.</small></div><button className="cp-button cp-button-secondary" onClick={() => toast.info("This control is staged for the provider integration phase.")}>Configure</button></div>
        </div>
      </section>
    </div>
  </>;
}

function Help() {
  return <><PageHeader eyebrow="Help" title="Help & documentation" description="Find product documentation, API references and operational guidance." />
    <div className="cp-three"><Info title="Documentation" text="Guides for projects, deployments, domains, security and providers." icon={FileCode2} /><Info title="API reference" text="Programmatic access to projects, deployments and infrastructure." icon={Code2} /><Info title="Support" text="Workspace support and incident communication." icon={CircleHelp} /></div>
  </>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="cp-page-header"><div><div className="cp-eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function Overview({ onGo, onProject, project }: { onGo: (p: Page) => void; onProject: (name: string) => void; project: string | null }) {
  if (project) return <>
    <PageHeader eyebrow={`Project / ${project}`} title={project} description="Project overview, production status, recent deployments, resources and project configuration."
      action={<><button className="cp-button cp-button-secondary" onClick={() => onGo("Deployments")}>View deployments</button><button className="cp-button cp-button-primary" onClick={() => toast.info("Import and deployment actions will be connected to the provider API.")}><Plus size={15} /> Deploy</button></>} />
    <div className="cp-scopebar">
      <div><span>Project</span><strong>{project}</strong></div>
      <div><span>Production</span><strong>Not deployed</strong></div>
      <div><span>Environment</span><strong>Preview / Production</strong></div>
      <Status tone="warn">Setup required</Status>
    </div>
    <div className="cp-metrics">
      <Metric label="Deployments" value="0" detail="No deployments yet" onClick={() => onGo("Deployments")} />
      <Metric label="Domains" value="0" detail="Add a custom domain" onClick={() => onGo("Domains")} />
      <Metric label="Requests" value="—" detail="No production traffic" onClick={() => onGo("Observability")} />
      <Metric label="Functions" value="0" detail="View deployment resources" onClick={() => toast.info("Functions appear here after a deployment is connected.")} />
    </div>
    <div className="cp-grid cp-grid-main">
      <section className="cp-panel">
        <div className="cp-panel-head"><div><span>Production</span><h2>Latest deployment</h2></div><button className="cp-text-button" onClick={() => onGo("Deployments")}>Deployments <ArrowIcon /></button></div>
        <Empty icon={Cloud} title="No production deployment" body="Connect a Git repository or deploy with the API/CLI. Production promotion remains an explicit project action." action="Configure Git" onAction={() => { setTimeout(() => {}, 0); toast.info("Git configuration is available in Project Settings → Git."); }} />
      </section>
      <section className="cp-panel">
        <div className="cp-panel-head"><div><span>Project configuration</span><h2>Quick settings</h2></div><Settings2 size={16} className="muted-icon" /></div>
        <div className="cp-checks">
          <CheckRow label="Environment Variables" detail="Configure per environment" />
          <CheckRow label="Deployment Protection" detail="Preview and production access" />
          <CheckRow label="Custom Domains" detail="Attach domains to this project" />
          <CheckRow label="Git integration" detail="Connect repository and branches" />
        </div>
      </section>
    </div>
    <div className="cp-three">
      <Info title="Resources" text="Deployment resources include middleware, static assets and functions with runtime details." icon={Server} />
      <Info title="Observability" text="Inspect logs, errors, requests, metrics and runtime behavior for this project." icon={Activity} />
      <Info title="Security" text="Project protection, firewall rules and deployment access controls stay in project context." icon={ShieldCheck} />
    </div>
  </>;

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
        <div className="cp-panel-head"><div><span>Security</span><h2>Protection status</h2></div><button className="cp-text-button" onClick={() => setPage("Security")}>Open security <ArrowIcon /></button></div>
        <div className="cp-checks">
          <CheckRow label="Origin protection" detail="Waiting for deployment" />
          <CheckRow label="WAF" detail="Not configured" />
          <CheckRow label="DDoS protection" detail="Ready for provider" />
          <CheckRow label="Audit trail" detail="Available for workspace actions" good />
        </div>
      </section>
    </div>
    <section className="cp-panel cp-activity-panel">
      <div className="cp-panel-head"><div><span>Activity</span><h2>Recent workspace activity</h2></div><button className="cp-text-button" onClick={() => toast.info("Activity will populate from the audit log.")}>View activity <ArrowIcon /></button></div>
      <Empty icon={Activity} title="No activity yet" body="Deployments, domain changes, security events and workspace actions will appear here." />
    </section>
  </>;
}
function ArrowIcon() { return <ExternalLink size={13} />; }

function CheckRow({ label, detail, good = false }: { label: string; detail: string; good?: boolean }) {
  return <div className="cp-check-row"><span className={good ? "cp-check cp-check-good" : "cp-check"}>{good ? "✓" : "—"}</span><div><strong>{label}</strong><small>{detail}</small></div><ChevronRight size={14} /></div>;
}

function Projects({ onGo, onProject }: { onGo: (p: Page) => void; onProject: (name: string) => void }) {
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
