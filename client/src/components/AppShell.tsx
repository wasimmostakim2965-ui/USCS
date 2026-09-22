import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Bell, ChevronDown, ChevronLeft, ChevronRight, Command, LogOut, Menu, Moon, Search, Settings, Sun } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTheme } from "@/contexts/ThemeContext";
import { trpc } from "@/lib/trpc";
import "@/styles/control-plane.css";
import { AppShell as Shell, Button, EmptyState, PageHeader } from "@/components/ui-kit";
import { legacyPageForPath, projectNav, projectItem, workspaceItem, workspaceNav } from "@/pages/dashboard/navigation";
import Overview from "@/pages/dashboard/Overview";
import Projects from "@/pages/dashboard/Projects";
import Deployments from "@/pages/dashboard/Deployments";
import Domains from "@/pages/dashboard/Domains";
import Data from "@/pages/dashboard/Data";
import Security from "@/pages/dashboard/Security";
import Observability from "@/pages/dashboard/Observability";
import Developer from "@/pages/dashboard/Developer";
import Billing from "@/pages/dashboard/Billing";
import SettingsPage from "@/pages/dashboard/Settings";

export type AppShellProps = { user: { id?: string | null; name?: string | null; email?: string | null; role?: string | null } | null; logout: () => void };
const partsOf = (location: string) => location.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);
const isUuid = (value?: string) => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));

function ComingPage({ title }: { title: string }) { return <><PageHeader title={title} /><EmptyState title={`${title} is not configured`} body="This surface stays visible for discoverability, but no provider data is fabricated. Connect the corresponding adapter to enable it." /></>; }

export default function AppShell({ user, logout }: AppShellProps) {
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const parts = partsOf(location);
  const projectId = parts[0] === "projects" && isUuid(parts[1]) ? parts[1] : undefined;
  const projects = trpc.workspace.projects.list.useQuery(undefined, { enabled: Boolean(projectId), retry: false });
  const project = projects.data?.find(item => item.id === projectId);
  const workspace = workspaceItem(parts[0]);
  const projectSection = projectId ? projectItem(parts[2]) : undefined;
  const sectionPath = projectId ? parts[2] : parts[1];
  const navigate = (path: string) => { setLocation(path); setMobileOpen(false); window.scrollTo({ top: 0 }); };
  const initials = (user?.name || user?.email || "U").trim().slice(0, 1).toUpperCase();
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(value => !value); } }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, []);
  const content = useMemo<ReactNode>(() => {
    if (projectId) {
      if (!project) return <EmptyState title="Loading project" body="The project is being resolved from the live workspace." />;
      if (!parts[2]) return <Projects routeParts={parts} onOpen={() => undefined} onNavigate={navigate} />;
      if (["deployments"].includes(parts[2])) return <Deployments routeParts={["deployments", ...parts.slice(3)]} onNavigate={navigate} onOpen={() => undefined} />;
      if (["domains"].includes(parts[2])) return <Domains routeParts={["domains", ...parts.slice(3)]} onNavigate={navigate} />;
      if (["security"].includes(parts[2])) return <Security routeParts={["security", ...parts.slice(3)]} onNavigate={navigate} />;
      if (["database", "storage"].includes(parts[2])) return <Data routeParts={["data", parts[2] === "database" ? "databases" : "storage-buckets", ...parts.slice(3)]} onNavigate={navigate} />;
      return <ComingPage title={projectSection?.label ?? "Project section"} />;
    }
    const page = legacyPageForPath[workspace.path] ?? workspace.path;
    if (page === "overview") return <Overview routeParts={parts} onProjects={() => navigate("/dashboard/projects")} onOpenProject={id => id && navigate(`/dashboard/projects/${id}`)} />;
    if (page === "projects") return <Projects routeParts={parts} onOpen={id => id && navigate(`/dashboard/projects/${id}`)} onNavigate={navigate} />;
    if (page === "deployments") return <Deployments routeParts={parts} onNavigate={navigate} onOpen={() => undefined} />;
    if (page === "domains") return <Domains routeParts={parts} onNavigate={navigate} />;
    if (page === "data") return <Data routeParts={["data", workspace.path === "storage" ? "storage-buckets" : workspace.path === "database" ? "databases" : parts[1] ?? "databases"]} onNavigate={navigate} />;
    if (page === "security") return <Security routeParts={parts} onNavigate={navigate} />;
    if (page === "observability") return <Observability routeParts={parts} onNavigate={navigate} />;
    if (page === "developer") return <Developer routeParts={parts} onNavigate={navigate} />;
    if (page === "billing") return <Billing routeParts={parts} />;
    if (page === "settings") return <SettingsPage routeParts={parts} onNavigate={navigate} />;
    return <ComingPage title={workspace.label} />;
  }, [location, projectId, project?.id, workspace.path, parts.join("/"), projectSection?.label]);
  const activePath = projectId ? parts[2] ?? "" : workspace.path;
  return <Shell>
    <aside className={`ui-sidebar ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "is-mobile-open" : ""}`}>
      <div className="ui-brand"><span className="ui-brand-mark">W</span>{!collapsed && <button className="ui-scope" onClick={() => navigate("/dashboard/settings/workspace")}><strong>Cloud Wai</strong><small>{organizations.data?.[0]?.name ?? "Workspace"}</small></button>}<button className="ui-collapse" onClick={() => setCollapsed(value => !value)} aria-label="Toggle sidebar"><ChevronLeft size={15} /></button><button className="ui-mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation">×</button></div>
      {!collapsed && <button className="ui-find" onClick={() => setCommandOpen(true)}><Search size={14} /><span>Find</span><kbd>⌘K</kbd></button>}
      <nav className="ui-sidebar-nav" aria-label="Dashboard navigation">{projectId ? <><button className="ui-back" onClick={() => navigate("/dashboard/projects")}><ChevronLeft size={14} /> Workspace</button><div className="ui-project-name"><strong>{project?.name ?? "Project"}</strong><small>{project?.slug ?? "Resolving…"}</small></div>{projectNav.map(item => { const Icon = item.icon; const active = item.path === activePath; return <button key={item.label} className={`ui-nav-item ${active ? "active" : ""}`} onClick={() => navigate(`/dashboard/projects/${projectId}${item.path ? `/${item.path}` : ""}`)} title={collapsed ? item.label : undefined}><Icon size={15} /><span>{!collapsed && item.label}</span></button>; })}</> : workspaceNav.map(item => { const Icon = item.icon; const active = item.path === activePath; return <div key={item.path}><div className="ui-nav-row"><button className={`ui-nav-item ${active ? "active" : ""}`} onClick={() => navigate(`/dashboard/${item.path}`)} title={collapsed ? item.label : undefined}><Icon size={15} /><span>{!collapsed && item.label}</span></button>{!collapsed && item.children?.length ? <ChevronRight size={13} className="ui-nav-drill" /> : null}</div></div>; })}</nav>
      {!collapsed && <div className="ui-sidebar-foot"><span>Connected control plane</span><button onClick={() => navigate("/dashboard/settings")}><Settings size={14} /> Settings</button></div>}
    </aside>
    <main className="ui-main"><header className="ui-topbar"><button className="ui-mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={18} /></button><div className="ui-top-scope"><span>{projectId ? "Project" : "Workspace"}</span><b>›</b><strong>{projectId ? project?.name ?? "Project" : organizations.data?.[0]?.name ?? "Cloud Wai"}</strong></div><div className="ui-top-title">{projectId ? projectSection?.label ?? "Overview" : workspace.label}</div><div className="ui-top-actions"><Button variant="ghost" onClick={() => setCommandOpen(true)}><Command size={14} /> Find</Button><Button variant="ghost" onClick={() => navigate("/dashboard/observability/alerts")} aria-label="Open alerts"><Bell size={15} /></Button><DropdownMenu><DropdownMenuTrigger asChild><button className="ui-avatar" aria-label="Open account menu">{initials}</button></DropdownMenuTrigger><DropdownMenuContent align="end" sideOffset={8}><DropdownMenuLabel>{user?.name || "Account"}<small className="block text-xs font-normal text-muted-foreground">{user?.email || "Signed-in workspace"}</small></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => navigate("/dashboard/settings")}><Settings size={14} /> Account Settings</DropdownMenuItem><DropdownMenuItem onSelect={() => navigate("/dashboard/developer/api-keys")}><Search size={14} /> API Tokens</DropdownMenuItem><DropdownMenuItem onSelect={() => toggleTheme?.()}>{theme === "dark" ? <Sun size={14} /> : <Moon size={14} />} Toggle theme</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={logout}><LogOut size={14} /> Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></header><div className="ui-content">{content}</div></main>
    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}><CommandInput placeholder="Find a dashboard section…" /><CommandList><CommandEmpty>No section found.</CommandEmpty><CommandGroup heading={projectId ? "Project" : "Workspace"}>{(projectId ? projectNav : workspaceNav).map(item => <CommandItem key={item.path + item.label} value={item.label} onSelect={() => { navigate(projectId ? `/dashboard/projects/${projectId}${item.path ? `/${item.path}` : ""}` : `/dashboard/${item.path}`); setCommandOpen(false); }}><item.icon size={14} />{item.label}</CommandItem>)}</CommandGroup></CommandList></CommandDialog>
  </Shell>;
}
