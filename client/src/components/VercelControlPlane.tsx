import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import "@/styles/control-plane.css";
import {
  Activity, BarChart3, Bell, Bot, Box, ChevronDown, ChevronRight, CircleHelp,
  Cloud, Code2, Database, ExternalLink, Eye, FileCode2, Flag, FolderGit2,
  Globe2, HardDrive, Images, KeyRound, LayoutDashboard, Link2, ListFilter,
  LockKeyhole, Menu, MoreHorizontal, Network, Plus, Rocket, Search, Server,
  Settings2, ShieldCheck, Sparkles, Store, TerminalSquare, Users, Workflow, X, Zap, RefreshCw
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { dashboardNav, dashboardPageFromSlug, dashboardPath, type DashboardPage } from "@/pages/dashboard/navigation";

type Page = DashboardPage | "Connect" | "Storage" | "Usage" | "Support";
type Icon = typeof LayoutDashboard;
type ProjectTab = "Overview" | "Deployments" | "Domains" | "Logs" | "Observability" | "Firewall" | "Settings";
type DeploymentTab = "Deployment" | "Logs" | "Resources" | "Source" | "Open Graph";

const projectSettings = ["General","Build & Deployment","Environment Variables","Git","Integrations","Deployment Protection","Functions","Cron Jobs","Members","Webhooks","Drains","Security","Advanced"];

const pageFromSlug = (slug: string | undefined): Page => {
  if (slug === "data") return "Storage";
  if (slug === "developer") return "Connect";
  if (slug === "billing") return "Usage";
  return dashboardPageFromSlug(slug);
};

function Status({children,good=false}:{children:ReactNode;good?:boolean}) {
  return <span className={`vc-status ${good?"good":""}`}><i/>{children}</span>;
}
function Header({title,crumb,action}:{title:string;crumb?:string;action?:ReactNode}) {
  return <div className="vc-page-head"><div><div className="vc-crumb">{crumb||title}</div><h1>{title}</h1></div>{action}</div>;
}
function Empty({title,body,action,onAction}:{title:string;body:string;action?:string;onAction?:()=>void}) {
  return <div className="vc-empty"><div className="vc-empty-mark"><Box size={20}/></div><h3>{title}</h3><p>{body}</p>{action&&<button className="vc-btn primary" onClick={onAction||(()=>toast.info(action))}>{action}<ChevronRight size={14}/></button>}</div>;
}
function Row({icon:Icon,title,detail,onClick}:{icon:Icon;title:string;detail?:string;onClick?:()=>void}) {
  return <button className="vc-list-row" onClick={onClick||(()=>toast.info(title))}><Icon size={16}/><span><strong>{title}</strong>{detail&&<small>{detail}</small>}</span><ChevronRight size={14}/></button>;
}
function Stat({label,value}:{label:string;value:string}) { return <div className="vc-stat"><small>{label}</small><strong>{value}</strong></div>; }
function Meta({k,v,good}:{k:string;v:string;good?:boolean}) { return <div className="vc-meta"><small>{k}</small><strong className={good?"green":""}>{v}</strong></div>; }

export default function VercelControlPlane({user,logout}:{user:{id?:string|null;name?:string|null;email?:string|null;loginMethod?:string|null;role?:string|null}|null;logout:()=>void}) {
  const [location, setLocation] = useLocation();
  const [projectTab,setProjectTab]=useState<ProjectTab>("Overview");
  const [deploymentTab,setDeploymentTab]=useState<DeploymentTab>("Deployment");
  const [collapsed,setCollapsed]=useState(false);
  const [mobile,setMobile]=useState(false);
  const [search,setSearch]=useState("");
  const [openGroups,setOpenGroups]=useState<string[]>([]);
  const [accountOpen,setAccountOpen]=useState(false);
  const [accountPanel,setAccountPanel]=useState<"account"|"api"|"settings"|null>(null);
  const initials=(user?.name||"U").trim().slice(0,1).toUpperCase();

  const routeParts = location.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);
  const page = pageFromSlug(routeParts[0]);
  const project = page === "Projects" && routeParts.length > 1;
  const deploymentOpen = page === "Deployments" && routeParts.length > 1;
  const go=(p:Page)=>{setLocation(`/dashboard/${dashboardPath((p === "Storage" ? "Data" : p === "Connect" ? "Developer" : p === "Usage" ? "Billing" : p) as DashboardPage)}`);setMobile(false);window.scrollTo({top:0});};
  const openProject=(id?:string)=>{setLocation(`/dashboard/projects/${id ?? "new"}`);setProjectTab("Overview");setMobile(false);};
  const toggleGroup=(label:string)=>setOpenGroups(v=>v.includes(label)?v.filter(x=>x!==label):[...v,label]);

  const content = project
    ? <ProjectView tab={projectTab} setTab={setProjectTab} deploymentTab={deploymentTab} setDeploymentTab={setDeploymentTab} deploymentOpen={deploymentOpen} setDeploymentOpen={(open)=>open?setLocation("/dashboard/projects/current/deployments/current"):setLocation("/dashboard/projects/current")}/>
    : page==="Overview" ? <Overview onProjects={()=>go("Projects")} onOpenProject={openProject}/>
    : page==="Projects" ? <Projects onOpen={openProject}/>
    : page==="Deployments" ? (deploymentOpen?<GlobalDeploymentDetail deploymentTab={deploymentTab} setDeploymentTab={setDeploymentTab} onBack={()=>go("Deployments")}/>:<Deployments onOpen={(id)=>{setDeploymentTab("Deployment");setLocation(`/dashboard/deployments/${id ?? "current"}`)}}/>)
    : page==="Observability" ? <Observability/>
    : page==="Security" ? <SecurityCenter/>
    : page==="Domains" ? <Domains/>
    : page==="Connect" ? <Connect/>
    : page==="Storage" ? <Storage/>
    : page==="Usage" ? <Usage/>
    : <WorkspaceSettings/>;

  return <div className={`vc-shell ${collapsed?"collapsed":""}`}>
    <aside className={`vc-sidebar ${mobile?"mobile":""}`}>
      <div className="vc-brand">
        <div className="vc-brand-dot">U</div>
        <button className="vc-team" onClick={()=>toast.info("Workspace switcher will list connected workspaces.")}><strong>Cloud Wai</strong><span>Workspace</span><ChevronDown size={11}/></button>
        <button className="vc-collapse" onClick={()=>setCollapsed(v=>!v)} aria-label="Toggle sidebar"><ChevronRight size={15}/></button>
        <button className="vc-close" onClick={()=>setMobile(false)}><X size={18}/></button>
      </div>
      <div className="vc-find"><Search size={14}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Find"/><kbd>Ctrl K</kbd></div>
      <div className="vc-nav">
        {dashboardNav.filter(x=>!search||x.label.toLowerCase().includes(search.toLowerCase())).map(({label,icon:Icon})=><div key={label}>
          <button className={`vc-nav-item ${page===label || (label === "Data" && page === "Storage") || (label === "Developer" && page === "Connect") || (label === "Billing" && page === "Usage") ? "active":""}`} onClick={()=>go(label)}>
            <Icon size={15}/><span>{label}</span>
          </button>
        </div>)}
      </div>
      <div className="vc-nav-bottom">
        <span className="vc-nav-note">Connected control plane</span>
      </div>
      <div className="vc-account-wrap">
        <button className="vc-account" onClick={()=>setAccountOpen(v=>!v)}><span>{initials}</span><div><strong>{user?.name||"Account"}</strong><small>Account menu</small></div><MoreHorizontal size={15}/></button>
        {accountOpen&&<div className="vc-account-menu">
          <button onClick={()=>{setAccountPanel("account");setAccountOpen(false)}}>Account</button>
          <button onClick={()=>{setAccountPanel("api");setAccountOpen(false)}}>API Tokens</button>
          <button onClick={()=>{setAccountPanel("settings");setAccountOpen(false)}}>Account Settings</button>
          <button onClick={logout}>Sign out</button>
        </div>}
      </div>
    </aside>
    <main className="vc-main">
      <header className="vc-topbar">
        <button className="vc-mobile-menu" onClick={()=>setMobile(true)}><Menu size={19}/></button>
        <div className="vc-top-crumb"><button onClick={()=>go("Overview")}>Cloud Wai</button>{project&&<><ChevronRight size={13}/><strong>Cloud Wai</strong></>}</div>
        <div className="vc-top-actions"><button className="vc-top-icon" onClick={()=>toast.info("Notifications")}><Bell size={16}/></button><button className="vc-top-icon" onClick={()=>go("Support")}><CircleHelp size={16}/></button><button className="vc-avatar" onClick={()=>setAccountOpen(v=>!v)}>{initials}</button></div>
      </header>
      <div className="vc-content">{content}</div>
    </main>
    {accountPanel&&<AccountCenter panel={accountPanel} onClose={()=>setAccountPanel(null)} user={user}/>}\n  </div>;
}

function Overview({onProjects,onOpenProject}:{onProjects:()=>void;onOpenProject:(id?:string)=>void}) {
  const projectsQuery = trpc.workspace.projects.list.useQuery(undefined,{retry:false});
  const projects = projectsQuery.data ?? [];
  return <><Header title="Overview" action={<button className="vc-btn primary" onClick={onProjects}><Plus size={14}/> Add New <ChevronDown size={13}/></button>}/>
    <div className="vc-card vc-recent"><div className="vc-tabs"><button className="active">Recents</button><button onClick={()=>toast.info("Usage opens from the sidebar.")}>Usage</button><button onClick={()=>toast.info("Alerts will populate from audit and provider events.")}>Alerts</button></div>{projectsQuery.isLoading?<div className="vc-loading-row">Loading workspace data…</div>:<Empty title="No recent activity" body="Deployments, project changes and alerts will appear here when Cloud Wai has activity." action="Open Projects" onAction={onProjects}/>}</div>
    <div className="vc-section-title">Projects</div>
    {projects.length?projects.map(p=><div className="vc-project-card" key={p.id} onClick={()=>onOpenProject(p.id)}><div className="vc-project-logo">U</div><div><strong>{p.name}</strong><small>{p.slug}</small><p>Cloud Wai workspace · {new Date(p.updated_at).toLocaleDateString()}</p></div><Status good>Connected</Status></div>):<div className="vc-card"><Empty title="No projects yet" body="Create a project to connect repositories, deployments, domains and runtime resources."/></div>}
  </>;
}

function Projects({onOpen}:{onOpen:(id?:string)=>void}) {
  const projectsQuery = trpc.workspace.projects.list.useQuery(undefined,{retry:false});
  const orgQuery = trpc.workspace.organizations.useQuery(undefined,{retry:false});
  const createProject = trpc.workspace.projects.create.useMutation({onSuccess:()=>{void projectsQuery.refetch();toast.success("Project created");},onError:e=>toast.error(e.message)});
  const [q,setQ]=useState("");
  const projects=(projectsQuery.data??[]).filter(p=>p.name.toLowerCase().includes(q.toLowerCase())||p.slug.toLowerCase().includes(q.toLowerCase()));
  const add=()=>{const name=window.prompt("Project name");const org=orgQuery.data?.[0];if(!name?.trim())return;if(!org){toast.error("No workspace is available");return;}createProject.mutate({organizationId:org.id,name:name.trim()});};
  return <><Header title="Projects" crumb="All Projects" action={<button className="vc-btn primary" onClick={add}><Plus size={14}/> Add New <ChevronDown size={13}/></button>}/>
    <div className="vc-project-toolbar"><div className="vc-search-input"><Search size={15}/><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search Projects"/></div><button className="vc-icon-btn" onClick={()=>toast.info("Filters: framework, status, updated time")}><ListFilter size={15}/></button></div>
    <div className="vc-card vc-project-recent"><div className="vc-tabs"><button className="active">Recents</button><button onClick={()=>toast.info("Usage opens from the sidebar.")}>Usage</button><button onClick={()=>toast.info("Alerts come from audit and provider events.")}>Alerts</button></div>{projectsQuery.isLoading?<div className="vc-loading-row">Loading projects…</div>:<Empty title={projects.length?"Project activity":"No recent project activity"} body="Deployment, configuration and security events will appear here when connected providers produce activity."/>}</div>
    <div className="vc-section-title">Projects</div>
    {projects.length?projects.map(p=><div className="vc-project-card" key={p.id} onClick={()=>onOpen(p.id)}><div className="vc-project-logo">U</div><div><strong>{p.name}</strong><small>{p.slug}</small><p>Cloud Wai workspace · {new Date(p.updated_at).toLocaleDateString()}</p></div><Status good>Ready</Status></div>):<div className="vc-card"><Empty title="No projects yet" body="Create a project to connect repositories, deployments, domains and runtime resources." action="Add New" onAction={add}/></div>}
  </>;
}

function ProjectView({tab,setTab,deploymentTab,setDeploymentTab,deploymentOpen,setDeploymentOpen}:{tab:ProjectTab;setTab:(x:ProjectTab)=>void;deploymentTab:DeploymentTab;setDeploymentTab:(x:DeploymentTab)=>void;deploymentOpen:boolean;setDeploymentOpen:(x:boolean)=>void}) {
  return <><Header title="uscs" crumb="Projects / uscs" action={<div className="vc-actions"><button className="vc-btn" onClick={()=>toast.info("Share project")}>Share</button><button className="vc-btn primary" onClick={()=>toast.info("Deploy: connect Git or choose a commit")}>Deploy</button><button className="vc-icon-btn" onClick={()=>toast.info("Project actions")}><MoreHorizontal size={15}/></button></div>}/>
    <div className="vc-project-tabs">{(["Overview","Deployments","Domains","Logs","Observability","Firewall","Settings"] as const).map(t=><button key={t} className={tab===t?"active":""} onClick={()=>setTab(t)}>{t}</button>)}</div>
    {tab==="Overview"&&<><div className="vc-card vc-deploy-hero"><div><span className="vc-eyebrow">Production</span><h2>No production deployment</h2><p>Connect GitHub or deploy with the CLI/API to create a release.</p></div><button className="vc-btn primary" onClick={()=>setTab("Deployments")}>Deploy</button></div><div className="vc-grid-3"><Stat label="Deployments" value="0"/><Stat label="Domains" value="0"/><Stat label="Requests" value="—"/></div><div className="vc-grid-2"><div className="vc-card"><h3>Latest deployment</h3><Empty title="No deployments yet" body="Deployment history will appear with commit, build logs, resources and rollback actions." action="Open Deployments" onAction={()=>setTab("Deployments")}/></div><div className="vc-card"><h3>Project configuration</h3><Row icon={KeyRound} title="Environment Variables" detail="Per environment" onClick={()=>toast.info("Open Settings → Environment Variables")}/><Row icon={ShieldCheck} title="Deployment Protection" detail="Access controls" onClick={()=>toast.info("Open Settings → Deployment Protection")}/><Row icon={Globe2} title="Domains" detail="Custom domains" onClick={()=>setTab("Domains")}/></div></div></>}
    {tab==="Deployments"&&(deploymentOpen?<DeploymentDetail deploymentTab={deploymentTab} setDeploymentTab={setDeploymentTab}/>:<Deployments onOpen={()=>{setDeploymentTab("Deployment");setDeploymentOpen(true)}}/>)}
    {tab==="Domains"&&<Domains project/>}
    {tab==="Logs"&&<Logs/>}
    {tab==="Observability"&&<Observability/>}
    {tab==="Firewall"&&<Firewall/>}
    {tab==="Settings"&&<ProjectSettings/>}
  </>;
}

function DeploymentDetail({deploymentTab,setDeploymentTab}:{deploymentTab:DeploymentTab;setDeploymentTab:(x:DeploymentTab)=>void}) {
  return <div className="vc-card vc-deployment-detail"><div className="vc-subtabs">{(["Deployment","Logs","Resources","Source","Open Graph"] as const).map(t=><button className={deploymentTab===t?"active":""} key={t} onClick={()=>setDeploymentTab(t)}>{t}</button>)}</div>
    {deploymentTab==="Deployment"&&<><div className="vc-detail-actions"><span>Deployment Details</span><div><button className="vc-btn" onClick={()=>toast.info("Share deployment")}>Share</button><button className="vc-btn" onClick={()=>setDeploymentTab("Logs")}>Logs</button><button className="vc-btn" onClick={()=>toast.info("Visit deployment")}>Visit <ChevronDown size={12}/></button><button className="vc-icon-btn" onClick={()=>toast.info("Redeploy · Promote · Rollback · Delete")}><MoreHorizontal size={15}/></button></div></div><div className="vc-preview"><div><strong>Cloud Wai deployment preview</strong><small>Production / Preview rendering surface</small></div></div><div className="vc-meta-grid"><Meta k="Created" v="No deployment connected"/><Meta k="Status" v="Not assessed"/><Meta k="Duration" v="—"/><Meta k="Environment" v="Production"/><Meta k="Domains" v="None"/><Meta k="Source" v="GitHub / main"/></div>{["Deployment Settings","Build Logs","Deployment Summary","Deployment Checks","Assigning Custom Domains"].map(x=><button className="vc-accordion" key={x} onClick={()=>toast.info(x+" details")}><ChevronRight size={15}/><span>{x}</span><small>View details</small></button>)}<div className="vc-detail-cards"><Row icon={FileCode2} title="Runtime Logs" detail="View build and runtime logs & errors" onClick={()=>setDeploymentTab("Logs")}/><Row icon={Eye} title="Observability" detail="Monitor app health & performance"/><Row icon={Activity} title="Speed Insights" detail="Performance metrics from real users"/><Row icon={BarChart3} title="Web Analytics" detail="Analyze visitors and traffic"/></div></>}
    {deploymentTab==="Logs"&&<Logs/>}{deploymentTab==="Resources"&&<Resources/>}{deploymentTab==="Source"&&<Simple title="Source" icon={FolderGit2} text="Repository, branch, commit and deployment source metadata."/>}{deploymentTab==="Open Graph"&&<Simple title="Open Graph" icon={Images} text="Social preview metadata and generated image."/>}
  </div>;
}
function Deployments({onOpen}:{onOpen:(id?:string)=>void}) {
  const deploymentsQuery = trpc.deployments.list.useQuery(undefined, { retry: false });
  const deployments = deploymentsQuery.data ?? [];
  return <><Header title="Deployments" action={<button className="vc-btn primary" onClick={()=>toast.info("New Deployment: select project, source and environment.")}><Plus size={14}/> New Deployment</button>}/><div className="vc-filterbar"><button className="active">All</button><button>Production</button><button>Preview</button><button>Failed</button></div><div className="vc-card"><div className="vc-table-head"><span>Deployment</span><span>Environment</span><span>Status</span><span>Created</span></div>{deploymentsQuery.isLoading?<div className="vc-loading-row">Loading deployment records…</div>:deployments.length?deployments.map(deployment=><button className="vc-list-row" key={deployment.id} onClick={()=>onOpen(deployment.id)}><Rocket size={16}/><span><strong>{deployment.commit_sha || deployment.source_branch || deployment.id.slice(0,8)}</strong><small>{deployment.source_repository || "Source not configured"}</small></span><span>{deployment.environment}</span><Status good={deployment.status === "ready"}>{deployment.status}</Status><small>{new Date(deployment.created_at).toLocaleString()}</small></button>):<Empty title="No deployments yet" body="Create a deployment intent to record a real control-plane operation. It will remain honestly not configured until the self-hosted hosting runtime is provisioned." action="Connect GitHub" onAction={()=>toast.info("Connect → GitHub")}/>}</div></>;
}
function GlobalDeploymentDetail({deploymentTab,setDeploymentTab,onBack}:{deploymentTab:DeploymentTab;setDeploymentTab:(x:DeploymentTab)=>void;onBack:()=>void}) {
  return <><Header title="Deployment" crumb="Deployments / deployment" action={<div className="vc-actions"><button className="vc-btn" onClick={onBack}>Back</button><button className="vc-btn" onClick={()=>toast.info("Share deployment")}>Share</button><button className="vc-icon-btn" onClick={()=>toast.info("Redeploy · Promote · Rollback · Delete")}><MoreHorizontal size={15}/></button></div>}/><DeploymentDetail deploymentTab={deploymentTab} setDeploymentTab={setDeploymentTab}/></>;
}
function Resources(){return <><Header title="Resources" crumb="Deployment / Resources"/><div className="vc-card"><Row icon={Code2} title="Functions" detail="Runtime, size, region and invocation details"/><Row icon={FileCode2} title="Middleware" detail="Configured request matchers"/><Row icon={HardDrive} title="Static Assets" detail="Generated assets and sizes"/></div></>;}
function Logs(){const [filter,setFilter]=useState("All");return <><Header title="Logs" action={<button className="vc-btn" onClick={()=>toast.info("Live log stream requires a connected runtime")}>Live <span className="vc-live-dot"/></button>}/><div className="vc-filterbar">{["All","Errors","Warnings","Info"].map(x=><button key={x} className={filter===x?"active":""} onClick={()=>setFilter(x)}>{x}</button>)}<button onClick={()=>toast.info("Search supports structured filters such as level:error and status:500")}>Search</button></div><div className="vc-card vc-log-empty"><Empty title="No logs yet" body="Runtime logs will appear here with timestamps, levels, source and request IDs when a deployment/runtime is connected."/></div></>;}
function Analytics({title}:{title:string}){const [range,setRange]=useState("30d");return <><Header title={title} action={<button className="vc-btn" onClick={()=>toast.info("Export analytics")}>Export</button>}/><div className="vc-filterbar">{["24h","7d","30d","90d"].map(x=><button key={x} className={range===x?"active":""} onClick={()=>setRange(x)}>{x}</button>)}</div><div className="vc-grid-3"><Stat label="Visitors" value="—"/><Stat label="Requests" value="—"/><Stat label="Performance" value="—"/></div><div className="vc-card vc-chart"><div className="vc-chart-line"/><span>No data for selected range</span></div></>;}
function Observability(){const [tab,setTab]=useState("Overview");return <><Header title="Observability" action={<button className="vc-btn" onClick={()=>toast.info("Refreshing provider telemetry")}>Refresh</button>}/><div className="vc-filterbar">{["Overview","Logs","Metrics","Errors","Requests","Uptime"].map(x=><button key={x} className={tab===x?"active":""} onClick={()=>setTab(x)}>{x}</button>)}</div><div className="vc-grid-3"><Stat label="Requests" value="—"/><Stat label="Errors" value="—"/><Stat label="Latency" value="—"/></div><div className="vc-card"><h3>{tab}</h3><Empty title="No runtime data" body="Connect a deployment/runtime to populate searchable telemetry and operational metrics."/></div></>;}
function Firewall(){const [tab,setTab]=useState("Overview");return <><Header title="Firewall" action={<button className="vc-btn primary" onClick={()=>toast.info("Rule builder: condition → action → scope → review → activate")}><Plus size={14}/> Add Rule</button>}/><div className="vc-filterbar">{["Overview","Rules","Rate Limiting","Bot Protection","DDoS Protection"].map(x=><button key={x} className={tab===x?"active":""} onClick={()=>setTab(x)}>{x}</button>)}</div><div className="vc-card"><div className="vc-callout"><ShieldCheck size={18}/><div><strong>Protection boundary</strong><p>Rules are ordered, scoped and auditable. No simulated security state is shown.</p></div></div><div className="vc-table-head"><span>Name</span><span>Scope</span><span>Action</span><span>Status</span></div><Empty title={`No ${tab.toLowerCase()} configured`} body="Provider-backed configuration will appear here after a security provider is connected."/></div></>;}
function CDN(){const [tab,setTab]=useState("Overview");return <><Header title="CDN" action={<button className="vc-btn" onClick={()=>toast.info("Purge cache requires connected CDN")}>Purge Cache</button>}/><div className="vc-filterbar">{["Overview","Caches","Routing"].map(x=><button key={x} className={tab===x?"active":""} onClick={()=>setTab(x)}>{x}</button>)}</div><div className="vc-grid-3"><Stat label="Requests" value="—"/><Stat label="Cache hit rate" value="—"/><Stat label="Regions" value="—"/></div><div className="vc-card"><Empty title={`No CDN data`} body="Cloud Wai will show global traffic, cache performance and routing state from the connected edge provider."/></div></>;}
function EnvVars(){const [env,setEnv]=useState("All");return <><Header title="Environment Variables" action={<button className="vc-btn primary" onClick={()=>toast.info("Add Variable form") }><Plus size={14}/> Add Variable</button>}/><div className="vc-filterbar">{["All","Production","Preview","Development"].map(x=><button key={x} className={env===x?"active":""} onClick={()=>setEnv(x)}>{x}</button>)}</div><div className="vc-card"><div className="vc-table-head"><span>Name</span><span>Environment</span><span>Value</span><span>Updated</span></div><Empty title="No environment variables" body="Secrets and configuration are scoped by environment and remain masked. No secret values are simulated."/></div></>;}
function Domains({project}:{project?:boolean}){const [tab,setTab]=useState("Domains");const [query,setQuery]=useState("");const [submitted,setSubmitted]=useState("");const searchQuery=trpc.domains.search.useQuery({query:submitted},{enabled:!!submitted,retry:false});const tabs=["Domains","DNS","Nameservers","DNSSEC","TLS","Renewals"];return <><Header title="Domains" action={<button className="vc-btn primary" onClick={()=>toast.info("Registration will be enabled after a reseller adapter is connected")}><Plus size={14}/> Add Domain</button>}/><div className="vc-filterbar">{tabs.map(x=><button key={x} className={tab===x?"active":""} onClick={()=>setTab(x)}>{x}</button>)}</div>{tab==="Domains"?<><div className="vc-card vc-domain-search-card"><div className="vc-domain-search-copy"><span className="vc-crumb">Domain market</span><h2>Find the name for your next project</h2><p>Search behaves like a registrar marketplace. Live availability and pricing will appear as soon as the domain reseller adapter is configured.</p></div><div className="vc-domain-search-row"><div className="vc-search-input"><Search size={15}/><input value={query} onChange={e=>{setQuery(e.target.value);setSubmitted("")}} onKeyDown={e=>{if(e.key==="Enter"&&query.trim())setSubmitted(query.trim())}} placeholder="Search a domain, e.g. acme.com" aria-label="Search a domain"/><button onClick={()=>setQuery("")} aria-label="Clear domain search">×</button></div><button className="vc-btn primary" onClick={()=>query.trim()&&setSubmitted(query.trim())}>Search</button></div>{submitted&&<div className="vc-domain-results"><div className="vc-domain-result-head"><strong>Results for {searchQuery.data?.query||submitted}</strong><Status>{searchQuery.isFetching?"Searching":searchQuery.data?.status==="ready"?"Live result":"Adapter required"}</Status></div>{searchQuery.data?.results.map(result=><div className="vc-domain-result" key={result.domain}><span><strong>{result.domain}</strong><small>{result.reason||"Registrar result"}</small></span><span>{result.price?`${result.price.currency} ${result.price.amount}/yr`:"Pricing unavailable"}</span><button className="vc-btn" onClick={()=>toast.info("Registration requires reseller credentials")}>View details</button></div>)}</div>}</div></>:<div className="vc-card"><div className="vc-domain-row"><Globe2 size={16}/><span><strong>{project?"uscs — no domain connected":"No domains connected"}</strong><small>{tab+" management"}</small></span><Status>Not configured</Status></div><Empty title={`No ${tab.toLowerCase()} configured`} body="Domain state will be shown only after a registrar/DNS provider is connected."/></div>}</>;}

function Connect(){return <><Header title="Connect" action={<button className="vc-btn primary" onClick={()=>toast.info("Connect a provider") }><Plus size={14}/> Connect</button>}/><div className="vc-settings"><button onClick={()=>toast.info("GitHub OAuth flow")}><strong>GitHub</strong><small>Repositories, branches and deployment events</small></button><button onClick={()=>toast.info("GitLab OAuth flow")}><strong>GitLab</strong><small>Repositories and deployment events</small></button><button onClick={()=>toast.info("Repository picker")}><strong>Repositories</strong><small>Manage connected project sources</small></button></div></>;}
function Integrations(){return <><Header title="Integrations" action={<button className="vc-btn primary" onClick={()=>toast.info("Integration marketplace")}>Browse Marketplace</button>}/><div className="vc-card"><Empty title="No integrations installed" body="Installations, permissions and project scopes will appear here."/></div></>;}
function Storage(){const databasesQuery=trpc.data.databaseInstances.list.useQuery(undefined,{retry:false});const bucketsQuery=trpc.data.storageBuckets.list.useQuery(undefined,{retry:false});const backupsQuery=trpc.data.backups.list.useQuery(undefined,{retry:false});const databases=databasesQuery.data??[];const buckets=bucketsQuery.data??[];const backups=backupsQuery.data??[];return <><Header title="Data" action={<button className="vc-btn primary" onClick={()=>toast.info("Database and bucket provisioning requires a configured self-hosted adapter") }><Plus size={14}/> Create resource</button>}/><div className="vc-grid-3"><Stat label="Databases" value={databasesQuery.isLoading?"—":String(databases.length)}/><Stat label="Buckets" value={bucketsQuery.isLoading?"—":String(buckets.length)}/><Stat label="Backups" value={backupsQuery.isLoading?"—":String(backups.length)}/></div><div className="vc-card"><h3>PostgreSQL databases</h3>{databases.length?databases.map(resource=><div className="vc-list-row" key={resource.id}><Database size={16}/><span><strong>{resource.name}</strong><small>{resource.engine} · {resource.error_message||"Tenant database metadata"}</small></span><Status good={resource.status === "ready"}>{resource.status}</Status></div>):<Empty title="No database instances" body="Database metadata will appear here after a real self-hosted Postgres adapter is configured."/>}</div><div className="vc-card"><h3>Object storage buckets</h3>{buckets.length?buckets.map(bucket=><div className="vc-list-row" key={bucket.id}><HardDrive size={16}/><span><strong>{bucket.name}</strong><small>{bucket.visibility} · {bucket.region||"Region not configured"}</small></span><Status good={bucket.status === "ready"}>{bucket.status}</Status></div>):<Empty title="No storage resources" body="Bucket metadata will appear here after a real self-hosted MinIO adapter is configured."/>}</div><div className="vc-card"><h3>Backups</h3>{backups.length?backups.map(backup=><div className="vc-list-row" key={backup.id}><RefreshCw size={16}/><span><strong>{backup.resource_type} backup</strong><small>{backup.error_message||"Backup metadata"}</small></span><Status good={backup.status === "completed"}>{backup.status}</Status></div>):<Empty title="No backups" body="Backup records will appear after a real database or storage backup adapter is configured."/>}</div></>;}
function Flags(){const [tab,setTab]=useState("All Flags");return <><Header title="Flags" action={<button className="vc-btn primary" onClick={()=>toast.info("Create feature flag") }><Plus size={14}/> Create Flag</button>}/><div className="vc-filterbar">{["All Flags","Environments"].map(x=><button key={x} className={tab===x?"active":""} onClick={()=>setTab(x)}>{x}</button>)}</div><div className="vc-card"><Empty title="No feature flags" body="Controlled rollouts and targeting rules will appear here."/></div></>;}
function Agent(){const [tab,setTab]=useState("Chat");return <><Header title="Agent" action={<button className="vc-btn primary" onClick={()=>toast.info("Start an approved investigation")}><Sparkles size={14}/> New task</button>}/><div className="vc-filterbar">{["Chat","Investigations","Tasks"].map(x=><button key={x} className={tab===x?"active":""} onClick={()=>setTab(x)}>{x}</button>)}</div><div className="vc-card vc-agent"><Sparkles size={24}/><h2>Cloud Wai Agent</h2><p>Investigate deployments, logs, configuration and usage. Read-only by default; mutations require an explicit approval step and are audit logged.</p><button className="vc-btn primary" onClick={()=>toast.info("Agent is ready for connected project data")}>Start investigation</button></div></>;}
function AIGateway(){return <><Header title="AI Gateway" action={<button className="vc-btn primary" onClick={()=>toast.info("Add AI provider") }><Plus size={14}/> Add Provider</button>}/><div className="vc-grid-3"><Stat label="Providers" value="0"/><Stat label="Requests" value="—"/><Stat label="Cost" value="—"/></div><div className="vc-card"><Empty title="No AI providers connected" body="Connect providers to configure routing, limits, usage and failover."/></div></>;}
function Workflows(){return <><Header title="Workflows" action={<button className="vc-btn primary" onClick={()=>toast.info("Create workflow") }><Plus size={14}/> Create Workflow</button>}/><div className="vc-filterbar"><button className="active">All</button><button>Runs</button><button>Schedules</button><button>Failures</button></div><div className="vc-card"><Empty title="No workflows" body="Background jobs and scheduled automation will appear here."/></div></>;}
function Usage(){const [tab,setTab]=useState("Overview");return <><Header title="Usage" action={<button className="vc-btn" onClick={()=>toast.info("Export usage report")}>Export</button>}/><div className="vc-filterbar">{["Overview","Projects","Resources","History"].map(x=><button key={x} className={tab===x?"active":""} onClick={()=>setTab(x)}>{x}</button>)}</div><div className="vc-grid-3"><Stat label="Current usage" value="—"/><Stat label="This period" value="$0"/><Stat label="Plan" value="Not configured"/></div><div className="vc-card"><Empty title="No billable activity" body="Usage and projected cost will appear after provider resources are connected."/></div></>;}
function Support(){return <><Header title="Support"/><div className="vc-settings"><button onClick={()=>toast.info("Documentation")}><strong>Documentation</strong><small>Product guides and API reference</small></button><button onClick={()=>toast.info("System status")}><strong>System Status</strong><small>Service health and incidents</small></button><button onClick={()=>toast.info("Contact support")}><strong>Contact Support</strong><small>Open a support request</small></button></div></>;}
function WorkspaceSettings(){const [tab,setTab]=useState("General");const tabs=["General","Security","Authentication","Members","API Keys","Connected Accounts","Notifications","Danger Zone"];return <><Header title="Settings"/><div className="vc-settings-tabs">{tabs.map(x=><button key={x} className={tab===x?"active":""} onClick={()=>setTab(x)}>{x}</button>)}</div><div className="vc-card vc-settings-editor"><h2>{tab}</h2><p>{tab==="Security"?"MFA, sessions, security policy and audit controls.":tab==="Authentication"?"OAuth providers and authentication policy.":tab==="Members"?"Workspace members, roles and permissions.":tab==="API Keys"?"Create, rotate and revoke programmatic access tokens.":tab==="Danger Zone"?"Destructive workspace actions require confirmation.":"Workspace identity and operational defaults."}</p><button className="vc-btn primary" onClick={()=>toast.info(tab+" configuration")}>Configure</button></div></>;}
function ProjectSettings(){const [tab,setTab]=useState("General");return <div className="vc-settings-project"><nav>{projectSettings.map(x=><button key={x} className={tab===x?"active":""} onClick={()=>setTab(x)}>{x}<ChevronRight size={13}/></button>)}</nav><div className="vc-card vc-settings-editor"><div className="vc-crumb">Project Settings</div><h2>{tab}</h2><p>{tab==="Build & Deployment"?"Framework, root directory, Node.js version and build behavior.":tab==="Environment Variables"?"Environment-scoped configuration and sensitive variables.":tab==="Git"?"Repository connection, deploy hooks and Git options.":tab==="Deployment Protection"?"Authentication, password protection and preview access.":tab==="Functions"?"Runtime, memory, timeout and region defaults.":tab==="Cron Jobs"?"Scheduled jobs and execution settings.":tab==="Members"?"Project-level access and roles.":tab==="Webhooks"?"Project event webhooks and delivery.":tab==="Drains"?"External observability destinations.":tab==="Security"?"Attack protection, source protection and retention.":tab==="Advanced"?"Advanced project behavior and compatibility controls.":"Project identity and foundational configuration."}</p><div className="vc-settings-fields"><label>Name<input value="uscs" readOnly/></label><label>Status<input value="Configured by Cloud Wai" readOnly/></label></div><button className="vc-btn primary" onClick={()=>toast.info(tab+" settings")}>Save changes</button></div></div>;}
function Simple({title,icon:Icon,text}:{title:string;icon:Icon;text:string}){return <><Header title={title}/><div className="vc-card"><Empty title={title+" is not configured"} body={text+" Cloud Wai will expose verified provider-backed state here."} action="Configure" onAction={()=>toast.info("Provider configuration")}/></div></>;}
function GitHubMark(){return <span className="vc-gh">●</span>;}


function AccountCenter({panel,onClose,user}:{panel:"account"|"api"|"settings";onClose:()=>void;user:{id?:string|null;name?:string|null;email?:string|null;loginMethod?:string|null;role?:string|null}|null}) {
  const accountQuery = trpc.account.me.useQuery(undefined, { retry: false });
  const keysQuery = trpc.account.apiKeys.list.useQuery(undefined, { enabled: panel === "api", retry: false });
  const createKey = trpc.account.apiKeys.create.useMutation({
    onSuccess: ({ key }) => {
      void keysQuery.refetch();
      window.prompt("Copy this API key now. It will not be shown again.", key);
      toast.success("API key created");
    },
    onError: e => toast.error(e.message),
  });
  const revokeKey = trpc.account.apiKeys.revoke.useMutation({
    onSuccess: () => { void keysQuery.refetch(); toast.success("API key revoked"); },
    onError: e => toast.error(e.message),
  });
  const [name,setName]=useState("");
  const identity=accountQuery.data ?? user;
  const title=panel==="account"?"Account":panel==="api"?"API keys":"Account settings";

  return <div className="vc-account-overlay" onMouseDown={onClose}>
    <section className="vc-account-center" onMouseDown={e=>e.stopPropagation()}>
      <header className="vc-account-center-head">
        <div><div className="vc-crumb">Workspace / Account</div><h2>{title}</h2></div>
        <button className="vc-icon-btn" onClick={onClose}><X size={16}/></button>
      </header>

      {panel==="account"&&<div className="vc-account-center-body">
        <div className="vc-account-hero"><span className="vc-account-large-avatar">{(identity?.name||"U").slice(0,1).toUpperCase()}</span><div><h3>{identity?.name||"Account"}</h3><p>{identity?.email||"Email unavailable"}</p></div></div>
        <div className="vc-account-grid">
          <div><small>Email</small><strong>{identity?.email||"—"}</strong></div>
          <div><small>Authentication</small><strong>{identity?.loginMethod||"—"}</strong></div>
          <div><small>Role</small><strong>{identity?.role||"user"}</strong></div>
          <div><small>Account ID</small><strong className="vc-mono">{identity?.id||"—"}</strong></div>
        </div>
        <div className="vc-account-section"><span className="vc-eyebrow">Account security</span><h3>Authentication & sessions</h3><p>Identity is verified by Supabase Auth. Session enforcement and provider configuration stay in the security settings.</p><button className="vc-btn" onClick={()=>toast.info("Open Settings → Authentication")}>Open authentication settings</button></div>
      </div>}

      {panel==="api"&&<div className="vc-account-center-body">
        <div className="vc-api-intro"><div><span className="vc-eyebrow">Developer access</span><h3>API keys</h3><p>Create scoped credentials for programmatic access. Cloud Wai stores only a SHA-256 hash, never the plaintext key.</p></div><div className="vc-api-create"><input value={name} onChange={e=>setName(e.target.value)} placeholder="Key name, e.g. CI deploy"/><button className="vc-btn primary" disabled={createKey.isPending||!name.trim()} onClick={()=>createKey.mutate({name:name.trim()})}><Plus size={14}/> Create key</button></div></div>
        <div className="vc-api-list">
          {keysQuery.isLoading&&<div className="vc-api-empty">Loading API keys…</div>}
          {!keysQuery.isLoading&&(!keysQuery.data||keysQuery.data.length===0)&&<div className="vc-api-empty"><KeyRound size={20}/><strong>No API keys</strong><span>Create one for CLI, CI/CD or server-to-server access.</span></div>}
          {keysQuery.data?.map(k=><div className="vc-api-row" key={k.id}><KeyRound size={15}/><div><strong>{k.name}</strong><small>{k.key_prefix}•••• · created {new Date(k.created_at).toLocaleDateString()}</small></div><Status good={!k.revoked_at}>{k.revoked_at?"Revoked":"Active"}</Status><button className="vc-icon-btn" disabled={Boolean(k.revoked_at)||revokeKey.isPending} onClick={()=>revokeKey.mutate({id:k.id})}><MoreHorizontal size={15}/></button></div>)}
        </div>
      </div>}

      {panel==="settings"&&<div className="vc-account-center-body">
        <div className="vc-account-settings-list">
          <button onClick={()=>toast.info("Profile editing is next in the account backend")}><span><strong>Profile</strong><small>Name, avatar and account identity</small></span><ChevronRight size={15}/></button>
          <button onClick={()=>toast.info("Authentication settings") }><span><strong>Authentication</strong><small>OAuth providers, sessions and sign-in policy</small></span><ChevronRight size={15}/></button>
          <button onClick={()=>toast.info("Security settings") }><span><strong>Security</strong><small>MFA, session protection and recovery</small></span><ChevronRight size={15}/></button>
          <button onClick={()=>toast.info("Notifications settings") }><span><strong>Notifications</strong><small>Security, deployment and product alerts</small></span><ChevronRight size={15}/></button>
        </div>
      </div>}
    </section>
  </div>;
}

function SecurityCenter(){const orgs=trpc.workspace.organizations.useQuery(undefined,{retry:false});const orgId=orgs.data?.[0]?.id;const projects=trpc.workspace.projects.list.useQuery(undefined,{enabled:!!orgId,retry:false});const projectId=projects.data?.[0]?.id??null;const [level,setLevel]=useState<"none"|"normal"|"high"|"ultimate">("normal");const [autoSetup,setAutoSetup]=useState(true);const preview=trpc.security.previewPolicy.useQuery({level});const policy=trpc.security.getPolicy.useQuery({organizationId:orgId||"00000000-0000-0000-0000-000000000000",projectId},{enabled:!!orgId,retry:false});const setPolicy=trpc.security.setLevel.useMutation({onSuccess:()=>{toast.success("Security policy saved");policy.refetch()},onError:e=>toast.error(e.message)});const applyPolicy=trpc.security.applyPolicy.useMutation({onSuccess:r=>{toast.info(r.status==="pending"?"Policy saved; edge host is not configured yet.":r.message);policy.refetch()},onError:e=>toast.error(e.message)});const current=policy.data?.policy;const selected=current?.security_level??level;const config=preview.data?.config;const rows=config?[['Firewall',config.firewall.enabled?`Enabled · private networks ${config.firewall.denyPrivateNetworks?"blocked":"allowed"}`:"Disabled"],['WAF / OWASP CRS',config.waf.enabled?`${config.waf.sensitivity} rules`:'Disabled'],['Rate limit',config.rateLimit.enabled?`${config.rateLimit.requestsPerMinute} requests/minute`:'Disabled'],['Bot protection',config.botProtection.enabled?config.botProtection.challengeThreshold:'Disabled'],['TLS',`${config.tls.minimumVersion}${config.tls.hsts?' · HSTS':''}`],['Security headers',config.tls.securityHeaders?'Enabled':'Disabled']]:[];return <><Header title="Security" crumb="Security / Policy" action={<div className="vc-actions"><Status good={current?.last_apply_status==="applied"}>{current?.last_apply_status||"not configured"}</Status><button className="vc-btn primary" disabled={!orgId||applyPolicy.isPending||!current} onClick={()=>orgId&&applyPolicy.mutate({organizationId:orgId,projectId})}>{applyPolicy.isPending?"Applying…":"Apply policy"}</button></div>}/><div className="vc-security-intro"><span className="vc-eyebrow">Self-operated security edge</span><h2>Choose the protection posture for this workspace</h2><p>Cloud Wai renders OpenResty, Coraza, CrowdSec, nftables and mTLS tunnel intent. Enforcement remains pending until your own edge host is provisioned.</p></div><div className="vc-security-levels">{([['none','None','No active protection'],['normal','Normal','Balanced WAF and traffic controls'],['high','High','Strict WAF and TLS 1.3'],['ultimate','Ultimate','60 rpm, aggressive bot controls'] ] as const).map(([value,title,desc])=><button key={value} className={`vc-security-level ${selected===value?'active':''}`} onClick={()=>setLevel(value)}><span className="vc-security-level-dot"/><strong>{title}</strong><small>{desc}</small></button>)}</div><div className="vc-security-toolbar"><label><input type="checkbox" checked={autoSetup} onChange={e=>setAutoSetup(e.target.checked)}/> Auto-setup full rule set</label><button className="vc-btn" disabled={!orgId||setPolicy.isPending} onClick={()=>orgId&&setPolicy.mutate({organizationId:orgId,projectId,level,autoSetup})}>{setPolicy.isPending?"Saving…":"Save selected level"}</button></div><div className="vc-grid-2"><section className="vc-card vc-security-controls"><div className="vc-card-heading"><div><span className="vc-eyebrow">Live policy preview</span><h3>What this enables</h3></div><Status>{level}</Status></div><div className="vc-security-control-table">{rows.map(([name,value])=><div className="vc-security-control-row" key={name}><ShieldCheck size={15}/><span><strong>{name}</strong><small>{value}</small></span></div>)}</div></section><section className="vc-card vc-security-controls"><div className="vc-card-heading"><div><span className="vc-eyebrow">Before apply</span><h3>Policy state</h3></div><Status>{current?.last_apply_status||"not saved"}</Status></div><div className="vc-security-diff"><div><small>Selected</small><strong>{level}</strong></div><div><small>Applied</small><strong>{current?.security_level||"—"}</strong></div><div><small>Version</small><strong>{current?.enforcement_version??"—"}</strong></div></div><p className="vc-security-note">{current?.last_apply_error||"Save a level to persist the desired edge configuration. Apply will remain pending until the edge adapter is configured."}</p></section></div><section className="vc-card vc-security-history"><div className="vc-card-heading"><div><span className="vc-eyebrow">Audit trail</span><h3>Applied policy history</h3></div><Status>{policy.data?.events?.length??0} events</Status></div>{policy.isLoading?<div className="vc-loading-row">Loading policy history…</div>:policy.data?.events?.length?policy.data.events.map(event=><div className="vc-security-event" key={event.id}><span className={`vc-event-dot ${event.event_type}`}/><span><strong>{event.event_type}</strong><small>{new Date(event.created_at).toLocaleString()}</small></span><em>{event.error_message||"Recorded in control plane"}</em></div>):<Empty title="No policy events yet" body="Saving and applying a security level will create an auditable event here."/>}</section></>;}
