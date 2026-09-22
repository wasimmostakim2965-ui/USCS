import {
  Activity, BarChart3, Box, Database, Eye, FolderGit2, Globe2, HardDrive, LayoutDashboard,
  Link2, LockKeyhole, Radio, Rocket, Settings2, ShieldCheck, Store, Users, WalletCards,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type WorkspacePage =
  | "Overview" | "Projects" | "Deployments" | "Logs" | "Analytics" | "Observability"
  | "Domains" | "Storage" | "Database" | "Security" | "Connect" | "Usage" | "Settings";
export type ProjectPage =
  | "Overview" | "Deployments" | "Analytics" | "Speed Insights" | "Observability" | "Domains"
  | "Storage" | "Database" | "Security" | "Environment Variables" | "Settings";
export type NavChild = { label: string; path: string; icon?: LucideIcon };
export type NavItem<T extends string = WorkspacePage> = { label: T; path: string; icon: LucideIcon; children?: NavChild[] };

const child = (label: string, path = label.toLowerCase().replaceAll(" ", "-").replaceAll("&", "and"), icon?: LucideIcon): NavChild => ({ label, path, icon });

export const workspaceNav: NavItem[] = [
  { label: "Overview", path: "overview", icon: LayoutDashboard, children: [child("Activity"), child("Production"), child("Checklist")] },
  { label: "Projects", path: "projects", icon: Box, children: [child("All Projects", "all"), child("Recents"), child("Usage"), child("Alerts")] },
  { label: "Deployments", path: "deployments", icon: Rocket, children: [child("All Deployments", "all"), child("Production"), child("Preview"), child("Development"), child("Rollback history")] },
  { label: "Logs", path: "logs", icon: Activity, children: [child("Runtime logs"), child("Build logs")] },
  { label: "Analytics", path: "analytics", icon: BarChart3, children: [child("Web analytics"), child("Speed insights")] },
  { label: "Observability", path: "observability", icon: Eye, children: [child("Logs"), child("Metrics"), child("Errors"), child("Requests"), child("Alerts")] },
  { label: "Domains", path: "domains", icon: Globe2, children: [child("All domains", "all"), child("Add domain"), child("DNS records"), child("SSL/TLS", "ssl-tls")] },
  { label: "Storage", path: "storage", icon: HardDrive, children: [child("Buckets"), child("Objects"), child("Backups")] },
  { label: "Database", path: "database", icon: Database, children: [child("Instances"), child("Backups"), child("Connection details"), child("Tables / SQL")] },
  { label: "Security", path: "security", icon: ShieldCheck, children: [child("Overview"), child("Security level", "security-level"), child("WAF"), child("Firewall"), child("Rate limiting"), child("Bot protection"), child("Events")] },
  { label: "Connect", path: "connect", icon: Link2, children: [child("Git connections"), child("Repositories"), child("Webhooks")] },
  { label: "Usage", path: "usage", icon: WalletCards, children: [child("Usage overview"), child("Invoices")] },
  { label: "Settings", path: "settings", icon: Settings2, children: [child("General", "workspace"), child("Members & roles", "team"), child("Notifications"), child("Connected accounts", "connected-accounts"), child("Audit log", "audit")] },
];

export const projectNav: NavItem<ProjectPage>[] = [
  { label: "Overview", path: "", icon: LayoutDashboard },
  { label: "Deployments", path: "deployments", icon: Rocket },
  { label: "Analytics", path: "analytics", icon: BarChart3 },
  { label: "Speed Insights", path: "speed-insights", icon: Activity },
  { label: "Observability", path: "observability", icon: Eye },
  { label: "Domains", path: "domains", icon: Globe2 },
  { label: "Storage", path: "storage", icon: HardDrive },
  { label: "Database", path: "database", icon: Database },
  { label: "Security", path: "security", icon: ShieldCheck },
  { label: "Environment Variables", path: "environment-variables", icon: LockKeyhole },
  { label: "Settings", path: "settings", icon: Settings2 },
];

export const dashboardRoutes = workspaceNav.flatMap(item => [`/dashboard/${item.path}`, ...(item.children ?? []).map(route => `/dashboard/${item.path}/${route.path}`)]) as readonly string[];
export const workspaceItem = (path?: string) => workspaceNav.find(item => item.path === path) ?? workspaceNav[0];
export const projectItem = (path?: string) => projectNav.find(item => item.path === path) ?? projectNav[0];
export const hrefFor = (item: { path: string }, childItem?: { path: string }, prefix = "/dashboard") => `${prefix}/${item.path}${childItem?.path ? `/${childItem.path}` : ""}`;

export const legacyPageForPath: Record<string, string> = { storage: "data", database: "data", usage: "billing", connect: "developer" };
export const icons = { FolderGit2, Radio, Store, Users };

export type DashboardPage = WorkspacePage;
export const dashboardNav = workspaceNav;
export const dashboardPath = (page: WorkspacePage) => workspaceNav.find(item => item.label === page)?.path ?? "overview";
export const dashboardHref = hrefFor;
export function dashboardItemFromSlug(slug?: string) { return workspaceItem(slug); }
export function dashboardPageFromSlug(slug?: string) { return workspaceItem(slug).label; }
export function dashboardChildFromSlug(item: NavItem, slug?: string) { return item.children?.find(route => route.path === slug); }

void [Store, Users, FolderGit2, Radio];
