import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Bell, ChevronDown, ChevronRight, CircleHelp, Menu, MoreHorizontal, X } from "lucide-react";
import "@/styles/control-plane.css";
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

function routeParts(location: string) {
  return location.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);
}

function SectionTabs({ item, childPath, navigate }: { item: DashboardNavItem; childPath?: string; navigate: (href: string) => void }) {
  return <nav className="vc-tabs vc-route-tabs" aria-label={`${item.label} sections`}>
    {item.children.map(child => <button key={child.path} className={child.path === childPath ? "active" : ""} onClick={() => navigate(dashboardHref(item, child))}>{child.label}</button>)}
  </nav>;
}

export default function VercelControlPlane({ user, logout }: Props) {
  const [location, setLocation] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [expanded, setExpanded] = useState<string[]>(["Overview"]);
  const parts = routeParts(location);
  const item = dashboardItemFromSlug(parts[0]);
  const child = dashboardChildFromSlug(item, parts[1]);
  const page = dashboardPageFromSlug(parts[0]);
  const go = (target: DashboardPage) => { setLocation(`/dashboard/${dashboardPath(target)}`); setMobile(false); window.scrollTo({ top: 0 }); };
  const navigate = (href: string) => { setLocation(href); setMobile(false); window.scrollTo({ top: 0 }); };
  const toggleGroup = (label: string) => setExpanded(value => value.includes(label) ? value.filter(entry => entry !== label) : [...value, label]);
  const content: ReactNode = page === "Overview" ? <Overview onProjects={() => go("Projects")} onOpenProject={id => navigate(`/dashboard/projects/${id ?? "new"}`)} />
    : page === "Projects" ? <Projects onOpen={id => navigate(`/dashboard/projects/${id ?? "new"}`)} />
    : page === "Deployments" ? <Deployments routeParts={parts} onNavigate={navigate} onOpen={id => navigate(`/dashboard/deployments/${id ?? "current"}`)} />
    : page === "Domains" ? <Domains routeParts={parts} onNavigate={navigate} /> : page === "Data" ? <Data routeParts={parts} onNavigate={navigate} /> : page === "Security" ? <Security routeParts={parts} onNavigate={navigate} />
    : page === "Observability" ? <Observability routeParts={parts} onNavigate={navigate} /> : page === "Developer" ? <Developer /> : page === "Billing" ? <Billing /> : <Settings />;
  const initials = (user?.name || user?.email || "U").trim().slice(0, 1).toUpperCase();
  return <div className={`vc-shell ${collapsed ? "collapsed" : ""}`}>
    <aside className={`vc-sidebar ${mobile ? "mobile" : ""}`}>
      <div className="vc-brand"><div className="vc-brand-dot">U</div><div className="vc-team"><strong>Cloud Wai</strong><span>Workspace</span><ChevronDown size={11} /></div><button className="vc-collapse" onClick={() => setCollapsed(value => !value)} aria-label="Toggle sidebar"><ChevronRight size={15} /></button><button className="vc-close" onClick={() => setMobile(false)} aria-label="Close menu"><X size={18} /></button></div>
      <nav className="vc-nav" aria-label="Primary navigation">{dashboardNav.map(({ label, icon: Icon, children: subRoutes, path }) => { const active = item.label === label; const open = expanded.includes(label) || active; return <div key={label}>
        <div className="vc-nav-group"><button className={`vc-nav-item ${active ? "active" : ""}`} onClick={() => { go(label); if (subRoutes.length) setExpanded(value => value.includes(label) ? value : [...value, label]); }}><Icon size={15} /><span>{label}</span></button>{subRoutes.length > 0 && <button className="vc-nav-chevron" onClick={() => toggleGroup(label)} aria-label={`${open ? "Collapse" : "Expand"} ${label}`}><ChevronDown size={13} className={open ? "" : "-rotate-90"} /></button>}</div>
        {open && <div className="vc-subnav">{subRoutes.map(subRoute => <button key={subRoute.path} className={child?.path === subRoute.path ? "active" : ""} onClick={() => navigate(`/dashboard/${path}/${subRoute.path}`)}><span>{subRoute.label}</span>{child?.path === subRoute.path && <ChevronRight size={12} />}</button>)}</div>}
      </div>; })}</nav>
      <div className="vc-nav-bottom"><span className="vc-nav-note">Connected control plane</span></div>
      <div className="vc-account-wrap"><button className="vc-account" onClick={() => setAccountOpen(value => !value)}><span>{initials}</span><div><strong>{user?.name || "Account"}</strong><small>Account menu</small></div><MoreHorizontal size={15} /></button>{accountOpen && <div className="vc-account-menu"><button onClick={() => go("Settings")}>Account Settings</button><button onClick={logout}>Sign out</button></div>}</div>
    </aside>
    <main className="vc-main"><header className="vc-topbar"><button className="vc-mobile-menu" onClick={() => setMobile(true)} aria-label="Open menu"><Menu size={19} /></button><div className="vc-top-crumb"><button onClick={() => go("Overview")}>Cloud Wai</button><ChevronRight size={13} /><button onClick={() => go(page)}>{page}</button>{child && <><ChevronRight size={13} /><strong>{child.label}</strong></>}</div><div className="vc-top-actions"><button className="vc-top-icon" aria-label="Notifications"><Bell size={16} /></button><button className="vc-top-icon" onClick={() => go("Settings")} aria-label="Help"><CircleHelp size={16} /></button><button className="vc-avatar" onClick={() => setAccountOpen(value => !value)}>{initials}</button></div></header><div className="vc-content"><SectionTabs item={item} childPath={child?.path} navigate={navigate} />{content}</div></main>
  </div>;
}
