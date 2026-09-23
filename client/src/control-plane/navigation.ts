import {
  Activity, Boxes, Database, Eye, Globe2, HardDrive, LayoutDashboard,
  Link2, Rocket, Settings2, ShieldCheck, WalletCards, Variable,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type NavItem = {
  label: string;
  slug: string;
  icon: LucideIcon;
  description?: string;
  children?: NavItem[];
};

const child = (label: string, slug: string, description?: string): NavItem => ({
  label,
  slug,
  icon: Activity,
  description,
});

export const workspaceNavigation: NavItem[] = [
  { label: "Overview", slug: "", icon: LayoutDashboard, description: "Workspace health and recent activity" },
  { label: "Projects", slug: "projects", icon: Boxes, description: "All projects in this workspace" },
  {
    label: "Deployments", slug: "deployments", icon: Rocket, description: "Production and preview deployments",
    children: [child("All deployments", ""), child("Production", "production"), child("Preview", "preview"), child("Rollback history", "rollback-history")],
  },
  { label: "Logs", slug: "logs", icon: Activity, description: "Runtime and build logs" },
  {
    label: "Observability", slug: "observability", icon: Eye, description: "Metrics, errors and requests",
    children: [child("Overview", ""), child("Events", "events"), child("Alerts", "alerts")],
  },
  {
    label: "Domains", slug: "domains", icon: Globe2, description: "Domains and DNS",
    children: [child("My domains", ""), child("DNS records", "dns"), child("Nameservers", "nameservers"), child("Marketplace", "marketplace")],
  },
  {
    label: "Data", slug: "data", icon: Database, description: "Databases, storage and backups",
    children: [child("Databases", "database"), child("Storage", "storage"), child("Backups", "backups")],
  },
  {
    label: "Security", slug: "security", icon: ShieldCheck, description: "Edge protection and policy",
    children: [child("Overview", ""), child("Security level", "level"), child("WAF and rules", "waf"), child("Firewall", "firewall"), child("Rate limiting", "rate-limiting"), child("Security events", "events")],
  },
  { label: "Connect", slug: "connect", icon: Link2, description: "Repositories and webhooks" },
  { label: "Billing", slug: "billing", icon: WalletCards, description: "Plans, usage and invoices" },
  { label: "Settings", slug: "settings", icon: Settings2, description: "Workspace configuration" },
];

export const projectNavigation: NavItem[] = [
  { label: "Overview", slug: "", icon: LayoutDashboard },
  { label: "Deployments", slug: "deployments", icon: Rocket, children: [child("All deployments", ""), child("Production", "production"), child("Preview", "preview")] },
  { label: "Logs", slug: "logs", icon: Activity },
  { label: "Observability", slug: "observability", icon: Eye },
  { label: "Domains", slug: "domains", icon: Globe2 },
  { label: "Data", slug: "data", icon: Database, children: [child("Databases", "database"), child("Storage", "storage"), child("Backups", "backups")] },
  { label: "Security", slug: "security", icon: ShieldCheck, children: [child("Overview", ""), child("WAF and rules", "waf"), child("Firewall", "firewall"), child("Security events", "events")] },
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

export function hasChildren(item: NavItem) {
  return Boolean(item.children?.length);
}

export function flattenNavigation(items: NavItem[]): NavItem[] {
  return items.flatMap(item => [item, ...(item.children ?? [])]);
}

export function navigationPath(base: string, item: NavItem, childSlug?: string) {
  const parent = item.slug ? `${base}/${item.slug}` : base;
  return childSlug ? `${parent}/${childSlug}` : parent;
}

// Kept as intentional compatibility exports for callers that need these icons.
export { HardDrive };
