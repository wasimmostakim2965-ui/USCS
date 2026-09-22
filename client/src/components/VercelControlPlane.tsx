import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Bell, ChevronDown, ChevronRight, CircleHelp, LayoutDashboard, Menu, MoreHorizontal, X } from "lucide-react";
import "@/styles/control-plane.css";
import { dashboardNav, dashboardPageFromSlug, dashboardPath, type DashboardPage } from "@/pages/dashboard/navigation";
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

export default function VercelControlPlane({ user, logout }: Props) {
  const [location, setLocation] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const routeParts = location.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);
  const page = dashboardPageFromSlug(routeParts[0]);
  const go = (target: DashboardPage) => { setLocation(`/dashboard/${dashboardPath(target)}`); setMobile(false); window.scrollTo({ top: 0 }); };
  const openProject = (id?: string) => setLocation(`/dashboard/projects/${id ?? "new"}`);
  const content: ReactNode = page === "Overview" ? <Overview onProjects={() => go("Projects")} onOpenProject={openProject} />
    : page === "Projects" ? <Projects onOpen={openProject} />
    : page === "Deployments" ? <Deployments onOpen={id => setLocation(`/dashboard/deployments/${id ?? "current"}`)} />
    : page === "Domains" ? <Domains /> : page === "Data" ? <Data /> : page === "Security" ? <Security />
    : page === "Observability" ? <Observability /> : page === "Developer" ? <Developer /> : page === "Billing" ? <Billing /> : <Settings />;
  const initials = (user?.name || user?.email || "U").trim().slice(0, 1).toUpperCase();
  return <div className={`vc-shell ${collapsed ? "collapsed" : ""}`}>
    <aside className={`vc-sidebar ${mobile ? "mobile" : ""}`}>
      <div className="vc-brand"><div className="vc-brand-dot">U</div><div className="vc-team"><strong>Cloud Wai</strong><span>Workspace</span><ChevronDown size={11} /></div><button className="vc-collapse" onClick={() => setCollapsed(value => !value)} aria-label="Toggle sidebar"><ChevronRight size={15} /></button><button className="vc-close" onClick={() => setMobile(false)} aria-label="Close menu"><X size={18} /></button></div>
      <nav className="vc-nav">{dashboardNav.map(({ label, icon: Icon }) => <button key={label} className={`vc-nav-item ${page === label ? "active" : ""}`} onClick={() => go(label)}><Icon size={15} /><span>{label}</span></button>)}</nav>
      <div className="vc-nav-bottom"><span className="vc-nav-note">Connected control plane</span></div>
      <div className="vc-account-wrap"><button className="vc-account" onClick={() => setAccountOpen(value => !value)}><span>{initials}</span><div><strong>{user?.name || "Account"}</strong><small>Account menu</small></div><MoreHorizontal size={15} /></button>{accountOpen && <div className="vc-account-menu"><button onClick={() => go("Settings")}>Account Settings</button><button onClick={logout}>Sign out</button></div>}</div>
    </aside>
    <main className="vc-main"><header className="vc-topbar"><button className="vc-mobile-menu" onClick={() => setMobile(true)} aria-label="Open menu"><Menu size={19} /></button><div className="vc-top-crumb"><button onClick={() => go("Overview")}>Cloud Wai</button><ChevronRight size={13} /><strong>{page}</strong></div><div className="vc-top-actions"><button className="vc-top-icon" aria-label="Notifications"><Bell size={16} /></button><button className="vc-top-icon" onClick={() => go("Settings")} aria-label="Help"><CircleHelp size={16} /></button><button className="vc-avatar" onClick={() => setAccountOpen(value => !value)}>{initials}</button></div></header><div className="vc-content">{content}</div></main>
  </div>;
}
