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

const childRoutes = (items: Array<string | DashboardChildRoute>): DashboardChildRoute[] =>
  items.map(item => typeof item === "string"
    ? { label: item, path: item.toLowerCase().replaceAll(" ", "-").replaceAll("&", "and").replaceAll("/", "-").replace(/[^a-z0-9-]/g, "") }
    : item);

export const dashboardNav: DashboardNavItem[] = [
  { label: "Overview", icon: LayoutDashboard, path: "overview", children: childRoutes(["Activity feed", "Resource summary", "Recent deployments", "Security posture"]) },
  { label: "Projects", icon: Box, path: "projects", children: childRoutes(["List", "Deployments", "Domains", "Env Vars", "Settings"]) },
  { label: "Deployments", icon: Rocket, path: "deployments", children: childRoutes(["List", "Production", "Preview", "Development", "Rollback history"]) },
  { label: "Domains", icon: Globe2, path: "domains", children: childRoutes(["My domains", "Add domain", "DNS records", "Nameservers", { label: "SSL/TLS", path: "ssl-tls" }, "Marketplace"]) },
  { label: "Data", icon: Database, path: "data", children: childRoutes(["Databases", "Storage buckets", "Backups", "Connection details"]) },
  { label: "Security", icon: LockKeyhole, path: "security", children: childRoutes(["Overview", "Security level", "WAF", "Custom firewall", "Rate limiting", "Bot protection", "DDoS events", "SSL/TLS", "Security events"]) },
  { label: "Observability", icon: Eye, path: "observability", children: childRoutes(["Logs", "Metrics", "Errors", "Requests", "Alerts"]) },
  { label: "Developer", icon: Link2, path: "developer", children: childRoutes([{ label: "Git connections", path: "connections" }, "Repositories", "Webhooks", "API keys", { label: "CLI & API docs", path: "api-docs" }]) },
  { label: "Billing", icon: BarChart3, path: "billing", children: childRoutes(["Plan & Upgrade", "Usage", "Invoices", "Payment methods"]) },
  { label: "Settings", icon: Settings2, path: "settings", children: childRoutes([{ label: "General", path: "workspace" }, { label: "Members & Roles", path: "team" }, "Notifications", { label: "Connected accounts", path: "connected-accounts" }, { label: "Audit log", path: "audit" }]) },
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
