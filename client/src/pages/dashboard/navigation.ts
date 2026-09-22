import {
  BarChart3,
  Box,
  Eye,
  Globe2,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  Rocket,
  Settings2,
  Database,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type DashboardPage =
  | "Overview"
  | "Projects"
  | "Deployments"
  | "Domains"
  | "Data"
  | "Security"
  | "Observability"
  | "Developer"
  | "Billing"
  | "Settings";

export type DashboardChildRoute = {
  label: string;
  path: string;
};

export type DashboardNavItem = {
  label: DashboardPage;
  icon: LucideIcon;
  path: string;
  children: DashboardChildRoute[];
};

const childRoutes = (items: string[]): DashboardChildRoute[] =>
  items.map(label => ({ label, path: label.toLowerCase().replaceAll(" ", "-").replaceAll("&", "and") }));

export const dashboardNav: DashboardNavItem[] = [
  { label: "Overview", icon: LayoutDashboard, path: "overview", children: childRoutes(["Activity feed", "Resource summary", "Recent deployments", "Security posture"]) },
  { label: "Projects", icon: Box, path: "projects", children: childRoutes(["List", "Deployments", "Domains", "Env Vars", "Settings"]) },
  { label: "Deployments", icon: Rocket, path: "deployments", children: childRoutes(["List", "Production", "Preview", "Development", "Rollback history"]) },
  { label: "Domains", icon: Globe2, path: "domains", children: childRoutes(["My domains", "Add domain", "DNS records", "Nameservers", "SSL/TLS", "Marketplace"]) },
  { label: "Data", icon: Database, path: "data", children: childRoutes(["Databases", "Storage buckets", "Backups", "Connection details"]) },
  { label: "Security", icon: LockKeyhole, path: "security", children: childRoutes(["Overview", "Security level", "WAF", "Custom firewall", "Rate limiting", "Bot protection", "DDoS events", "SSL/TLS", "Security events"]) },
  { label: "Observability", icon: Eye, path: "observability", children: childRoutes(["Logs", "Metrics", "Errors", "Requests", "Alerts"]) },
  { label: "Developer", icon: Link2, path: "developer", children: childRoutes(["Git connections", "Repositories", "Webhooks", "API keys", "CLI & API docs"]) },
  { label: "Billing", icon: BarChart3, path: "billing", children: childRoutes(["Plan & Upgrade", "Usage", "Invoices", "Payment methods"]) },
  { label: "Settings", icon: Settings2, path: "settings", children: childRoutes(["General", "Members & Roles", "Notifications", "Connected accounts", "Audit log"]) },
];

export const dashboardRoutes = dashboardNav.flatMap(item => [
  `/dashboard/${item.path}`,
  ...item.children.map(child => `/dashboard/${item.path}/${child.path}`),
]) as readonly string[];

export function dashboardItemFromSlug(slug: string | undefined): DashboardNavItem {
  return dashboardNav.find(item => item.path === slug) ?? dashboardNav[0];
}

export function dashboardPageFromSlug(slug: string | undefined): DashboardPage {
  return dashboardItemFromSlug(slug).label;
}

export function dashboardPath(page: DashboardPage): string {
  return dashboardNav.find(item => item.label === page)?.path ?? "overview";
}

export function dashboardChildFromSlug(item: DashboardNavItem, slug: string | undefined): DashboardChildRoute | undefined {
  return item.children.find(child => child.path === slug);
}

export function dashboardHref(item: DashboardNavItem, child?: DashboardChildRoute): string {
  return `/dashboard/${item.path}${child ? `/${child.path}` : ""}`;
}
