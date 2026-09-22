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

export type DashboardNavItem = {
  label: DashboardPage;
  icon: LucideIcon;
  path: string;
};

export const dashboardNav: DashboardNavItem[] = [
  { label: "Overview", icon: LayoutDashboard, path: "overview" },
  { label: "Projects", icon: Box, path: "projects" },
  { label: "Deployments", icon: Rocket, path: "deployments" },
  { label: "Domains", icon: Globe2, path: "domains" },
  { label: "Data", icon: Database, path: "data" },
  { label: "Security", icon: LockKeyhole, path: "security" },
  { label: "Observability", icon: Eye, path: "observability" },
  { label: "Developer", icon: Link2, path: "developer" },
  { label: "Billing", icon: BarChart3, path: "billing" },
  { label: "Settings", icon: Settings2, path: "settings" },
];

export const dashboardRoutes = dashboardNav.map(item => `/dashboard/${item.path}`) as readonly string[];

export function dashboardPageFromSlug(slug: string | undefined): DashboardPage {
  return dashboardNav.find(item => item.path === slug)?.label ?? "Overview";
}

export function dashboardPath(page: DashboardPage): string {
  return dashboardNav.find(item => item.label === page)?.path ?? "overview";
}
