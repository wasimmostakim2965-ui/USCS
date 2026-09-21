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
  Server,
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
  subItems?: string[];
};

type NavigationGroup = {
  label: string;
  icon: typeof Activity;
  items: NavigationItem[];
};

export const navigationGroups: NavigationGroup[] = [
  {
    label: "Projects & hosting",
    icon: Wrench,
    items: [
      { label: "Projects", section: "Projects", icon: Box, available: true, subItems: ["All projects", "Create project", "Project settings"] },
      { label: "Hosting & runtime", section: "Projects", icon: Server, available: true, subItems: ["Environments", "Build settings", "Runtime settings"] },
      { label: "Environment configuration", section: "Developer", available: true, subItems: ["Variables", "Secrets", "Runtime configuration"] },
    ],
  },
  {
    label: "Domains",
    icon: Globe2,
    items: [
      { label: "Domain overview", section: "Domains", icon: Globe2, available: true, subItems: ["Overview", "Market", "My domains", "DNS & nameservers"] },
    ],
  },
  {
    label: "Deployments",
    icon: Layers3,
    items: [
      { label: "Deployment overview", section: "Deployments", icon: Layers3, available: true, subItems: ["All deployments", "Production", "Preview", "Logs & rollback"] },
    ],
  },
  {
    label: "Data services",
    icon: Database,
    items: [
      { label: "Databases", section: "Data", icon: Database, available: true, subItems: ["Overview", "Tables", "SQL editor", "Backups & recovery"] },
      { label: "Storage", section: "Data", icon: HardDrive, available: true, subItems: ["Buckets", "Files", "CDN & delivery"] },
      { label: "Cache", section: "Data", available: true, subItems: ["Overview", "Rules", "Purge"] },
      { label: "Queues", section: "Data", available: true, subItems: ["Overview", "Queues", "Consumers"] },
      { label: "Backups", section: "Data", available: true, subItems: ["Overview", "Schedules", "Restore"] },
      { label: "Data transfers", section: "Data", available: true, subItems: ["Imports", "Exports", "Migration history"] },
    ],
  },
  {
    label: "Security & protection",
    icon: ShieldCheck,
    items: [
      { label: "Security overview", section: "Security", icon: ShieldCheck, available: true, subItems: ["Posture", "Findings", "Remediation"] },
      { label: "Security center", section: "Security", available: true, subItems: ["Assets", "Advisor", "Policies"] },
      { label: "Firewall", section: "Security", available: true, subItems: ["Rules", "Events", "Settings"] },
      { label: "WAF", section: "Security", available: true, subItems: ["Managed rules", "Custom rules", "Events"] },
      { label: "DDoS protection", section: "Security", available: true, subItems: ["Overview", "Protection rules", "Events"] },
      { label: "Bot protection", section: "Security", available: true, subItems: ["Overview", "Detection", "Challenges"] },
      { label: "Rate limiting", section: "Security", available: true, subItems: ["Rules", "Analytics", "Events"] },
      { label: "Access control", section: "Security", available: true, subItems: ["Policies", "Members", "Service access"] },
      { label: "Authentication & MFA", section: "Security", available: true, subItems: ["Providers", "MFA", "Sessions"] },
      { label: "Secrets", section: "Developer", available: true, subItems: ["Project secrets", "Environment scope", "Rotation"] },
      { label: "Security audit", section: "Security", available: true, subItems: ["Events", "Exports", "Retention"] },
    ],
  },
  {
    label: "Observability",
    icon: BarChart3,
    items: [
      { label: "Logs", section: "Observability", icon: ScrollText, available: true, subItems: ["Live logs", "Search", "Saved views"] },
      { label: "Metrics", section: "Observability", available: true, subItems: ["Overview", "Requests", "Resources"] },
      { label: "Errors", section: "Observability", available: true, subItems: ["Error groups", "Traces", "Releases"] },
      { label: "Requests", section: "Observability", available: true, subItems: ["Traffic", "Latency", "Status codes"] },
      { label: "Performance", section: "Observability", available: true, subItems: ["Web vitals", "Speed", "Regions"] },
      { label: "Uptime", section: "Observability", available: true, subItems: ["Monitors", "Incidents", "Maintenance"] },
      { label: "Alerts", section: "Observability", available: true, subItems: ["Active", "Rules", "Destinations"] },
    ],
  },
  {
    label: "Developer tools",
    icon: Code2,
    items: [
      { label: "GitHub", section: "Developer", icon: Code2, available: true, subItems: ["Repositories", "Branches", "Webhooks"] },
      { label: "API keys", section: "Developer", available: true, subItems: ["Project keys", "Personal keys", "Revoked"] },
      { label: "Webhooks", section: "Developer", available: true, subItems: ["Endpoints", "Deliveries", "Signing secrets"] },
      { label: "CLI & API", section: "Developer", available: true, subItems: ["CLI setup", "REST API", "MCP"] },
      { label: "Documentation", section: "Developer", available: true, subItems: ["Getting started", "API reference", "Security"] },
    ],
  },
  {
    label: "Workspace",
    icon: BriefcaseBusiness,
    items: [
      { label: "Team", section: "Team", icon: Users, available: true, subItems: ["Members", "Roles & permissions", "Invitations"] },
      { label: "Billing", section: "Billing", icon: CircleDollarSign, available: true, subItems: ["Overview", "Usage", "Invoices", "Payment methods"] },
      { label: "Admin console", section: "Admin", icon: ShieldCheck, available: true, subItems: ["Governance", "Providers", "Audit center"] },
      { label: "Settings", section: "Settings", icon: Settings2, available: true, subItems: ["General", "Security", "Notifications", "Connected accounts"] },
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
  onSubNavigate,
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
  onSubNavigate: (label: string) => void;
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

  const visibleGroups = useMemo(() => navigationGroups, []);
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
                    {isActive && Boolean(item.subItems?.length) && <div className="nav-subchildren">
                      {item.subItems?.map((subItem) => <button key={subItem} className={(domainItem && ((domainView === "market" && subItem === "Market") || (domainView === "my-domains" && subItem === "My domains"))) ? "nav-subchild-active" : ""} onClick={() => { if (domainItem && subItem === "Market") onDomainView("market"); if (domainItem && subItem === "My domains") onDomainView("my-domains"); onSubNavigate(subItem); onCloseMobile(); }}><span />{subItem}</button>)}
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
