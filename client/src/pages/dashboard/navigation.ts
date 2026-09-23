import {
  Activity, Box, BarChart3, Database, Eye, GitBranch, Globe2, HardDrive, KeyRound, LayoutDashboard,
  Link2, LockKeyhole, Rocket, Scale, Settings2, Shield, ShieldCheck, Users, WalletCards,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/*
 * Navigation is the single source of truth for the authenticated control plane.
 * Every entry maps to a real `/dashboard/...` route so refresh, deep links and
 * the command palette all resolve from the same contract.
 */

export type WorkspacePage =
  | "Overview" | "Projects" | "Deployments" | "Analytics" | "Observability"
  | "Domains" | "Data" | "Security" | "Developer" | "Team" | "Billing" | "Settings";

export type ProjectPage =
  | "Overview" | "Deployments" | "Analytics" | "Observability" | "Domains"
  | "Storage" | "Database" | "Security" | "Environment Variables" | "Settings";

export type NavChild = { label: string; path: string; icon?: LucideIcon };
export type NavItem<T extends string = WorkspacePage> = { label: T; path: string; icon: LucideIcon; children: NavChild[] };

const child = (label: string, path = label.toLowerCase().replaceAll(" ", "-").replaceAll("/", "-"), icon?: LucideIcon): NavChild => ({ label, path, icon });

export const workspaceNav: NavItem[] = [
  { label: "Overview", path: "overview", icon: LayoutDashboard, children: [child("Activity"), child("Production"), child("Checklist")] },
  { label: "Projects", path: "projects", icon: Box, children: [child("All Projects", "all"), child("Recents"), child("Usage"), child("Alerts")] },
  { label: "Deployments", path: "deployments", icon: Rocket, children: [child("All Deployments", "all"), child("Production"), child("Preview"), child("Development"), child("Rollback history")] },
  { label: "Analytics", path: "analytics", icon: BarChart3, children: [child("Web analytics"), child("Speed insights")] },
  { label: "Observability", path: "observability", icon: Eye, children: [child("Logs"), child("Metrics"), child("Errors"), child("Requests"), child("Alerts")] },
  { label: "Domains", path: "domains", icon: Globe2, children: [child("My domains", "my-domains"), child("Add domain", "add-domain"), child("DNS records", "dns-records"), child("Nameservers"), child("SSL/TLS", "ssl-tls")] },
  { label: "Data", path: "data", icon: Database, children: [child("Databases", "databases"), child("Storage buckets", "storage-buckets"), child("Backups")] },
  { label: "Security", path: "security", icon: ShieldCheck, children: [child("Posture", "posture"), child("Firewall"), child("WAF"), child("Rate limiting"), child("Bot protection"), child("Events", "events")] },
  { label: "Developer", path: "developer", icon: Link2, children: [child("Git connections", "git-connections"), child("Repositories"), child("Webhooks"), child("API keys", "api-keys")] },
  { label: "Team", path: "team", icon: Users, children: [child("Members"), child("Roles", "roles")] },
  { label: "Billing", path: "billing", icon: WalletCards, children: [child("Usage", "usage"), child("Invoices"), child("Payment methods", "payment-methods")] },
  { label: "Settings", path: "settings", icon: Settings2, children: [child("General", "workspace"), child("Notifications"), child("Connected accounts", "connected-accounts"), child("Audit log", "audit")] },
];

export const projectNav: NavItem<ProjectPage>[] = [
  { label: "Overview", path: "", icon: LayoutDashboard, children: [] },
  { label: "Deployments", path: "deployments", icon: Rocket, children: [] },
  { label: "Analytics", path: "analytics", icon: BarChart3, children: [] },
  { label: "Observability", path: "observability", icon: Eye, children: [] },
  { label: "Domains", path: "domains", icon: Globe2, children: [] },
  { label: "Storage", path: "storage", icon: HardDrive, children: [] },
  { label: "Database", path: "database", icon: Database, children: [] },
  { label: "Security", path: "security", icon: ShieldCheck, children: [] },
  { label: "Environment Variables", path: "environment-variables", icon: LockKeyhole, children: [] },
  { label: "Settings", path: "settings", icon: Settings2, children: [] },
];

export const workspaceGroups: Array<{ label: string; items: WorkspacePage[] }> = [
  { label: "Platform", items: ["Overview", "Projects", "Deployments", "Analytics", "Observability"] },
  { label: "Infrastructure", items: ["Domains", "Data", "Security"] },
  { label: "Workspace", items: ["Developer", "Team", "Billing", "Settings"] },
];

export const projectRoutes = ["/dashboard/projects/:id", ...projectNav.filter(item => item.path).map(item => `/dashboard/projects/:id/${item.path}`)] as const;
export const dashboardRoutes = [...workspaceNav.flatMap(item => [`/dashboard/${item.path}`, ...item.children.map(route => `/dashboard/${item.path}/${route.path}`)]), ...projectRoutes] as readonly string[];

export const workspaceItem = (path?: string) => workspaceNav.find(item => item.path === path) ?? workspaceNav[0];
export const projectItem = (path?: string) => projectNav.find(item => item.path === path) ?? projectNav[0];
export const hrefFor = (item: { path: string }, childItem?: { path: string }, prefix = "/dashboard") => `${prefix}/${item.path}${childItem?.path ? `/${childItem.path}` : ""}`;

export type DashboardPage = WorkspacePage;
export const dashboardNav = workspaceNav;
export const dashboardPath = (page: WorkspacePage) => workspaceNav.find(item => item.label === page)?.path ?? "overview";
export const dashboardHref = hrefFor;
export function dashboardItemFromSlug(slug?: string) { return workspaceItem(slug); }
export function dashboardPageFromSlug(slug?: string) { return workspaceItem(slug).label; }
export function dashboardChildFromSlug(item: NavItem, slug?: string) { return item.children.find(route => route.path === slug); }

// Icons exported for section pages that render their own scope markers.
export const sectionIcons = { Activity, GitBranch, KeyRound, Scale, Shield };
