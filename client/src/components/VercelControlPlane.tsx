import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Bell, ChevronDown, ChevronRight, CircleHelp, KeyRound, LogOut, Menu, MoreHorizontal, Moon, Settings2, Sun, UserCircle, X } from "lucide-react";
import "@/styles/control-plane.css";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTheme } from "@/contexts/ThemeContext";
import { trpc } from "@/lib/trpc";
import {
  dashboardHref,
  dashboardItemFromSlug,
  dashboardNav,
  dashboardChildFromSlug,
  dashboardPageFromSlug,
  dashboardPath,
  type DashboardNavItem,
  type DashboardPage,
} from "@/pages/dashboard/navigation";
import Overview from "@/pages/dashboard/Overview";
import Projects from "@/pages/dashboard/Projects";
import Deployments from "@/pages/dashboard/Deployments";
import Domains from "@/pages/dashboard/Domains";
import Data from "@/pages/dashboard/Data";
import Security from "@/pages/dashboard/Security";
import Observability from "@/pages/dashboard/Observability";
import Developer from "@/pages/dashboard/Developer";
import Billing from "@/pages/dashboard/Billing";
import Settings from "@/pages/dashboard/Settings";

type Props = { user: { id?: string | null; name?: string | null; email?: string | null; loginMethod?: string | null; role?: string | null } | null; logout: () => void };
const projectSettings = [
  { label: "Overview", path: "" },
  { label: "Deployments", path: "deployments" },
  { label: "Domains", path: "domains" },
  { label: "Env Vars", path: "env-vars" },
  { label: "Git", path: "git" },
  { label: "Functions", path: "functions" },
  { label: "Settings", path: "settings" },
] as const;

function routeParts(location: string) {
  return location.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);
}

function SectionTabs({ item, childPath, navigate }: { item: DashboardNavItem; childPath?: string; navigate: (href: string) => void }) {
  return <nav className="vc-tabs vc-route-tabs" aria-label={`${item.label} sections`}>
    {item.children.map(child => <button key={child.path} className={child.path === childPath ? "active" : ""} onClick={() => navigate(dashboardHref(item, child))}>{child.label}</button>)}
  </nav>;
}

function CommandPalette({ open, onOpenChange, navigate }: { open: boolean; onOpenChange: (open: boolean) => void; navigate: (href: string) => void }) {
  return <CommandDialog open={open} onOpenChange={onOpenChange}>
    <CommandInput placeholder="Search Cloud Wai…" />
    <CommandList>
      <CommandEmpty>No matching route.</CommandEmpty>
      <CommandGroup heading="Navigate">
        {dashboardNav.flatMap(item => [
          <CommandItem key={item.path} value={item.label} onSelect={() => { navigate(dashboardHref(item)); onOpenChange(false); }}>
            <item.icon size={15} /><span>{item.label}</span><CommandShortcut>Section</CommandShortcut>
          </CommandItem>,
          ...item.children.map(child => <CommandItem key={`${item.path}/${child.path}`} value={`${item.label} ${child.label}`} onSelect={() => { navigate(dashboardHref(item, child)); onOpenChange(false); }}>
            <ChevronRight size={14} /><span>{item.label} / {child.label}</span>
          </CommandItem>),
        ])}
      </CommandGroup>
    </CommandList>
  </CommandDialog>;
}

export default function VercelControlPlane({ user, logout }: Props) {
  const [location, setLocation] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const [expanded, setExpanded] = useState<string[]>(["Overview"]);
  const parts = routeParts(location);
  const projectId = parts[0] === "projects" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parts[1] ?? "") ? parts[1] : undefined;
  const projectsQuery = trpc.workspace.projects.list.useQuery(undefined, { enabled: Boolean(projectId), retry: false });
  const project = projectsQuery.data?.find(entry => entry.id === projectId);
  const projectSection = parts[2] ?? "";
  const item = dashboardItemFromSlug(parts[0]);
  const child = dashboardChildFromSlug(item, parts[1]);
  const page = dashboardPageFromSlug(parts[0]);
  const go = (target: DashboardPage) => { setLocation(`/dashboard/${dashboardPath(target)}`); setMobile(false); window.scrollTo({ top: 0 }); };
  const navigate = (href: string) => { setLocation(href); setMobile(false); window.scrollTo({ top: 0 }); };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(value => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const toggleGroup = (label: string) => setExpanded(value => value.includes(label) ? value.filter(entry => entry !== label) : [...value, label]);
  const content: ReactNode = page === "Overview" ? <Overview routeParts={parts} onProjects={() => go("Projects")} onOpenProject={id => navigate(`/dashboard/projects/${id ?? "new"}`)} />
    : page === "Projects" ? <Projects routeParts={parts} onOpen={id => navigate(`/dashboard/projects/${id ?? "new"}`)} />
    : page === "Deployments" ? <Deployments routeParts={parts} onNavigate={navigate} onOpen={id => navigate(`/dashboard/deployments/${id ?? "current"}`)} />
    : page === "Domains" ? <Domains routeParts={parts} onNavigate={navigate} /> : page === "Data" ? <Data routeParts={parts} onNavigate={navigate} /> : page === "Security" ? <Security routeParts={parts} onNavigate={navigate} />
    : page === "Observability" ? <Observability routeParts={parts} onNavigate={navigate} /> : page === "Developer" ? <Developer routeParts={parts} onNavigate={navigate} /> : page === "Billing" ? <Billing routeParts={parts} /> : <Settings routeParts={parts} onNavigate={navigate} />;
  const initials = (user?.name || user?.email || "U").trim().slice(0, 1).toUpperCase();
  return <div className={`vc-shell ${collapsed ? "collapsed" : ""}`}>
    <aside className={`vc-sidebar ${mobile ? "mobile" : ""}`}>
      <div className="vc-brand"><div className="vc-brand-dot">U</div><button className="vc-team" onClick={() => go("Settings")} aria-label="Open workspace settings"><strong>Cloud Wai</strong><span>Workspace</span><ChevronDown size={11} /></button><button className="vc-collapse" onClick={() => setCollapsed(value => !value)} aria-label="Toggle sidebar"><ChevronRight size={15} /></button><button className="vc-close" onClick={() => setMobile(false)} aria-label="Close menu"><X size={18} /></button></div>
      <nav className="vc-nav" aria-label="Primary navigation">{projectId ? <><button className="vc-nav-back" onClick={() => navigate("/dashboard/projects")} aria-label="Back to workspace navigation">← Workspace</button><div className="vc-project-context"><strong>{project?.name || "Project"}</strong><small>{project?.slug || "Loading project…"}</small></div>{projectSettings.map(setting => <button key={setting.path || "overview"} className={`vc-nav-item ${projectSection === setting.path ? "active" : ""}`} onClick={() => navigate(`/dashboard/projects/${projectId}${setting.path ? `/${setting.path}` : ""}`)}><span>{setting.label}</span></button>)}</> : dashboardNav.map(({ label, icon: Icon, children: subRoutes, path }) => { const active = item.label === label; const open = expanded.includes(label) || active; return <div key={label}>
        <div className="vc-nav-group"><button className={`vc-nav-item ${active ? "active" : ""}`} onClick={() => { go(label); if (subRoutes.length) setExpanded(value => value.includes(label) ? value : [...value, label]); }}><Icon size={15} /><span>{label}</span></button>{subRoutes.length > 0 && <button className="vc-nav-chevron" onClick={() => toggleGroup(label)} aria-label={`${open ? "Collapse" : "Expand"} ${label}`}><ChevronDown size={13} className={open ? "" : "-rotate-90"} /></button>}</div>
        {open && <div className="vc-subnav">{subRoutes.map(subRoute => <button key={subRoute.path} className={child?.path === subRoute.path ? "active" : ""} onClick={() => navigate(`/dashboard/${path}/${subRoute.path}`)}><span>{subRoute.label}</span>{child?.path === subRoute.path && <ChevronRight size={12} />}</button>)}</div>}
      </div>; })}</nav>
      <div className="vc-nav-bottom"><span className="vc-nav-note">Connected control plane</span></div>
      <div className="vc-account-wrap"><button className="vc-account" onClick={() => go("Settings")}><span>{initials}</span><div><strong>{user?.name || "Account"}</strong><small>Account settings</small></div><MoreHorizontal size={15} /></button></div>
    </aside>
    <main className="vc-main"><header className="vc-topbar"><button className="vc-mobile-menu" onClick={() => setMobile(true)} aria-label="Open menu"><Menu size={19} /></button><div className="vc-top-crumb"><button onClick={() => go("Overview")}>Cloud Wai</button><ChevronRight size={13} />{projectId ? <><button onClick={() => navigate("/dashboard/projects")}>Projects</button><ChevronRight size={13} /><button onClick={() => navigate(`/dashboard/projects/${projectId}`)}>{project?.name || "Project"}</button>{projectSection && <><ChevronRight size={13} /><strong>{projectSection.replaceAll("-", " ")}</strong></>}</> : <><button onClick={() => go(page)}>{page}</button>{child && <><ChevronRight size={13} /><strong>{child.label}</strong></>}</>}</div><div className="vc-top-actions"><button className="vc-top-icon" onClick={() => setCommandOpen(true)} aria-label="Open command palette"><span className="vc-command-hint">⌘K</span></button><button className="vc-top-icon" onClick={() => navigate("/dashboard/observability/alerts")} aria-label="Open notifications"><Bell size={16} /></button><button className="vc-top-icon" onClick={() => go("Settings")} aria-label="Help"><CircleHelp size={16} /></button><DropdownMenu><DropdownMenuTrigger asChild><button className="vc-avatar" aria-label="Open account menu">{initials}</button></DropdownMenuTrigger><DropdownMenuContent align="end" sideOffset={8} className="w-56"><DropdownMenuLabel><span className="block">{user?.name || "Account"}</span><span className="text-xs font-normal text-muted-foreground">{user?.email || "Signed-in workspace"}</span></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => go("Settings")}><UserCircle size={15} /> Account Settings</DropdownMenuItem><DropdownMenuItem onSelect={() => navigate("/dashboard/developer/api-keys")}><KeyRound size={15} /> API Tokens</DropdownMenuItem><DropdownMenuItem onSelect={() => toggleTheme?.()}>{theme === "dark" ? <Sun size={15} /> : <Moon size={15} />} {theme === "dark" ? "Use light theme" : "Use dark theme"}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={logout}><LogOut size={15} /> Sign out</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></header><div className="vc-content">{projectId ? null : <SectionTabs item={item} childPath={child?.path} navigate={navigate} />}{content}</div></main>
    <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} navigate={navigate} />
  </div>;
}
