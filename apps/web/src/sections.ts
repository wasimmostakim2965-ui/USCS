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
  /** What the reference shows when the section has nothing yet. */
  readonly empty: {
    /** The heading of the empty state, as the reference words it. */
    readonly title: string;
    /** The one-line explanation under it. */
    readonly message: string;
    /** The action the empty state offers, when it offers one. */
    readonly action?: string;
  };
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
    empty: {
      title: "No logs yet",
      message:
        "Logs appear here once a deployment serves a request. Runtime logs are per project; open a project to stream its own.",
    },
    engine: "log store",
  },
  analytics: {
    title: "Analytics",
    blurb: "Visitors and page views across this organization.",
    action: null,
    empty: {
      title: "No analytics yet",
      message:
        "Page views appear here once the Web Analytics script is installed in a project and the site has visitors.",
      action: "Install Web Analytics",
    },
    engine: "analytics collector",
  },
  "speed-insights": {
    title: "Speed Insights",
    blurb: "Real-user performance: the Core Web Vitals across this organization.",
    action: null,
    empty: {
      title: "No data available",
      message:
        "Make sure you are using the latest @vercel/speed-insights package and the site has real visitors.",
      action: "Read the quickstart",
    },
    engine: "speed insights collector",
  },
  firewall: {
    title: "Firewall",
    blurb: "Traffic, rules and the audit log for this organization's edge.",
    action: null,
    empty: {
      title: "No firewall rules yet",
      message: "Add an IP, CIDR, ASN or user-agent to block it at the edge.",
      action: "Add rule",
    },
    engine: "edge firewall",
  },
  cdn: {
    title: "CDN",
    blurb: "Cached delivery: requests, cache hit rate and transfer.",
    action: null,
    empty: {
      title: "No caches yet",
      message: "Caches appear once a project is served through the edge.",
    },
    engine: "edge cache",
  },
  env: {
    title: "Environment Variables",
    blurb: "Variables available to this organization's projects.",
    action: "Add variable",
    empty: {
      title: "No environment variables yet",
      message: "Store API keys, tokens and config securely for this organization's projects.",
      action: "Create environment variable",
    },
    engine: "secret store",
  },
  domains: {
    title: "Domains",
    blurb: "Every hostname this organization serves.",
    action: "Add domain",
    empty: {
      title: "No domains yet",
      message: "Add a domain you own, or buy one, to serve a project on it.",
      action: "Add existing domain",
    },
    engine: "domain service",
  },
  connect: {
    title: "Connect",
    blurb: "Connectors and the tokens they issue.",
    action: "Create connector",
    empty: {
      title: "No connectors connected",
      message:
        "Link an existing team connector or create a new one to access third-party APIs from your projects.",
      action: "Create connector",
    },
    engine: "connector service",
  },
  integrations: {
    title: "Integrations",
    blurb: "Third-party services wired into this organization.",
    action: null,
    empty: {
      title: "No integrations installed",
      message:
        "Connect your project with third-party services to automate aspects of your workflow.",
      action: "Browse Marketplace",
    },
    engine: "integration registry",
  },
  storage: {
    title: "Storage",
    blurb: "Object storage buckets and the files in them.",
    action: "Create bucket",
    empty: {
      title: "No storage yet",
      message: "Create a store to keep files, blobs and KV data for this organization's projects.",
      action: "Create bucket",
    },
    engine: "object store",
  },
  database: {
    title: "Database",
    blurb: "Databases, tables, storage and auth.",
    action: "Connect database",
    empty: {
      title: "No databases connected",
      message: "Connect to an existing database, or create a new one and connect it to a project.",
      action: "Connect database",
    },
    engine: "data engine",
  },
  flags: {
    title: "Flags",
    blurb: "Feature flags and who they are rolled out to.",
    action: "Create flag",
    empty: {
      title: "Start using Flags",
      message:
        "Create and manage feature flags directly in Cloud Wai. Toggle behavior instantly, target specific audiences, and ship confidently with progressive rollouts.",
      action: "Create flag",
    },
    engine: "flags service",
  },
  agent: {
    title: "Agent",
    blurb: "The assistant's tasks and what it has done.",
    action: null,
    empty: {
      title: "No agent tasks yet",
      message:
        "Vercel Agent reviews pull requests, validates every suggestion in a sandbox, and flags security issues with patches.",
      action: "Upgrade to Pro",
    },
    engine: "agent runtime",
  },
  "ai-gateway": {
    title: "AI Gateway",
    blurb: "Models, API keys and spend for the managed AI gateway.",
    action: "Create API key",
    empty: {
      title: "Get started with AI Gateway",
      message:
        "AI Gateway gives you access to hundreds of models with one API key, provider routing, and usage tracking.",
      action: "Create an API key",
    },
    engine: "AI gateway",
  },
  sandboxes: {
    title: "Sandboxes",
    blurb: "Isolated machines for agent and one-off workloads.",
    action: "Create sandbox",
    empty: {
      title: "Get started with Sandbox",
      message:
        "Choose what you want to run: a coding agent, Node.js or Python, or AI-generated code.",
      action: "Create sandbox",
    },
    engine: "sandbox runtime",
  },
  workflows: {
    title: "Workflows",
    blurb: "Durable multi-step runs and their steps.",
    action: null,
    empty: {
      title: "Get started with Workflows",
      message:
        "Replace hand-rolled queues and retries with durable, resumable code. Sleep for seconds, hours, or days without using compute.",
      action: "Install the Workflow SDK",
    },
    engine: "workflow runtime",
  },
  images: {
    title: "Images",
    blurb: "Image transformations served from this organization.",
    action: "Create repository",
    empty: {
      title: "No repositories",
      message:
        "Create a repository to start storing container images, then run them on Functions or Sandboxes.",
      action: "Create repository",
    },
    engine: "image optimizer",
  },
  usage: {
    title: "Usage",
    blurb: "Metered usage against each resource's cap.",
    action: null,
    empty: {
      title: "No usage yet",
      message:
        "Usage is metered per project and rolled up here once a project starts serving traffic.",
    },
    engine: "usage meter",
  },
  support: {
    title: "Support",
    blurb: "Open a case and read what has been filed.",
    action: "New case",
    empty: {
      title: "No cases",
      message: "Create a new case to get assistance.",
      action: "New case",
    },
    engine: "support desk",
  },
};

/** The project-level sections, keyed by section. Same contract as above. */
export const PROJECT_SECTIONS_SPEC: Readonly<Record<ProjectSection, SectionSpec>> = {
  "speed-insights": {
    title: "Speed Insights",
    blurb: "Real-user performance: the Core Web Vitals for this project.",
    action: null,
    empty: {
      title: "No data available",
      message:
        "Make sure you are using the latest @vercel/speed-insights package and this project has real visitors.",
      action: "Read the quickstart",
    },
    engine: "speed insights collector",
  },
  observability: {
    title: "Observability",
    blurb: "Requests, traces and errors for this project.",
    action: null,
    empty: {
      title: "No requests yet",
      message:
        "Requests appear here once a deployment serves traffic. Filter by path, status and time range.",
    },
    engine: "observability store",
  },
  firewall: {
    title: "Firewall",
    blurb: "Traffic, rules and the audit log for this project's edge.",
    action: null,
    empty: {
      title: "No firewall rules yet",
      message: "Add an IP, CIDR, ASN or user-agent to block it at the edge.",
      action: "Add rule",
    },
    engine: "edge firewall",
  },
  cdn: {
    title: "CDN",
    blurb: "Cached delivery for this project.",
    action: null,
    empty: {
      title: "No caches yet",
      message: "Caches appear once this project is served through the edge.",
    },
    engine: "edge cache",
  },
  connect: {
    title: "Connect",
    blurb: "Connectors this project uses.",
    action: "Create connector",
    empty: {
      title: "No connectors connected",
      message:
        "Link an existing team connector or create a new one to access third-party APIs from this project.",
      action: "Create connector",
    },
    engine: "connector service",
  },
  integrations: {
    title: "Integrations",
    blurb: "Third-party services wired into this project.",
    action: null,
    empty: {
      title: "No integrations installed",
      message:
        "Connect this project with third-party services to automate aspects of your workflow.",
      action: "Browse Marketplace",
    },
    engine: "integration registry",
  },
  storage: {
    title: "Storage",
    blurb: "Object storage buckets for this project.",
    action: "Create bucket",
    empty: {
      title: "No storage yet",
      message: "Create a store to keep files, blobs and KV data for this project.",
      action: "Create bucket",
    },
    engine: "object store",
  },
  flags: {
    title: "Flags",
    blurb: "Feature flags for this project.",
    action: "Create flag",
    empty: {
      title: "Start using Flags",
      message:
        "Create and manage feature flags directly in Cloud Wai. Toggle behavior instantly, target specific audiences, and ship confidently with progressive rollouts.",
      action: "Create flag",
    },
    engine: "flags service",
  },
  agent: {
    title: "Agent",
    blurb: "The assistant's tasks for this project.",
    action: null,
    empty: {
      title: "No agent tasks yet",
      message:
        "Vercel Agent reviews pull requests for this project, validates every suggestion in a sandbox, and flags security issues with patches.",
      action: "Upgrade to Pro",
    },
    engine: "agent runtime",
  },
  "ai-gateway": {
    title: "AI Gateway",
    blurb: "Model routing and spend for this project.",
    action: "Create API key",
    empty: {
      title: "Get started with AI Gateway",
      message:
        "AI Gateway gives you access to hundreds of models with one API key, provider routing, and usage tracking.",
      action: "Create an API key",
    },
    engine: "AI gateway",
  },
  sandboxes: {
    title: "Sandboxes",
    blurb: "Isolated machines for this project's agent workloads.",
    action: "Create sandbox",
    empty: {
      title: "Get started with Sandbox",
      message:
        "Choose what you want to run: a coding agent, Node.js or Python, or AI-generated code.",
      action: "Create sandbox",
    },
    engine: "sandbox runtime",
  },
  workflows: {
    title: "Workflows",
    blurb: "Durable runs for this project.",
    action: null,
    empty: {
      title: "Get started with Workflows",
      message:
        "Replace hand-rolled queues and retries with durable, resumable code. Sleep for seconds, hours, or days without using compute.",
      action: "Install the Workflow SDK",
    },
    engine: "workflow runtime",
  },
  images: {
    title: "Images",
    blurb: "Image transformations served for this project.",
    action: "Create repository",
    empty: {
      title: "No repositories",
      message:
        "Create a repository to start storing container images, then run them on Functions or Sandboxes.",
      action: "Create repository",
    },
    engine: "image optimizer",
  },
  usage: {
    title: "Usage",
    blurb: "Metered usage for this project.",
    action: null,
    empty: {
      title: "No usage yet",
      message: "Usage is metered once this project starts serving traffic.",
    },
    engine: "usage meter",
  },
  support: {
    title: "Support",
    blurb: "Support cases for this project.",
    action: "New case",
    empty: {
      title: "No cases",
      message: "Create a new case to get assistance.",
      action: "New case",
    },
    engine: "support desk",
  },
};
