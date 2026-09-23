import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Bell, ChevronLeft, ChevronRight, KeyRound, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Settings, Sun } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTheme } from "@/contexts/ThemeContext";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardHead, EmptyState, IconButton, LoadingBlock } from "@/components/ui-kit";
import { projectItem, projectNav, workspaceGroups, workspaceItem, workspaceNav, type NavItem } from "@/pages/dashboard/navigation";
import Overview from "@/pages/dashboard/Overview";
import Projects from "@/pages/dashboard/Projects";
import Deployments from "@/pages/dashboard/Deployments";
import Domains from "@/pages/dashboard/Domains";
import Data from "@/pages/dashboard/Data";
import Security from "@/pages/dashboard/Security";
import Observability from "@/pages/dashboard/Observability";
import Developer from "@/pages/dashboard/Developer";
import Team from "@/pages/dashboard/Team";
import Billing from "@/pages/dashboard/Billing";
import SettingsPage from "@/pages/dashboard/Settings";
import "@/styles/dashboard.css";

export type AppShellProps = { user: { id?: string | null; name?: string | null; email?: string | null; role?: string | null } | null; logout: () => void };

const partsOf = (location: string) => location.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);
const isUuid = (value?: string) => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));

function NotConfigured({ title }: { title: string }) {
  return <><Card><CardHead eyebrow="Not configured" title={title} description="This surface is discoverable but has no provider adapter connected yet." /></Card><Card style={{ marginTop: 16 }}><EmptyState title={`${title} requires a provider`} body="Connect the corresponding adapter to surface live data. Nothing is fabricated while the adapter is unavailable." /></Card></>;
}

export default function AppShell({ user, logout }: AppShellProps) {
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const { theme, toggleTheme } = useTheme();

  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const organization = organizations.data?.[0];

  const parts = partsOf(location);
  const projectId = parts[0] === "projects" && isUuid(parts[1]) ? parts[1] : undefined;
  const activeSection = projectId ? parts[2] ?? "" : parts[0] ?? "overview";
  const activeChild = projectId ? undefined : parts[1];

  const projects = trpc.workspace.projects.list.useQuery(undefined, { enabled: Boolean(projectId), retry: false });
  const project = projects.data?.find(item => item.id === projectId);
  const workspace = workspaceItem(parts[0]);
  const projectSection = projectId ? projectItem(parts[2]) : undefined;

  const navigate = useCallback((path: string) => {
    setLocation(path);
    setMobileOpen(false);
    window.scrollTo({ top: 0 });
  }, [setLocation]);

  // Auto-expand the group that owns the active section so refresh and deep
  // links land with the correct sidebar branch open.
  useEffect(() => {
    const group = workspaceGroups.find(candidate => candidate.items.includes((projectId ? workspace.label : workspace.label)));
    if (!group) return;
    setOpenGroups(current => (current[group.label] ? current : { ...current, [group.label]: true }));
  }, [location, projectId, workspace.label]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(value => !value);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const initials = (user?.name || user?.email || "U").trim().slice(0, 1).toUpperCase();
  const toggleGroup = (label: string) => setOpenGroups(current => ({ ...current, [label]: !current[label] }));

  const content = useMemo<ReactNode>(() => {
    if (projectId) {
      if (!project) return <LoadingBlock rows={4} />;
      if (!parts[2]) return <Projects routeParts={parts} onOpen={() => undefined} onNavigate={navigate} />;
      if (parts[2] === "deployments") return <Deployments routeParts={["deployments", ...parts.slice(3)]} onNavigate={navigate} onOpen={() => undefined} />;
      if (parts[2] === "domains") return <Domains routeParts={["domains", ...parts.slice(3)]} onNavigate={navigate} />;
      if (parts[2] === "security") return <Security routeParts={["security", ...parts.slice(3)]} onNavigate={navigate} />;
      if (parts[2] === "database") return <Data routeParts={["data", "databases", ...parts.slice(3)]} onNavigate={navigate} />;
      if (parts[2] === "storage") return <Data routeParts={["data", "storage-buckets", ...parts.slice(3)]} onNavigate={navigate} />;
      if (parts[2] === "observability") return <Observability routeParts={["observability", ...parts.slice(3)]} onNavigate={navigate} />;
      if (parts[2] === "environment-variables") return <Deployments routeParts={["deployments", ...parts.slice(3)]} onNavigate={navigate} onOpen={() => undefined} />;
      return <ComingProjectSection title={projectSection?.label ?? "Project section"} projectName={project.name} />;
    }
    switch (workspace.label) {
      case "Overview": return <Overview routeParts={parts} onProjects={() => navigate("/dashboard/projects")} onOpenProject={id => id && navigate(`/dashboard/projects/${id}`)} />;
      case "Projects": return <Projects routeParts={parts} onOpen={id => id && navigate(`/dashboard/projects/${id}`)} onNavigate={navigate} />;
      case "Deployments": return <Deployments routeParts={parts} onNavigate={navigate} onOpen={() => undefined} />;
      case "Domains": return <Domains routeParts={parts} onNavigate={navigate} />;
      case "Data": return <Data routeParts={parts} onNavigate={navigate} />;
      case "Security": return <Security routeParts={parts} onNavigate={navigate} />;
      case "Observability": return <Observability routeParts={parts} onNavigate={navigate} />;
      case "Developer": return <Developer routeParts={parts} onNavigate={navigate} />;
      case "Team": return <Team routeParts={parts} onNavigate={navigate} />;
      case "Billing": return <Billing routeParts={parts} onNavigate={navigate} />;
      case "Settings": return <SettingsPage routeParts={parts} onNavigate={navigate} />;
      default: return <NotConfigured title={workspace.label} />;
    }
  }, [location, projectId, project?.id, project?.name, workspace.label, parts.join("/"), projectSection?.label, navigate]);

  const renderWorkspaceNav = () => workspaceGroups.map(group => {
    const items = group.items.map(label => workspaceNav.find(item => item.label === label)!).filter(Boolean);
    const isOpen = openGroups[group.label] ?? false;
    return <div className={`ds-nav-group ${isOpen ? "is-open" : ""}`} key={group.label}>
      <button className="ds-nav-label" style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between" }} onClick={() => toggleGroup(group.label)} aria-expanded={isOpen}>
        {group.label}<ChevronRight size={13} style={{ transform: isOpen ? "rotate(90deg)" : "none", transition: "transform .16s" }} />
      </button>
      {isOpen ? <div className="ds-nav-children" style={{ marginLeft: 0, borderLeft: 0, paddingLeft: 0 }}>{items.map(item => {
        const Icon = item.icon;
        const active = item.path === activeSection;
        return <button key={item.path} className={`ds-nav-item ${active ? "is-active" : ""}`} onClick={() => navigate(`/dashboard/${item.path}`)} title={collapsed ? item.label : undefined}>
          <Icon size={15} /><span>{item.label}</span>
        </button>;
      })}</div> : null}
    </div>;
  });

  return <div className="ds">
    <aside className={`ds-sidebar ${collapsed ? "is-collapsed" : ""} ${mobileOpen ? "is-open" : ""}`}>
      <div className="ds-brand">
        <span className="ds-brand-mark">W</span>
        {!collapsed ? <button className="ds-scope" onClick={() => navigate("/dashboard/settings/workspace")}><strong>Cloud Wai</strong><small>{organization?.name ?? "Workspace"}</small></button> : null}
        <IconButton onClick={() => setCollapsed(value => !value)} aria-label="Toggle sidebar" style={{ display: collapsed ? "grid" : "grid" }}>{collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}</IconButton>
        <IconButton className="ds-mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation" style={{ display: mobileOpen ? "grid" : undefined }}><ChevronLeft size={15} /></IconButton>
      </div>
      {!collapsed ? <button className="ds-find" onClick={() => setCommandOpen(true)}><Search size={14} /><span>Find</span><kbd>⌘K</kbd></button> : null}
      <nav className="ds-nav" aria-label="Dashboard navigation">
        {projectId ? <>
          <button className="ds-nav-back" onClick={() => navigate("/dashboard/projects")}><ChevronLeft size={14} /> Workspace</button>
          <div className="ds-nav-scope"><strong>{project?.name ?? "Project"}</strong><small>{project?.slug ?? "Resolving…"}</small></div>
          {projectNav.map(item => {
            const Icon = item.icon;
            const active = item.path === activeSection;
            return <button key={item.label} className={`ds-nav-item ${active ? "is-active" : ""}`} onClick={() => navigate(`/dashboard/projects/${projectId}${item.path ? `/${item.path}` : ""}`)} title={collapsed ? item.label : undefined}><Icon size={15} /><span>{item.label}</span></button>;
          })}
        </> : renderWorkspaceNav()}
      </nav>
      <div className="ds-sidebar-foot">
        <button className="ds-account" onClick={logout} title="Sign out">
          <span className="ds-avatar">{initials}</span>
          {!collapsed ? <span className="ds-account-copy"><strong>{user?.name || "Account"}</strong><small>{user?.email || "Signed in"}</small></span> : null}
        </button>
      </div>
    </aside>

    <main className="ds-main">
      <header className="ds-topbar">
        <IconButton className="ds-menu-btn" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={18} /></IconButton>
        <nav className="ds-crumbs" aria-label="Breadcrumb">
          <span>{projectId ? "Project" : "Workspace"}</span><b>/</b>
          <strong>{projectId ? project?.name ?? "Project" : organization?.name ?? "Cloud Wai"}</strong>
          <b>/</b><span>{projectId ? projectSection?.label ?? "Overview" : workspace.label}</span>
          {activeChild && workspace.children.length ? <><b>/</b><span>{workspace.children.find(child => child.path === activeChild)?.label ?? activeChild}</span></> : null}
        </nav>
        <div className="ds-top-actions">
          <Button variant="ghost" size="sm" onClick={() => setCommandOpen(true)}><Search size={14} /> Find</Button>
          <IconButton onClick={() => navigate("/dashboard/observability/alerts")} aria-label="Open alerts"><Bell size={15} /></IconButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button className="ds-avatar" aria-label="Open account menu">{initials}</button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8}>
              <DropdownMenuLabel>{user?.name || "Account"}<small style={{ display: "block", fontWeight: 400, color: "var(--ds-fg-muted)" }}>{user?.email || organization?.name || "Signed-in workspace"}</small></DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate("/dashboard/settings/workspace")}><Settings size={14} /> Account settings</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate("/dashboard/developer/api-keys")}><KeyRound size={14} /> API keys</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => toggleTheme?.()}>{theme === "dark" ? <Sun size={14} /> : <Moon size={14} />} Toggle theme</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={logout}><LogOut size={14} /> Sign out</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <div className="ds-content">{content}</div>
    </main>

    <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
      <CommandInput placeholder="Find a dashboard section…" />
      <CommandList>
        <CommandEmpty>No section found.</CommandEmpty>
        {projectId
          ? <CommandGroup heading="Project">{projectNav.map(item => <CommandItem key={item.label} value={item.label} onSelect={() => { navigate(`/dashboard/projects/${projectId}${item.path ? `/${item.path}` : ""}`); setCommandOpen(false); }}><item.icon size={14} />{item.label}</CommandItem>)}</CommandGroup>
          : workspaceGroups.map(group => <CommandGroup key={group.label} heading={group.label}>
              {group.items.map(label => {
                const item = workspaceNav.find(candidate => candidate.label === label)!;
                const Icon = item.icon;
                const select = (path: string) => { navigate(path); setCommandOpen(false); };
                return <div key={item.path}>
                  <CommandItem value={item.label} onSelect={() => select(`/dashboard/${item.path}`)}><Icon size={14} />{item.label}</CommandItem>
                  {item.children.map(child => <CommandItem key={child.path} value={`${item.label} ${child.label}`} onSelect={() => select(`/dashboard/${item.path}/${child.path}`)}><span style={{ marginLeft: 18 }}>{child.label}</span></CommandItem>)}
                </div>;
              })}
            </CommandGroup>)}
      </CommandList>
    </CommandDialog>
  </div>;
}

function ComingProjectSection({ title, projectName }: { title: string; projectName: string }) {
  return <><Card><CardHead eyebrow={projectName} title={title} description="This project surface stays visible for discoverability and will expose live provider data once the matching adapter is configured." /></Card><Card style={{ marginTop: 16 }}><EmptyState title={`${title} is not configured`} body="No provider data is fabricated. Configure the project adapter to populate this view." /></Card></>;
}
