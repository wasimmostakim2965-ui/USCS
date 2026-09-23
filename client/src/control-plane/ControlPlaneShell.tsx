import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bell, ChevronDown, Command, Menu, Search, UserCircle2 } from "lucide-react";
import { useLocation } from "wouter";
import { workspaceNavigation, projectNavigation, findNavItem, type NavItem } from "./navigation";
import { trpc } from "@/lib/trpc";
import "@/styles/control-plane-v2.css";

type User = { name?: string | null; email?: string | null } | null;
type Props = { user: User; logout: () => void };

function Placeholder({ item }: { item: NavItem }) {
  return <section className="cp-page"><div className="cp-breadcrumb">Cloud Wai <span>/</span> {item.label}</div><div className="cp-page-heading"><div><p className="cp-eyebrow">CONTROL PLANE</p><h1>{item.label}</h1><p>{item.description ?? "Manage this resource from the control plane."}</p></div></div><div className="cp-empty"><div className="cp-empty-icon"><item.icon size={20} /></div><h2>{item.label} is ready for implementation</h2><p>This surface is intentionally honest while its live resource flow is being connected. No infrastructure data is fabricated.</p></div></section>;
}

function Overview({ onProjects }: { onProjects: () => void }) {
  return <section className="cp-page"><div className="cp-breadcrumb">Cloud Wai <span>/</span> Overview</div><div className="cp-page-heading"><div><p className="cp-eyebrow">WORKSPACE</p><h1>Overview</h1><p>A calm, operational view of everything running in this workspace.</p></div><button className="cp-button cp-button-primary" onClick={onProjects}>View projects</button></div><div className="cp-grid cp-grid-four"><div className="cp-card cp-metric"><span>Projects</span><strong>—</strong><small>Live workspace data</small></div><div className="cp-card cp-metric"><span>Deployments</span><strong>—</strong><small>Production and preview</small></div><div className="cp-card cp-metric"><span>Domains</span><strong>—</strong><small>Connected domains</small></div><div className="cp-card cp-metric"><span>Security</span><strong>—</strong><small>Current posture</small></div></div><div className="cp-card cp-section-card"><div><h2>Workspace activity</h2><p>Recent deployments, events and resource changes will appear here.</p></div><span className="cp-muted">No activity loaded</span></div></section>;
}

function Projects({ onOpen }: { onOpen: (id: string) => void }) {
  const projects = trpc.workspace.projects.list.useQuery(undefined, { retry: false });
  return <section className="cp-page"><div className="cp-breadcrumb">Cloud Wai <span>/</span> Projects</div><div className="cp-page-heading"><div><p className="cp-eyebrow">WORKSPACE</p><h1>Projects</h1><p>Projects are the boundary for deployments, domains and runtime configuration.</p></div><button className="cp-button cp-button-primary" disabled title="Project creation will be wired to the existing projects.create mutation">Add New</button></div><div className="cp-toolbar"><button className="cp-scope-select">All Projects <ChevronDown size={14} /></button><label className="cp-search"><Search size={15} /><input placeholder="Search projects" /></label><div className="cp-tabs"><button className="is-active">All</button><button>Recent</button><button>Alerts</button></div></div>{projects.isLoading ? <div className="cp-card cp-loading">Loading projects…</div> : projects.error ? <div className="cp-card cp-error">Unable to load projects. {projects.error.message}</div> : projects.data?.length ? <div className="cp-project-grid">{projects.data.map(project => <button className="cp-card cp-project-card" key={project.id} onClick={() => onOpen(project.id)}><div className="cp-project-mark">{project.name.slice(0, 1).toUpperCase()}</div><div><strong>{project.name}</strong><span>{project.slug ?? "Project"}</span><small>Open project overview</small></div><ChevronDown className="cp-project-arrow" size={16} /></button>)}</div> : <div className="cp-empty"><div className="cp-empty-icon"><Search size={20} /></div><h2>No projects yet</h2><p>Projects created in the workspace will appear here.</p></div>}</section>;
}

export default function ControlPlaneShell({ user, logout }: Props) {
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const parts = location.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);
  const projectId = parts[0] === "projects" ? parts[1] : undefined;
  const isProject = Boolean(projectId);
  const sectionSlug = isProject ? parts[2] ?? "" : parts[0] ?? "";
  const nav = isProject ? projectNavigation : workspaceNavigation;
  const active = findNavItem(nav, sectionSlug);
  const orgs = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const projects = trpc.workspace.projects.list.useQuery(undefined, { enabled: Boolean(projectId), retry: false });
  const project = projects.data?.find(item => item.id === projectId);
  const go = (path: string) => { setLocation(path); setMobileOpen(false); window.scrollTo({ top: 0 }); };
  const projectBase = `/dashboard/projects/${projectId}`;
  const href = (item: NavItem) => isProject ? `${projectBase}${item.slug ? `/${item.slug}` : ""}` : `/dashboard${item.slug ? `/${item.slug}` : ""}`;
  const initials = (user?.name ?? user?.email ?? "U").slice(0, 1).toUpperCase();
  const commandItems = useMemo(() => nav, [nav]);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(open => !open); } }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, []);
  const content = isProject ? <Placeholder item={active} /> : !sectionSlug ? <Overview onProjects={() => go("/dashboard/projects")} /> : sectionSlug === "projects" ? <Projects onOpen={id => go(`/dashboard/projects/${id}`)} /> : <Placeholder item={active} />;
  return <div className="cp-shell"><aside className={`cp-sidebar ${mobileOpen ? "is-open" : ""}`}><div className="cp-sidebar-head"><div className="cp-logo">W</div><button className="cp-workspace-switcher" onClick={() => go("/dashboard")}><strong>{isProject ? project?.name ?? "Project" : "Cloud Wai"}</strong><span>{isProject ? "Project" : orgs.data?.[0]?.name ?? "Workspace"}</span></button><button className="cp-mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation">×</button></div>{isProject && <button className="cp-back" onClick={() => go("/dashboard/projects")}><ArrowLeft size={14} /> Workspace</button>}<button className="cp-find" onClick={() => setCommandOpen(true)}><Search size={15} /><span>Find</span><kbd>⌘K</kbd></button><nav className="cp-nav" aria-label={isProject ? "Project navigation" : "Workspace navigation"}>{nav.map(item => <button key={item.label} className={`cp-nav-item ${active.label === item.label ? "is-active" : ""}`} onClick={() => go(href(item))}><item.icon size={16} /><span>{item.label}</span></button>)}</nav></aside><main className="cp-main"><header className="cp-topbar"><button className="cp-mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu size={18} /></button><div className="cp-top-title">{isProject ? project?.name ?? "Project" : "Overview"}</div><div className="cp-top-actions"><button className="cp-top-action" onClick={() => setCommandOpen(true)}><Command size={15} /> Find</button><button className="cp-icon-button" aria-label="Notifications"><Bell size={17} /></button><button className="cp-avatar" onClick={() => go("/dashboard/settings")} aria-label="Account menu">{initials}</button></div></header>{content}</main>{commandOpen && <div className="cp-command-backdrop" onClick={() => setCommandOpen(false)}><div className="cp-command" onClick={event => event.stopPropagation()}><div className="cp-command-input"><Search size={16} /><input autoFocus placeholder="Find a section…" onKeyDown={event => { if (event.key === "Escape") setCommandOpen(false); }} /></div>{commandItems.map(item => <button key={item.label} onClick={() => { go(href(item)); setCommandOpen(false); }}><item.icon size={15} />{item.label}</button>)}<div className="cp-command-foot"><UserCircle2 size={14} /> {user?.email ?? "Signed-in workspace"} <button onClick={logout}>Sign out</button></div></div></div>}</div>;
}
