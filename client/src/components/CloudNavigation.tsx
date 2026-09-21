import {
  Activity,
  BarChart3,
  Box,
  Boxes,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Code2,
  Database,
  FileKey2,
  Globe2,
  HardDrive,
  Layers3,
  LifeBuoy,
  LockKeyhole,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings2,
  ShieldCheck,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

export type Section =
  | "Overview"
  | "Projects"
  | "Deployments"
  | "Domains"
  | "Data"
  | "Security"
  | "Observability"
  | "Developer"
  | "Team"
  | "Billing"
  | "Admin"
  | "Settings";

export type DomainView = "market" | "my-domains";

type NavigationItem = {
  label: string;
  section: Section;
  icon?: typeof Activity;
  available?: boolean;
  detail?: string;
};

type NavigationGroup = {
  label: string;
  icon: typeof Activity;
  items: NavigationItem[];
};

export const navigationGroups: NavigationGroup[] = [
  {
    label: "Build",
    icon: Wrench,
    items: [
      { label: "Projects", section: "Projects", icon: Box, available: true },
      { label: "Deployments", section: "Deployments", icon: Layers3, available: true },
      { label: "Domains", section: "Domains", icon: Globe2, available: true },
      { label: "Environment configuration", section: "Developer", available: true },
    ],
  },
  {
    label: "Data",
    icon: Database,
    items: [
      { label: "Databases", section: "Data", icon: Database, available: true },
      { label: "Storage", section: "Data", icon: HardDrive, available: true },
      { label: "Cache", section: "Data", available: false },
      { label: "Queues", section: "Data", available: false },
      { label: "Backups", section: "Data", available: false },
      { label: "Data transfers", section: "Data", available: false },
    ],
  },
  {
    label: "Security",
    icon: ShieldCheck,
    items: [
      { label: "Security overview", section: "Security", icon: ShieldCheck, available: true },
      { label: "Security center", section: "Security", available: true },
      { label: "Firewall", section: "Security", available: false },
      { label: "WAF", section: "Security", available: false },
      { label: "DDoS protection", section: "Security", available: false },
      { label: "Bot protection", section: "Security", available: false },
      { label: "Rate limiting", section: "Security", available: false },
      { label: "Access control", section: "Security", available: false },
      { label: "Authentication & MFA", section: "Security", available: false },
      { label: "Secrets", section: "Developer", available: true },
      { label: "Security audit", section: "Security", available: true },
    ],
  },
  {
    label: "Observe",
    icon: BarChart3,
    items: [
      { label: "Logs", section: "Observability", icon: ScrollText, available: true },
      { label: "Metrics", section: "Observability", available: false },
      { label: "Errors", section: "Observability", available: false },
      { label: "Requests", section: "Observability", available: false },
      { label: "Performance", section: "Observability", available: true },
      { label: "Uptime", section: "Observability", available: false },
      { label: "Alerts", section: "Observability", available: true },
    ],
  },
  {
    label: "Developer",
    icon: Code2,
    items: [
      { label: "GitHub", section: "Developer", icon: Code2, available: true },
      { label: "API keys", section: "Developer", available: false },
      { label: "Webhooks", section: "Developer", available: false },
      { label: "CLI & API", section: "Developer", available: false },
      { label: "Documentation", section: "Developer", available: true },
    ],
  },
  {
    label: "Workspace",
    icon: BriefcaseBusiness,
    items: [
      { label: "Team", section: "Team", icon: Users, available: true },
      { label: "Billing", section: "Billing", icon: CircleDollarSign, available: true },
      { label: "Admin console", section: "Admin", icon: ShieldCheck, available: true },
      { label: "Settings", section: "Settings", icon: Settings2, available: true },
    ],
  },
];

const STORAGE_KEY = "uscs-navigation-groups";

export function getNavigationGroupForSection(section: Section) {
  return navigationGroups.find((group) => group.items.some((item) => item.section === section));
}

export function getNavigationLabel(section: Section) {
  if (section === "Overview") return "Overview";
  return navigationGroups.flatMap((group) => group.items).find((item) => item.section === section)?.label ?? section;
}

export function CloudNavigation({
  activeSection,
  onNavigate,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onCloseMobile,
  workspaceName,
  domainView,
  onDomainView,
}: {
  activeSection: Section;
  onNavigate: (section: Section) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  workspaceName: string;
  domainView: DomainView;
  onDomainView: (view: DomainView) => void;
}) {
  const activeGroup = getNavigationGroupForSection(activeSection)?.label;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    } catch {
      return {};
    }
  });

  useEffect(() => {
    if (!activeGroup) return;
    setExpanded((current) => ({ ...current, [activeGroup]: true }));
  }, [activeGroup]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(expanded));
  }, [expanded]);

  const visibleGroups = useMemo(
    () => navigationGroups
      .map((group) => ({ ...group, items: group.items.filter((item) => item.available) }))
      .filter((group) => group.items.length > 0),
    [],
  );
  const initials = workspaceName.slice(0, 1).toUpperCase() || "U";

  const toggleGroup = (label: string) => {
    setExpanded((current) => ({ ...current, [label]: !current[label] }));
  };

  const activate = (item: NavigationItem) => {
    if (!item.available) {
      toast.info(`${item.label} is not connected yet`, {
        description: "This surface will unlock when its provider and backend contract are ready.",
      });
      return;
    }
    onNavigate(item.section);
    onCloseMobile();
  };

  return (
    <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""} ${mobileOpen ? "sidebar-mobile-open" : ""}`}>
      <div className="brand">
        <div className="brand-mark"><span /></div>
        {!collapsed && <div className="brand-wordmark"><strong>USCS</strong><small>Unified cloud platform</small></div>}
        <button className="mobile-close icon-button" onClick={onCloseMobile} aria-label="Close navigation"><X size={18} /></button>
      </div>
      <div className="workspace-switcher">
        <div className="workspace-avatar">{initials}</div>
        {!collapsed && <div className="workspace-copy"><strong>{workspaceName || "Your workspace"}</strong><small>Personal workspace</small></div>}
        {!collapsed && <ChevronDown size={14} />}
      </div>
      <nav className="sidebar-nav" aria-label="Primary navigation">
        <div className="nav-group nav-overview-group">
          {!collapsed && <div className="nav-group-label">Workspace</div>}
          <button className={`nav-item ${activeSection === "Overview" ? "nav-active" : ""}`} onClick={() => { onNavigate("Overview"); onCloseMobile(); }} title={collapsed ? "Overview" : undefined}>
            <Layers3 size={17} /><span className="nav-label">Overview</span>
          </button>
        </div>
        {visibleGroups.map((group) => {
          const GroupIcon = group.icon;
          const isOpen = Boolean(expanded[group.label]);
          const hasActiveChild = group.items.some((item) => item.section === activeSection);
          return (
            <div className={`nav-group ${hasActiveChild ? "nav-group-active" : ""}`} key={group.label}>
              <button className="nav-group-trigger" onClick={() => toggleGroup(group.label)} aria-expanded={isOpen} title={collapsed ? group.label : undefined}>
                <GroupIcon size={16} /><span className="nav-label">{group.label}</span>
                {!collapsed && (isOpen ? <ChevronDown className="nav-chevron" size={14} /> : <ChevronRight className="nav-chevron" size={14} />)}
              </button>
              {!collapsed && isOpen && <div className="nav-children">
                {group.items.map((item) => {
                  const ItemIcon = item.icon;
                  const isActive = item.section === activeSection && item.available;
                  const domainItem = item.label === "Domains";
                  return <div key={item.label} className="nav-child-wrap">
                    <button className={`nav-child ${isActive ? "nav-child-active" : ""} ${item.available ? "" : "nav-child-planned"}`} onClick={() => activate(item)} title={item.available ? item.label : `${item.label} — planned`}>
                      <span className="nav-child-marker" />{ItemIcon ? <ItemIcon size={14} /> : null}<span className="nav-label">{item.label}</span>{!item.available && <span className="nav-detail">Soon</span>}
                    </button>
                    {domainItem && isActive && <div className="nav-subchildren">
                      <button className={domainView === "market" ? "nav-subchild-active" : ""} onClick={() => { onDomainView("market"); onCloseMobile(); }}><span />Market</button>
                      <button className={domainView === "my-domains" ? "nav-subchild-active" : ""} onClick={() => { onDomainView("my-domains"); onCloseMobile(); }}><span />My domains</button>
                    </div>}
                  </div>;
                })}
              </div>}
            </div>
          );
        })}
      </nav>
      <div className="sidebar-bottom">
        <button className="help-link" onClick={() => toast.info("Support center is available once the workspace is connected.")}><LifeBuoy size={17} /><span className="nav-label">Support</span></button>
        <button className="collapse-button" onClick={onToggleCollapsed}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}<span className="nav-label">{collapsed ? "Expand" : "Collapse"}</span></button>
      </div>
    </aside>
  );
}
