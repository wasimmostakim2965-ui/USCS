/**
 * The section catalogue.
 *
 * Every section in the sidebar that does not have a bespoke page of its own
 * describes itself from here: a title, a one-line purpose, the resources it
 * owns, and the columns those resources are read by. One record per section, so
 * the menu, the page title and the page body cannot disagree about what a
 * section is.
 *
 * The content is written against the reference the owner supplied — the
 * screenshots of a Vercel dashboard — because that is the shape being matched:
 * a list page with a primary action, a set of filterable columns, and an honest
 * empty state. None of these engines are wired in this deployment yet, so the
 * page says so rather than showing a fabricated row.
 */
import type { ProjectSection, WorkspaceSection } from "./routes.js";

export interface SectionSpec {
  /** The page heading. Matches the sidebar label. */
  readonly title: string;
  /** The line under the heading: what this section is for. */
  readonly blurb: string;
  /** The primary action's label, or null when the section is read-only. */
  readonly action: string | null;
  /** The columns a row in this section's list is read by. */
  readonly columns: readonly string[];
  /** What an empty list means, in one sentence. */
  readonly empty: string;
  /** The engine that would back this section, named for the operator. */
  readonly engine: string;
}

/**
 * The workspace-level sections, keyed by section.
 *
 * `Readonly<Record<WorkspaceSection, SectionSpec>>` is the point: adding a
 * section to `WORKSPACE_SECTIONS` without a spec is a type error, so the menu
 * can never grow a page that has nothing to say.
 */
export const WORKSPACE_SECTIONS_SPEC: Readonly<Record<WorkspaceSection, SectionSpec>> = {
  logs: {
    title: "Logs",
    blurb: "Runtime logs across this organization, newest first.",
    action: null,
    columns: ["Time", "Level", "Route", "Status", "Deployment"],
    empty: "No runtime logs have been recorded for this organization yet.",
    engine: "log store",
  },
  analytics: {
    title: "Analytics",
    blurb: "Visitors and page views across this organization.",
    action: null,
    columns: ["Path", "Visitors", "Page views", "Bounce rate"],
    empty: "No analytics have been recorded for this organization yet.",
    engine: "analytics collector",
  },
  "speed-insights": {
    title: "Speed Insights",
    blurb: "Real-user performance: the Core Web Vitals across this organization.",
    action: null,
    columns: ["Route", "Real Experience Score", "LCP", "INP", "CLS"],
    empty: "No real-user performance data has been recorded for this organization yet.",
    engine: "speed insights collector",
  },
  firewall: {
    title: "Firewall",
    blurb: "Traffic, rules and the audit log for this organization's edge.",
    action: "Add rule",
    columns: ["Rule", "Action", "Matches", "Status"],
    empty: "No firewall rules have been added for this organization yet.",
    engine: "edge firewall",
  },
  cdn: {
    title: "CDN",
    blurb: "Cached delivery: requests, cache hit rate and transfer.",
    action: null,
    columns: ["Region", "Requests", "Cache hit rate", "Transfer"],
    empty: "No cache traffic has been recorded for this organization yet.",
    engine: "edge cache",
  },
  env: {
    title: "Environment Variables",
    blurb: "Variables available to this organization's projects.",
    action: "Add variable",
    columns: ["Key", "Environments", "Scope", "Updated"],
    empty: "No environment variables have been added for this organization yet.",
    engine: "secret store",
  },
  domains: {
    title: "Domains",
    blurb: "Every hostname this organization serves.",
    action: "Add domain",
    columns: ["Domain", "Project", "DNS", "Certificate"],
    empty: "No domains have been added for this organization yet.",
    engine: "domain service",
  },
  connect: {
    title: "Connect",
    blurb: "Connectors and the tokens they issue.",
    action: "Add connector",
    columns: ["Connector", "Type", "Environments", "Last used"],
    empty: "No connectors have been added for this organization yet.",
    engine: "connector service",
  },
  integrations: {
    title: "Integrations",
    blurb: "Third-party services wired into this organization.",
    action: "Browse integrations",
    columns: ["Integration", "Category", "Projects", "Added"],
    empty: "No integrations have been added for this organization yet.",
    engine: "integration registry",
  },
  storage: {
    title: "Storage",
    blurb: "Object storage buckets and the files in them.",
    action: "Create bucket",
    columns: ["Bucket", "Region", "Objects", "Size"],
    empty: "No buckets have been created for this organization yet.",
    engine: "object store",
  },
  database: {
    title: "Database",
    blurb: "Databases, tables, storage and auth.",
    action: "Create database",
    columns: ["Database", "Engine", "Region", "Status"],
    empty: "No databases have been created for this organization yet.",
    engine: "data engine",
  },
  flags: {
    title: "Flags",
    blurb: "Feature flags and who they are rolled out to.",
    action: "Create flag",
    columns: ["Flag", "Variants", "Environments", "Status"],
    empty: "No feature flags have been created for this organization yet.",
    engine: "flags service",
  },
  agent: {
    title: "Agent",
    blurb: "The assistant's tasks and what it has done.",
    action: null,
    columns: ["Task", "Trigger", "Project", "Status"],
    empty: "No agent tasks have been run for this organization yet.",
    engine: "agent runtime",
  },
  "ai-gateway": {
    title: "AI Gateway",
    blurb: "Models, API keys and spend for the managed AI gateway.",
    action: "Create key",
    columns: ["Key", "Budget", "Spend", "Created"],
    empty: "No AI Gateway keys have been created for this organization yet.",
    engine: "AI gateway",
  },
  sandboxes: {
    title: "Sandboxes",
    blurb: "Isolated machines for agent and one-off workloads.",
    action: "Create sandbox",
    columns: ["Sandbox", "Runtime", "Region", "Status"],
    empty: "No sandboxes have been created for this organization yet.",
    engine: "sandbox runtime",
  },
  workflows: {
    title: "Workflows",
    blurb: "Durable multi-step runs and their steps.",
    action: null,
    columns: ["Workflow", "Runs", "Failed", "Last run"],
    empty: "No workflows have been run for this organization yet.",
    engine: "workflow runtime",
  },
  images: {
    title: "Images",
    blurb: "Image transformations served from this organization.",
    action: null,
    columns: ["Source", "Transformations", "Cache hit rate", "Transfer"],
    empty: "No image transformations have been recorded for this organization yet.",
    engine: "image optimizer",
  },
  usage: {
    title: "Usage",
    blurb: "Metered usage against each resource's cap.",
    action: null,
    columns: ["Metric", "Used", "Included", "Overage"],
    empty: "No usage has been recorded for this organization yet.",
    engine: "usage meter",
  },
  support: {
    title: "Support",
    blurb: "Open a case and read what has been filed.",
    action: "Open a case",
    columns: ["Case", "Subject", "Priority", "Status"],
    empty: "No support cases have been filed for this organization yet.",
    engine: "support desk",
  },
};

/** The project-level sections, keyed by section. Same contract as above. */
export const PROJECT_SECTIONS_SPEC: Readonly<Record<ProjectSection, SectionSpec>> = {
  "speed-insights": {
    title: "Speed Insights",
    blurb: "Real-user performance: the Core Web Vitals for this project.",
    action: null,
    columns: ["Route", "Real Experience Score", "LCP", "INP", "CLS"],
    empty: "No real-user performance data has been recorded for this project yet.",
    engine: "speed insights collector",
  },
  observability: {
    title: "Observability",
    blurb: "Requests, traces and errors for this project.",
    action: null,
    columns: ["Time", "Request", "Status", "Duration"],
    empty: "No requests have been recorded for this project yet.",
    engine: "observability store",
  },
  firewall: {
    title: "Firewall",
    blurb: "Traffic, rules and the audit log for this project's edge.",
    action: "Add rule",
    columns: ["Rule", "Action", "Matches", "Status"],
    empty: "No firewall rules have been added for this project yet.",
    engine: "edge firewall",
  },
  cdn: {
    title: "CDN",
    blurb: "Cached delivery for this project.",
    action: null,
    columns: ["Region", "Requests", "Cache hit rate", "Transfer"],
    empty: "No cache traffic has been recorded for this project yet.",
    engine: "edge cache",
  },
  connect: {
    title: "Connect",
    blurb: "Connectors this project uses.",
    action: "Add connector",
    columns: ["Connector", "Type", "Environments", "Last used"],
    empty: "No connectors have been added for this project yet.",
    engine: "connector service",
  },
  integrations: {
    title: "Integrations",
    blurb: "Third-party services wired into this project.",
    action: "Browse integrations",
    columns: ["Integration", "Category", "Added", "Status"],
    empty: "No integrations have been added for this project yet.",
    engine: "integration registry",
  },
  storage: {
    title: "Storage",
    blurb: "Object storage buckets for this project.",
    action: "Create bucket",
    columns: ["Bucket", "Region", "Objects", "Size"],
    empty: "No buckets have been created for this project yet.",
    engine: "object store",
  },
  flags: {
    title: "Flags",
    blurb: "Feature flags for this project.",
    action: "Create flag",
    columns: ["Flag", "Variants", "Environments", "Status"],
    empty: "No feature flags have been created for this project yet.",
    engine: "flags service",
  },
  agent: {
    title: "Agent",
    blurb: "The assistant's tasks for this project.",
    action: null,
    columns: ["Task", "Trigger", "Status", "Finished"],
    empty: "No agent tasks have been run for this project yet.",
    engine: "agent runtime",
  },
  "ai-gateway": {
    title: "AI Gateway",
    blurb: "Model routing and spend for this project.",
    action: "Create key",
    columns: ["Key", "Budget", "Spend", "Created"],
    empty: "No AI Gateway keys have been created for this project yet.",
    engine: "AI gateway",
  },
  sandboxes: {
    title: "Sandboxes",
    blurb: "Isolated machines for this project's agent workloads.",
    action: "Create sandbox",
    columns: ["Sandbox", "Runtime", "Region", "Status"],
    empty: "No sandboxes have been created for this project yet.",
    engine: "sandbox runtime",
  },
  workflows: {
    title: "Workflows",
    blurb: "Durable runs for this project.",
    action: null,
    columns: ["Workflow", "Runs", "Failed", "Last run"],
    empty: "No workflows have been run for this project yet.",
    engine: "workflow runtime",
  },
  images: {
    title: "Images",
    blurb: "Image transformations served for this project.",
    action: null,
    columns: ["Source", "Transformations", "Cache hit rate", "Transfer"],
    empty: "No image transformations have been recorded for this project yet.",
    engine: "image optimizer",
  },
  usage: {
    title: "Usage",
    blurb: "Metered usage for this project.",
    action: null,
    columns: ["Metric", "Used", "Included", "Overage"],
    empty: "No usage has been recorded for this project yet.",
    engine: "usage meter",
  },
  support: {
    title: "Support",
    blurb: "Support cases for this project.",
    action: "Open a case",
    columns: ["Case", "Subject", "Priority", "Status"],
    empty: "No support cases have been filed for this project yet.",
    engine: "support desk",
  },
};
