import {
  Activity, Boxes, Database, Eye, Globe2, HardDrive, LayoutDashboard,
  Link2, Rocket, Settings2, ShieldCheck, WalletCards, Variable,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = { label: string; slug: string; icon: LucideIcon; description?: string };

export const workspaceNavigation: NavItem[] = [
  { label: "Overview", slug: "", icon: LayoutDashboard, description: "Workspace health and recent activity" },
  { label: "Projects", slug: "projects", icon: Boxes, description: "All projects in this workspace" },
  { label: "Deployments", slug: "deployments", icon: Rocket, description: "Production and preview deployments" },
  { label: "Logs", slug: "logs", icon: Activity, description: "Runtime and build logs" },
  { label: "Observability", slug: "observability", icon: Eye, description: "Metrics, errors and requests" },
  { label: "Domains", slug: "domains", icon: Globe2, description: "Domains and DNS" },
  { label: "Storage", slug: "storage", icon: HardDrive, description: "Buckets and backups" },
  { label: "Database", slug: "database", icon: Database, description: "Managed database instances" },
  { label: "Security", slug: "security", icon: ShieldCheck, description: "Edge protection and policy" },
  { label: "Connect", slug: "connect", icon: Link2, description: "Repositories and webhooks" },
  { label: "Usage", slug: "usage", icon: WalletCards, description: "Usage and billing" },
  { label: "Settings", slug: "settings", icon: Settings2, description: "Workspace configuration" },
];

export const projectNavigation: NavItem[] = [
  { label: "Overview", slug: "", icon: LayoutDashboard },
  { label: "Deployments", slug: "deployments", icon: Rocket },
  { label: "Observability", slug: "observability", icon: Eye },
  { label: "Domains", slug: "domains", icon: Globe2 },
  { label: "Storage", slug: "storage", icon: HardDrive },
  { label: "Database", slug: "database", icon: Database },
  { label: "Security", slug: "security", icon: ShieldCheck },
  { label: "Environment Variables", slug: "environment-variables", icon: Variable },
  { label: "Settings", slug: "settings", icon: Settings2 },
];

export const dashboardRoutes = [
  "/dashboard",
  ...workspaceNavigation.filter(item => item.slug).map(item => `/dashboard/${item.slug}`),
  "/dashboard/projects/:id",
  ...projectNavigation.filter(item => item.slug).map(item => `/dashboard/projects/:id/${item.slug}`),
] as const;

export function findNavItem(items: NavItem[], slug?: string) {
  return items.find(item => item.slug === (slug ?? "")) ?? items[0];
}
