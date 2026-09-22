import { useState, type ReactNode } from "react";
import "@/styles/control-plane.css";
import {
  Activity, BarChart3, Bell, Bot, Box, ChevronDown, ChevronRight, CircleHelp,
  Cloud, Code2, Database, ExternalLink, Eye, FileCode2, Flag, FolderGit2,
  Globe2, HardDrive, Images, KeyRound, LayoutDashboard, Link2, ListFilter,
  LockKeyhole, Menu, MoreHorizontal, Network, Plus, Rocket, Search, Server,
  Settings2, ShieldCheck, Sparkles, Store, TerminalSquare, Users, Workflow, X, Zap
} from "lucide-react";
import { toast } from "sonner";

type Page =
  | "Overview" | "Projects" | "Deployments" | "Logs" | "Analytics" | "Speed Insights"
  | "Observability" | "Firewall" | "CDN" | "Environment Variables" | "Domains"
  | "Connect" | "Integrations" | "Storage" | "Flags" | "Agent" | "AI Gateway"
  | "Sandboxes" | "Workflows" | "Images" | "Usage" | "Support" | "Settings";

type Icon = typeof LayoutDashboard;

const items: {label: Page; icon: Icon; chevron?: boolean}[] = [
  {label:"Overview",icon:LayoutDashboard},
  {label:"Projects",icon:Box},
  {label:"Deployments",icon:Rocket},
  {label:"Logs",icon:FileCode2,chevron:true},
  {label:"Analytics",icon:BarChart3},
  {label:"Speed Insights",icon:Activity},
  {label:"Observability",icon:Eye,chevron:true},
  {label:"Firewall",icon:ShieldCheck,chevron:true},
  {label:"CDN",icon:Network,chevron:true},
  {label:"Environment Variables",icon:KeyRound},
  {label:"Domains",icon:Globe2},
  {label:"Connect",icon:Link2,chevron:true},
  {label:"Integrations",icon:Store},
  {label:"Storage",icon:HardDrive},
  {label:"Flags",icon:Flag,chevron:true},
  {label:"Agent",icon:Sparkles,chevron:true},
  {label:"AI Gateway",icon:Bot},
  {label:"Sandboxes",icon:TerminalSquare},
  {label:"Workflows",icon:Workflow},
  {label:"Images",icon:Images},
];

function Status({children,good=false}:{children:ReactNode;good?:boolean}) {
  return <span className={`vc-status ${good?"good":""}`}><i/>{children}</span>;
}
function Header({title,crumb,action}:{title:string;crumb?:string;action?:ReactNode}) {
  return <div className="vc-page-head"><div><div className="vc-crumb">{crumb||title}</div><h1>{title}</h1></div>{action}</div>;
}
function Empty({title,body,action}:{title:string;body:string;action?:string}) {
  return <div className="vc-empty"><div className="vc-empty-mark"><Box size={20}/></div><h3>{title}</h3><p>{body}</p>{action&&<button className="vc-btn primary" onClick={()=>toast.info(action+" is ready for provider integration.")}>{action}<ChevronRight size={14}/></button>}</div>;
}
function Row({icon:Icon,title,detail,onClick}:{icon:Icon;title:string;detail?:string;onClick?:()=>void}) {
  return <button className="vc-list-row" onClick={onClick}><Icon size={16}/><span><strong>{title}</strong>{detail&&<small>{detail}</small>}</span><ChevronRight size={14}/></button>;
}

export default function VercelControlPlane({user,logout}:{user:{name?:string|null}|null;logout:()=>void}) {
  const [page,setPage]=useState<Page>("Overview");
  const [project,setProject]=useState<string|null>(null);
  const [collapsed,setCollapsed]=useState(false);
  const [mobile,setMobile]=useState(false);
  const [search,setSearch]=useState("");
  const [projectTab,setProjectTab]=useState<"Overview"|"Deployments"|"Domains"|"Settings">("Overview");
  const [deploymentTab,setDeploymentTab]=useState<"Deployment"|"Logs"|"Resources"|"Source"|"Open Graph">("Deployment");
  const [globalDeployment,setGlobalDeployment]=useState(false);

  const go=(p:Page)=>{setPage(p);setProject(null);setGlobalDeployment(false);setMobile(false);window.scrollTo({top:0})};
  const openProject=(name:string)=>{setProject(name);setProjectTab("Overview");setGlobalDeployment(false);setPage("Projects");setMobile(false)};
  const initials=(user?.name||"U").trim().slice(0,1).toUpperCase();

  const content = project
    ? <ProjectView project={project} tab={projectTab} setTab={setProjectTab} deploymentTab={deploymentTab} setDeploymentTab={setDeploymentTab}/>
    : page==="Overview" ? <Overview onProjects={()=>go("Projects")} onDeployments={()=>go("Deployments")}/>
    : page==="Projects" ? <Projects onOpen={openProject}/>
    : page==="Deployments" ? (globalDeployment ? <GlobalDeploymentDetail deploymentTab={deploymentTab} setDeploymentTab={setDeploymentTab} onBack={()=>setGlobalDeployment(false)}/> : <Deployments onOpen={()=>{setDeploymentTab("Deployment");setGlobalDeployment(true)}}/>)
    : page==="Logs" ? <Logs/>
    : page==="Analytics" ? <Analytics title="Analytics"/>
    : page==="Speed Insights" ? <Analytics title="Speed Insights"/>
    : page==="Observability" ? <Observability/>
    : page==="Firewall" ? <Firewall/>
    : page==="CDN" ? <Simple title="CDN" icon={Network} text="Edge delivery, cache behavior and traffic routing."/>
    : page==="Environment Variables" ? <EnvVars/>
    : page==="Domains" ? <Domains/>
    : page==="Connect" ? <Simple title="Connect" icon={Link2} text="Git providers, deployment sources and connected repositories."/>
    : page==="Integrations" ? <Simple title="Integrations" icon={Store} text="Marketplace and third-party integrations."/>
    : page==="Storage" ? <Simple title="Storage" icon={HardDrive} text="Persistent storage and provider-backed resources."/>
    : page==="Flags" ? <Simple title="Flags" icon={Flag} text="Feature flags and controlled rollouts."/>
    : page==="Agent" ? <Agent/>
    : page==="AI Gateway" ? <Simple title="AI Gateway" icon={Bot} text="Model routing, usage and AI infrastructure."/>
    : page==="Sandboxes" ? <Simple title="Sandboxes" icon={TerminalSquare} text="Isolated execution environments."/>
    : page==="Workflows" ? <Simple title="Workflows" icon={Workflow} text="Background workflows and scheduled automation."/>
    : page==="Images" ? <Simple title="Images" icon={Images} text="Image optimization and delivery."/>
    : page==="Usage" ? <Usage/>
    : page==="Support" ? <Simple title="Support" icon={CircleHelp} text="Documentation, support and incident communication."/>
    : <Settings/>;

  return <div className={`vc-shell ${collapsed?"collapsed":""}`}>
    <aside className={`vc-sidebar ${mobile?"mobile":""}`}>
      <div className="vc-brand"><div className="vc-brand-dot">U</div><button className="vc-team"><strong>USCS</strong><span>Workspace</span><ChevronDown size={11}/></button><button className="vc-collapse" onClick={()=>setCollapsed(v=>!v)} aria-label="Toggle sidebar"><ChevronRight size={15}/></button><button className="vc-close" onClick={()=>setMobile(false)}><X size={18}/></button></div>
      <div className="vc-find"><Search size={14}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Find"/><kbd>⌘ K</kbd></div>
      <div className="vc-nav">
        {items.filter(x=>!search||x.label.toLowerCase().includes(search.toLowerCase())).map(({label,icon:Icon,chevron})=><button key={label} className={`vc-nav-item ${page===label&&!project?"active":""}`} onClick={()=>go(label)}><Icon size={15}/><span>{label}</span>{chevron&&<ChevronRight className="vc-nav-chevron" size={13}/>}</button>)}
      </div>
      <div className="vc-nav-bottom">
        <button className={`vc-nav-item ${page==="Usage"&&!project?"active":""}`} onClick={()=>go("Usage")}><BarChart3 size={15}/><span>Usage</span></button>
        <button className={`vc-nav-item ${page==="Support"&&!project?"active":""}`} onClick={()=>go("Support")}><CircleHelp size={15}/><span>Support</span></button>
        <button className={`vc-nav-item ${page==="Settings"&&!project?"active":""}`} onClick={()=>go("Settings")}><Settings2 size={15}/><span>Settings</span><ChevronRight className="vc-nav-chevron" size={13}/></button>
      </div>
      <button className="vc-account" onClick={logout}><span>{initials}</span><div><strong>{user?.name||"Account"}</strong><small>Sign out</small></div><MoreHorizontal size={15}/></button>
    </aside>
    <main className="vc-main">
      <header className="vc-topbar"><button className="vc-mobile-menu" onClick={()=>setMobile(true)}><Menu size={19}/></button><div className="vc-top-crumb"><button onClick={()=>go("Overview")}>wasimmostakim2965-ui</button>{project&&<><ChevronRight size={13}/><strong>{project}</strong></>}</div><div className="vc-top-actions"><button className="vc-top-icon"><Bell size={16}/></button><button className="vc-top-icon"><CircleHelp size={16}/></button><button className="vc-avatar" onClick={logout}>{initials}</button></div></header>
      <div className="vc-content">{content}</div>
    </main>
  </div>;
}

function Overview({onProjects,onDeployments}:{onProjects:()=>void;onDeployments:()=>void}) {
  return <><Header title="Overview" action={<button className="vc-btn primary" onClick={onProjects}><Plus size={14}/> Add New <ChevronDown size={13}/></button>}/>
    <div className="vc-card vc-recent"><div className="vc-tabs"><button className="active">Recents</button><button>Usage</button><button>Alerts</button></div>
      <Row icon={ShieldCheck} title="Stop tracking .env (contains DB password)" detail="Preview · #17 · just now"/>
      <Row icon={Rocket} title="feat: replace categories (48 new) + clean job detail layout" detail="Preview · #4 · recently"/>
    </div>
    <div className="vc-section-title">Projects</div>
    <div className="vc-project-card" onClick={()=>onProjects()}><div className="vc-project-logo">V</div><div><strong>uscs</strong><small>uscs-ashy.vercel.app</small><p><GitHubMark/> wasimmostakim2965-ui/USCS · main</p></div><Status good/></div>
    <div className="vc-project-card"><div className="vc-project-logo">V</div><div><strong>workergigbd-site</strong><small>workergigbd.site</small><p><GitHubMark/> wasimmostakim2965-ui/workergigbd.site · Sep 15</p></div><Status/></div>
  </>;
}

function Projects({onOpen}:{onOpen:(name:string)=>void}) {
  return <><Header title="Projects" crumb="All Projects" action={<button className="vc-btn primary"><Plus size={14}/> Add New <ChevronDown size={13}/></button>}/><div className="vc-project-toolbar"><div className="vc-search-input"><Search size={15}/><input placeholder="Search Projects"/></div><button className="vc-icon-btn"><ListFilter size={15}/></button></div>
    <div className="vc-card vc-project-recent"><div className="vc-tabs"><button className="active">Recents</button><button>Usage</button><button>Alerts</button></div><Row icon={ShieldCheck} title="Stop tracking .env (contains DB password)" detail="Preview · #17"/><Row icon={Rocket} title="feat: replace categories (48 new) + clean job detail layout" detail="Preview · #4"/></div>
    <div className="vc-section-title">Projects</div>
    <div className="vc-project-card" onClick={()=>onOpen("uscs")}><div className="vc-project-logo">V</div><div><strong>uscs</strong><small>uscs-ashy.vercel.app</small><p><GitHubMark/> wasimmostakim2965-ui/USCS · main</p></div><Status good/></div>
    <div className="vc-project-card"><div className="vc-project-logo">V</div><div><strong>workergigbd-site</strong><small>workergigbd.site</small><p><GitHubMark/> wasimmostakim2965-ui/workergigbd.site · Sep 15</p></div><Status/></div>
  </>;
}

function ProjectView({project,tab,setTab,deploymentTab,setDeploymentTab}:{project:string;tab:"Overview"|"Deployments"|"Domains"|"Settings";setTab:(x:any)=>void;deploymentTab:any;setDeploymentTab:(x:any)=>void}) {
  return <><Header title={project} crumb={`Projects / ${project}`} action={<div className="vc-actions"><button className="vc-btn">Share</button><button className="vc-btn primary" onClick={()=>toast.info("Deploy action will connect to the deployment provider.")}>Deploy</button><button className="vc-icon-btn"><MoreHorizontal size={15}/></button></div>}/>
    <div className="vc-project-tabs">{(["Overview","Deployments","Domains","Settings"] as const).map(t=><button key={t} className={tab===t?"active":""} onClick={()=>setTab(t)}>{t}</button>)}</div>
    {tab==="Overview"&&<><div className="vc-card vc-deploy-hero"><div><span className="vc-eyebrow">Production</span><h2>No production deployment</h2><p>Connect GitHub or deploy with the CLI/API to create a release.</p></div><button className="vc-btn primary">Deploy</button></div><div className="vc-grid-3"><Stat label="Deployments" value="0"/><Stat label="Domains" value="0"/><Stat label="Requests" value="—"/></div><div className="vc-grid-2"><div className="vc-card"><h3>Latest deployment</h3><Empty title="No deployments yet" body="Your deployment history will appear here with commit, build logs, resources and rollback actions." action="Create deployment"/></div><div className="vc-card"><h3>Project configuration</h3><Row icon={KeyRound} title="Environment Variables" detail="Per environment"/><Row icon={ShieldCheck} title="Deployment Protection" detail="Access controls"/><Row icon={Globe2} title="Domains" detail="Custom domains"/></div></div></>}
    {tab==="Deployments"&&<DeploymentDetail deploymentTab={deploymentTab} setDeploymentTab={setDeploymentTab}/>}
    {tab==="Domains"&&<Domains project={project}/>}
    {tab==="Settings"&&<ProjectSettings/>}
  </>;
}

function DeploymentDetail({deploymentTab,setDeploymentTab}:{deploymentTab:any;setDeploymentTab:(x:any)=>void}) {
  return <div className="vc-card vc-deployment-detail"><div className="vc-subtabs">{(["Deployment","Logs","Resources","Source","Open Graph"] as const).map(t=><button className={deploymentTab===t?"active":""} key={t} onClick={()=>setDeploymentTab(t)}>{t}</button>)}</div>
    {deploymentTab==="Deployment"&&<><div className="vc-detail-actions"><span>Deployment Details</span><div><button className="vc-btn">Share</button><button className="vc-btn">Logs</button><button className="vc-btn">Visit <ChevronDown size={12}/></button><button className="vc-icon-btn"><MoreHorizontal size={15}/></button></div></div><div className="vc-preview">Deployment preview</div><div className="vc-meta-grid"><Meta k="Created" v="Not available"/><Meta k="Status" v="Ready · Latest" good/><Meta k="Duration" v="—"/><Meta k="Environment" v="Production"/><Meta k="Domains" v="None"/><Meta k="Source" v="main · GitHub"/></div>{["Deployment Settings","Build Logs","Deployment Summary","Deployment Checks","Assigning Custom Domains"].map((x,i)=><button className="vc-accordion" key={x}><ChevronRight size={15}/><span>{x}</span><small>{i===1?"No logs yet":i===4?"0 domains":"View details"}</small></button>)}<div className="vc-detail-cards"><Row icon={FileCode2} title="Runtime Logs" detail="View build and runtime logs & errors"/><Row icon={Eye} title="Observability" detail="Monitor app health & performance"/><Row icon={Activity} title="Speed Insights" detail="Performance metrics from real users"/><Row icon={BarChart3} title="Web Analytics" detail="Analyze visitors and traffic"/></div></>}
    {deploymentTab==="Logs"&&<Logs/>}{deploymentTab==="Resources"&&<Resources/>}{deploymentTab==="Source"&&<Simple title="Source" icon={FolderGit2} text="Repository, branch, commit and deployment source metadata."/>}{deploymentTab==="Open Graph"&&<Simple title="Open Graph" icon={Images} text="Social preview metadata and generated image."/>}
  </div>;
}
function Resources(){return <div><Header title="Resources" crumb="Deployment / Resources"/><div className="vc-card"><Row icon={Code2} title="Functions" detail="Runtime, size, region and invocation details"/><Row icon={FileCode2} title="Middleware" detail="Request middleware resources"/><Row icon={HardDrive} title="Static Assets" detail="Generated assets and sizes"/></div></div>}
function Deployments({onOpen}:{onOpen:()=>void}){return <><Header title="Deployments" action={<button className="vc-btn primary"><Plus size={14}/> New Deployment</button>}/><div className="vc-filterbar"><button className="active">All</button><button>Production</button><button>Preview</button><button>Failed</button></div><div className="vc-card"><div className="vc-table-head"><span>Deployment</span><span>Environment</span><span>Status</span><span>Created</span></div><button className="vc-deployment-row" onClick={onOpen}><Rocket size={16}/><span><strong>uscs-git-main</strong><small>main · GitHub</small></span><span>Production</span><Status good>Ready</Status><span>—</span></button><Empty title="No additional deployments" body="Deployment history, preview URLs, resources and rollback actions appear here." action="Connect GitHub"/></div></>}
function GlobalDeploymentDetail({deploymentTab,setDeploymentTab,onBack}:{deploymentTab:any;setDeploymentTab:(x:any)=>void;onBack:()=>void}) {
  return <><Header title="Deployment" crumb="Deployments / uscs-git-main" action={<div className="vc-actions"><button className="vc-btn" onClick={onBack}>Back</button><button className="vc-btn">Share</button><button className="vc-icon-btn"><MoreHorizontal size={15}/></button></div>}/>
    <div className="vc-deployment-detail vc-card"><div className="vc-subtabs">{(["Deployment","Logs","Resources","Source","Open Graph"] as const).map(t=><button className={deploymentTab===t?"active":""} key={t} onClick={()=>setDeploymentTab(t)}>{t}</button>)}</div>
      {deploymentTab==="Deployment"&&<><div className="vc-detail-actions"><span>Deployment Details</span><div><button className="vc-btn">Share</button><button className="vc-btn" onClick={()=>setDeploymentTab("Logs")}>Logs</button><button className="vc-btn">Visit <ChevronDown size={12}/></button><button className="vc-icon-btn"><MoreHorizontal size={15}/></button></div></div><div className="vc-preview"><div><strong>USCS deployment preview</strong><small>Production deployment preview</small></div></div><div className="vc-meta-grid"><Meta k="Created" v="Latest deployment"/><Meta k="Status" v="Ready · Latest" good/><Meta k="Duration" v="—"/><Meta k="Environment" v="Production"/><Meta k="Domains" v="uscs-ashy.vercel.app"/><Meta k="Source" v="main · GitHub"/></div>{["Deployment Settings","Build Logs","Deployment Summary","Deployment Checks","Assigning Custom Domains"].map((x,i)=><button className="vc-accordion" key={x}><ChevronRight size={15}/><span>{x}</span><small>{i===1?"View logs":i===4?"Assign domain":"View details"}</small></button>)}<div className="vc-detail-cards"><Row icon={FileCode2} title="Runtime Logs" detail="View build and runtime logs & errors" onClick={()=>setDeploymentTab("Logs")}/><Row icon={Eye} title="Observability" detail="Monitor app health & performance"/><Row icon={Activity} title="Speed Insights" detail="Performance metrics from real users"/><Row icon={BarChart3} title="Web Analytics" detail="Analyze visitors and traffic"/></div></>}
      {deploymentTab==="Logs"&&<Logs/>}{deploymentTab==="Resources"&&<Resources/>}{deploymentTab==="Source"&&<Simple title="Source" icon={FolderGit2} text="Repository, branch, commit and deployment source metadata."/>}{deploymentTab==="Open Graph"&&<Simple title="Open Graph" icon={Images} text="Social preview metadata and generated image."/>}
    </div></>;
}


function Logs(){return <><Header title="Logs" action={<button className="vc-btn">Live <span className="vc-live-dot"/></button>}/><div className="vc-filterbar"><button className="active">All</button><button>Errors</button><button>Warnings</button><button>Info</button><button>Search</button></div><div className="vc-card vc-log-empty"><Empty title="No logs yet" body="Logs will stream here when a deployment or runtime produces events." action="Connect a deployment"/></div></>}
function Analytics({title}:{title:string}){return <><Header title={title}/><div className="vc-grid-3"><Stat label="Visitors" value="—"/><Stat label="Requests" value="—"/><Stat label="Performance" value="—"/></div><div className="vc-card vc-chart"><div className="vc-chart-line"/><span>No data for selected range</span></div></>}
function Observability(){return <><Header title="Observability" action={<button className="vc-btn">Refresh</button>}/><div className="vc-filterbar"><button className="active">Overview</button><button>Logs</button><button>Metrics</button><button>Errors</button><button>Requests</button><button>Uptime</button></div><div className="vc-grid-3"><Stat label="Requests" value="—"/><Stat label="Errors" value="—"/><Stat label="Latency" value="—"/></div><div className="vc-card"><h3>Event stream</h3><Empty title="No runtime data" body="Connect a deployment to populate searchable logs, metrics and request traces."/></div></>}
function Firewall(){return <><Header title="Firewall" action={<button className="vc-btn primary"><Plus size={14}/> Add Rule</button>}/><div className="vc-card"><div className="vc-callout"><ShieldCheck size={18}/><div><strong>Protection boundary</strong><p>Rules are ordered, scoped and auditable. No simulated security state is shown.</p></div></div><div className="vc-table-head"><span>Rule</span><span>Scope</span><span>Action</span><span>Status</span></div><Empty title="No firewall rules" body="Create provider-backed custom rules, rate limits or managed protections."/></div></>}
function EnvVars(){return <><Header title="Environment Variables" action={<button className="vc-btn primary"><Plus size={14}/> Add Variable</button>}/><div className="vc-filterbar"><button className="active">All</button><button>Production</button><button>Preview</button><button>Development</button></div><div className="vc-card"><Empty title="No environment variables" body="Secrets and configuration are scoped by environment and should remain server-side." action="Add Variable"/></div></>}
function Domains({project}:{project?:string}){return <><Header title="Domains" action={<button className="vc-btn primary"><Plus size={14}/> Add Domain</button>}/><div className="vc-card"><div className="vc-domain-row"><Globe2 size={16}/><span><strong>{project?project+".example.com":"No domains connected"}</strong><small>{project?"Production domain":"Connect a domain to begin"}</small></span><Status>Not configured</Status></div><div className="vc-grid-3"><Stat label="DNS" value="—"/><Stat label="TLS" value="—"/><Stat label="Renewal" value="—"/></div></div></>}
function Agent(){return <><Header title="Agent" action={<button className="vc-btn primary"><Sparkles size={14}/> New task</button>}/><div className="vc-card vc-agent"><Sparkles size={24}/><h2>Vercel-style operational agent</h2><p>Investigate deployments, logs, configuration and usage. Read-only by default; mutations require explicit approval.</p><button className="vc-btn primary">Start investigation</button></div></>}
function Usage(){return <><Header title="Usage"/><div className="vc-grid-3"><Stat label="Current usage" value="—"/><Stat label="This period" value="$0"/><Stat label="Plan" value="Hobby"/></div><div className="vc-card"><h3>Usage breakdown</h3><Empty title="No billable activity" body="Usage and projected cost will appear once provider resources are connected."/></div></>}
function Settings(){return <><Header title="Settings"/><div className="vc-settings"><button className="active"><strong>General</strong><small>Workspace identity and defaults</small></button><button><strong>Security</strong><small>MFA, sessions and security policy</small></button><button><strong>Authentication</strong><small>OAuth and sign-in policy</small></button><button><strong>Members</strong><small>Roles and access</small></button><button><strong>API Keys</strong><small>Programmatic access</small></button><button><strong>Connected Accounts</strong><small>Git and provider connections</small></button><button><strong>Danger Zone</strong><small>Destructive workspace actions</small></button></div></>}
function ProjectSettings(){return <><div className="vc-settings-project"><nav>{["General","Build & Deployment","Environment Variables","Git","Integrations","Deployment Protection","Functions","Cron Jobs","Members","Webhooks","Drains","Security","Advanced"].map(x=><button key={x}>{x}<ChevronRight size={13}/></button>)}</nav><div className="vc-card"><h2>General</h2><p>Project identity, runtime defaults and deployment configuration.</p><Row icon={Box} title="Project name" detail="uscs"/><Row icon={Code2} title="Framework & build" detail="Configured from project settings"/><Row icon={KeyRound} title="Environment Variables" detail="Scoped by environment"/></div></div></>}
function Simple({title,icon:Icon,text}:{title:string;icon:Icon;text:string}){return <><Header title={title}/><div className="vc-card"><Empty title={title+" is not configured"} body={text+" USCS will expose verified provider-backed state here."} action="Configure"/></div></>}
function Stat({label,value}:{label:string;value:string}){return <div className="vc-stat"><small>{label}</small><strong>{value}</strong></div>}
function Meta({k,v,good}:{k:string;v:string;good?:boolean}){return <div className="vc-meta"><small>{k}</small><strong className={good?"green":""}>{v}</strong></div>}
function GitHubMark(){return <span className="vc-gh">◉</span>}
