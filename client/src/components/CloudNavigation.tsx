import {
  Activity,
  BarChart3,
  Box,
  BriefcaseBusiness,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Code2,
  Database,
  Globe2,
  HardDrive,
  Layers3,
  LifeBuoy,
  Menu,
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
  subItems?: string[];
};

type NavigationGroup = {
  label: string;
  description: string;
  icon: typeof Activity;
  items: NavigationItem[];
};

export const navigationGroups: NavigationGroup[] = [
  { label: "Projects & hosting", description: "Build and run applications", icon: Wrench, items: [
    { label: "Projects", section: "Projects", icon: Box, subItems: ["All projects", "Create project", "Project settings"] },
    { label: "Hosting & runtime", section: "Projects", icon: Server, subItems: ["Environments", "Build settings", "Runtime settings"] },
    { label: "Environment configuration", section: "Developer", subItems: ["Variables", "Secrets", "Runtime configuration"] },
  ]},
  { label: "Domains", description: "Buy, connect and route domains", icon: Globe2, items: [
    { label: "Domains", section: "Domains", icon: Globe2, subItems: ["Market", "My domains", "DNS & nameservers"] },
  ]},
  { label: "Deployments", description: "Ship, inspect and roll back", icon: Layers3, items: [
    { label: "Deployments", section: "Deployments", icon: Layers3, subItems: ["All deployments", "Production", "Preview", "Logs & rollback"] },
  ]},
  { label: "Data services", description: "Databases, storage and recovery", icon: Database, items: [
    { label: "Databases", section: "Data", icon: Database, subItems: ["Overview", "Tables", "SQL editor", "Backups & recovery"] },
    { label: "Storage", section: "Data", icon: HardDrive, subItems: ["Buckets", "Files", "CDN & delivery"] },
    { label: "Cache", section: "Data", subItems: ["Overview", "Rules", "Purge"] },
    { label: "Queues", section: "Data", subItems: ["Overview", "Queues", "Consumers"] },
    { label: "Data transfers", section: "Data", subItems: ["Imports", "Exports", "Migration history"] },
  ]},
  { label: "Security & protection", description: "Protect every project and domain", icon: ShieldCheck, items: [
    { label: "Security overview", section: "Security", icon: ShieldCheck, subItems: ["Posture", "Findings", "Remediation"] },
    { label: "Firewall", section: "Security", subItems: ["Rules", "Events", "Settings"] },
    { label: "WAF", section: "Security", subItems: ["Managed rules", "Custom rules", "Events"] },
    { label: "DDoS protection", section: "Security", subItems: ["Overview", "Protection rules", "Events"] },
    { label: "Bot protection", section: "Security", subItems: ["Overview", "Detection", "Challenges"] },
    { label: "Rate limiting", section: "Security", subItems: ["Rules", "Analytics", "Events"] },
    { label: "Access control", section: "Security", subItems: ["Policies", "Members", "Service access"] },
    { label: "Authentication & MFA", section: "Security", subItems: ["Providers", "MFA", "Sessions"] },
    { label: "Security audit", section: "Security", subItems: ["Events", "Exports", "Retention"] },
  ]},
  { label: "Observability", description: "Logs, metrics and alerts", icon: BarChart3, items: [
    { label: "Logs", section: "Observability", icon: ScrollText, subItems: ["Live logs", "Search", "Saved views"] },
    { label: "Metrics", section: "Observability", subItems: ["Overview", "Requests", "Resources"] },
    { label: "Errors", section: "Observability", subItems: ["Error groups", "Traces", "Releases"] },
    { label: "Performance", section: "Observability", subItems: ["Web vitals", "Speed", "Regions"] },
    { label: "Uptime & alerts", section: "Observability", subItems: ["Monitors", "Incidents", "Destinations"] },
  ]},
  { label: "Developer tools", description: "Source, APIs and automation", icon: Code2, items: [
    { label: "GitHub", section: "Developer", icon: Code2, subItems: ["Repositories", "Branches", "Webhooks"] },
    { label: "API keys", section: "Developer", subItems: ["Project keys", "Personal keys", "Revoked"] },
    { label: "Webhooks", section: "Developer", subItems: ["Endpoints", "Deliveries", "Signing secrets"] },
    { label: "CLI & API", section: "Developer", subItems: ["CLI setup", "REST API", "MCP"] },
    { label: "Documentation", section: "Developer", subItems: ["Getting started", "API reference", "Security"] },
  ]},
  { label: "Workspace", description: "People, governance and account", icon: BriefcaseBusiness, items: [
    { label: "Team", section: "Team", icon: Users, subItems: ["Members", "Roles & permissions", "Invitations"] },
    { label: "Billing", section: "Billing", icon: CircleDollarSign, subItems: ["Overview", "Usage", "Invoices", "Payment methods"] },
    { label: "Admin console", section: "Admin", icon: ShieldCheck, subItems: ["Governance", "Providers", "Audit center"] },
    { label: "Settings", section: "Settings", icon: Settings2, subItems: ["General", "Security", "Notifications", "Connected accounts"] },
  ]},
];

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
  const activeGroup = getNavigationGroupForSection(activeSection) ?? navigationGroups[0];
  const initials = workspaceName.slice(0, 1).toUpperCase() || "U";
  const activateGroup = (group: NavigationGroup) => {
    const section = group.items[0]?.section ?? "Overview";
    onNavigate(section);
    onSubNavigate(group.label === "Domains" ? "Market" : group.items[0]?.subItems?.[0] ?? group.items[0]?.label ?? "");
    if (group.label === "Domains") onDomainView("market");
    onCloseMobile();
  };
  const activateItem = (item: NavigationItem) => {
    onNavigate(item.section);
    onSubNavigate(item.subItems?.[0] ?? item.label);
    onCloseMobile();
  };
  const activateSubItem = (item: NavigationItem, subItem: string) => {
    if (activeGroup.label === "Domains" && subItem === "Market") onDomainView("market");
    if (activeGroup.label === "Domains" && subItem === "My domains") onDomainView("my-domains");
    onSubNavigate(subItem);
    onCloseMobile();
  };

  return <>
    <aside className={`product-rail ${mobileOpen ? "product-rail-mobile-open" : ""}`}>
      <div className="rail-brand"><div className="brand-mark"><span /></div><span className="rail-wordmark">USCS</span></div>
      <button className={`rail-home ${activeSection === "Overview" ? "rail-active" : ""}`} onClick={() => { onNavigate("Overview"); onCloseMobile(); }} title="Overview"><Layers3 size={18} /><span>Home</span></button>
      <div className="rail-products">{navigationGroups.map((group) => { const Icon = group.icon; const active = activeGroup.label === group.label && activeSection !== "Overview"; return <button key={group.label} className={`rail-product ${active ? "rail-active" : ""}`} onClick={() => activateGroup(group)} title={group.label}><Icon size={18} /><span>{group.label}</span></button>; })}</div>
      <div className="rail-bottom"><button className="rail-product" onClick={() => toast.info("Support center is available once the workspace is connected.")} title="Support"><LifeBuoy size={18} /><span>Support</span></button><button className="rail-product rail-collapse" onClick={onToggleCollapsed} title={collapsed ? "Expand navigation" : "Collapse navigation"}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}<span>{collapsed ? "Expand" : "Collapse"}</span></button></div>
    </aside>
    <aside className={`context-panel ${collapsed ? "context-panel-hidden" : ""} ${mobileOpen ? "context-panel-mobile-open" : ""}`}>
      <div className="context-panel-header"><div className="context-kicker">USCS workspace</div><button className="mobile-close icon-button" onClick={onCloseMobile} aria-label="Close navigation"><X size={18} /></button><div className="workspace-switcher-modern"><span className="workspace-avatar">{initials}</span><span><strong>{workspaceName || "Your workspace"}</strong><small>Personal workspace</small></span><ChevronDown size={14} /></div></div>
      {activeSection === "Overview" ? <div className="context-overview"><div className="context-category-icon"><Layers3 size={20} /></div><h2>Overview</h2><p>Your workspace at a glance.</p><button onClick={() => onNavigate("Projects")}>Create a project <ChevronRight size={14} /></button><button onClick={() => { onNavigate("Domains"); onDomainView("market"); onSubNavigate("Market"); }}>Find a domain <ChevronRight size={14} /></button></div> : <><div className="context-panel-title"><div className="context-category-icon"><activeGroup.icon size={20} /></div><div><h2>{activeGroup.label}</h2><p>{activeGroup.description}</p></div></div><div className="context-items">{activeGroup.items.map((item) => { const Icon = item.icon; const itemActive = item.section === activeSection; return <div className={`context-item-group ${itemActive ? "context-item-active" : ""}`} key={item.label}><button className="context-item-button" onClick={() => activateItem(item)}>{Icon ? <Icon size={16} /> : <span className="context-item-dot" />}<span>{item.label}</span>{item.subItems?.length ? <ChevronDown size={13} /> : null}</button>{itemActive && item.subItems?.length ? <div className="context-subitems">{item.subItems.map((subItem) => <button key={subItem} className={(activeGroup.label === "Domains" && ((domainView === "market" && subItem === "Market") || (domainView === "my-domains" && subItem === "My domains"))) ? "context-subitem-active" : ""} onClick={() => activateSubItem(item, subItem)}><span />{subItem}</button>)}</div> : null}</div>; })}</div></>}
      <div className="context-panel-footer"><span>Provider-agnostic control plane</span><button onClick={() => onNavigate("Settings")}><Settings2 size={14} /> Settings</button></div>
    </aside>
  </>;
}
