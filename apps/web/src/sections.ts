/**
 * The section catalogue.
 *
 * Every section in the sidebar describes itself from here: a title, the icon and
 * colour that identify it, the engine that would back it and its honest status,
 * and — the point of this file — the *shape* of its page. A Firewall is a
 * control room, Flags is a chooser, AI Gateway is a numbered quickstart, Usage
 * is a set of capped meters. The layout is the section's identity, not a
 * template with the nouns swapped.
 *
 * The shapes and the copy are read off the reference the owner supplied — 23
 * screenshots of a Vercel dashboard, plus the pages each menu entry opens. The
 * screenshots are the authority for what a section page contains and how it is
 * arranged; they are not remembered. The colour is the one deliberate departure:
 * the reference is near-white, and the owner asked for a screen that is not
 * pure white, so each section carries a restrained tint used only on tiles,
 * rules and rails, never on body copy.
 *
 * None of these engines are wired in this deployment, so every section says so
 * rather than showing a fabricated row. The status a page displays is the
 * deployment's own: `SectionPage` reads the engine report and replaces the
 * `notConfigured` default when the named engine turns out to be wired, so a
 * host that sets `STORAGE_ENDPOINT` sees "Configured" without this file
 * changing. `Readonly<Record<...>>` is the point: adding a section without a
 * spec is a type error, so the menu can never grow a page that has nothing to
 * say.
 */
import type { IconName } from "@cloud-wai/ui";
import type { SectionBody, Tint, EngineStatus } from "@cloud-wai/ui/react";
import type { ProjectSection, WorkspaceSection } from "./routes.js";

export interface SectionSpec {
  /** The page heading. Matches the sidebar label. */
  readonly title: string;
  /** The line under the heading: what this section is for. */
  readonly blurb: string;
  /** The glyph that identifies the section in the heading tile. */
  readonly icon: IconName;
  /** The section's colour identity, applied to tiles, rules and rails. */
  readonly tint: Tint;
  /** The engine that would back this section, named for the operator. */
  readonly engine: string;
  /** That engine's honest state in this deployment. */
  readonly status: EngineStatus;
  /** Where the reference sends a reader who wants the long version. */
  readonly docs?: { readonly label: string; readonly href: string };
  /** The page's shape and content. */
  readonly body: SectionBody;
}

/** The engine is not wired here: the page must say so, not fake a row. */
function notConfigured(engine: string): EngineStatus {
  return {
    tone: "warn",
    label: "Not configured",
    detail: `No ${engine} is wired into this deployment, so this page reports nothing rather than inventing it.`,
  };
}

function verified(engine: string): EngineStatus {
  return {
    tone: "ok",
    label: "Configured",
    detail: `Answered by the ${engine}, confirmed on the last read.`,
  };
}

/**
 * The status to show once the deployment's engine report says the engine is
 * wired. Exported so the page derives "Configured" from what the server
 * actually answered, rather than a value baked into the catalogue.
 */
export function configuredStatus(engine: string): EngineStatus {
  return verified(engine);
}

/**
 * The provider key an engine's health is reported under.
 *
 * `providers.health` names engines by adapter (`minio`), while a section names
 * the capability ("object store"). Only engines whose adapter is actually known
 * are listed: an entry here is a claim that the adapter really backs that
 * section, and guessing one would let a configured adapter turn an unrelated
 * section green. A section absent from this map keeps its catalogue status.
 */
const ENGINE_PROVIDER: Readonly<Record<string, string>> = {
  "object store": "minio",
};

export function engineProvider(engine: string): string | undefined {
  return ENGINE_PROVIDER[engine];
}

const DOCS = { label: "Documentation", href: "https://vercel.com/docs" } as const;

/** An empty list page: named columns, no rows, an honest filter box. */
function emptyTable(
  caption: string,
  columns: readonly { readonly key: string; readonly header: string }[],
  filterLabel: string,
): SectionBody {
  return { kind: "table", caption, columns, rows: [], filterLabel };
}

export const WORKSPACE_SECTIONS_SPEC: Readonly<Record<WorkspaceSection, SectionSpec>> = {
  logs: {
    title: "Logs",
    blurb: "Runtime logs across this organization, newest first.",
    icon: "logs",
    tint: "slate",
    engine: "log store",
    status: notConfigured("log store"),
    body: emptyTable(
      "Runtime logs",
      [
        { key: "time", header: "Time" },
        { key: "status", header: "Status" },
        { key: "method", header: "Method" },
        { key: "path", header: "Path" },
        { key: "duration", header: "Duration" },
      ],
      "Filter logs",
    ),
  },
  analytics: {
    title: "Analytics",
    blurb: "Visitors and page views across this organization.",
    icon: "chart",
    tint: "blue",
    engine: "analytics collector",
    status: notConfigured("analytics collector"),
    docs: DOCS,
    body: {
      kind: "intro",
      hero: {
        title: "Web Analytics",
        body: "Collect insights on user behavior and site performance with detailed page view metrics, and gain knowledge on top pages.",
      },
      promises: [
        {
          title: "Real-time insights into your traffic",
          body: "Ensure smooth performance with real-time bandwidth analysis as requests arrive.",
        },
        {
          title: "Deeper insights with custom events",
          body: "Track whatever is relevant for your website, from a sign-up to a checkout step.",
        },
      ],
    },
  },
  "speed-insights": {
    title: "Speed Insights",
    blurb: "Real-user performance: the Core Web Vitals across this organization.",
    icon: "pulse",
    tint: "green",
    engine: "speed insights collector",
    status: notConfigured("speed insights collector"),
    docs: { label: "Read the quickstart", href: "https://vercel.com/docs/speed-insights" },
    body: {
      kind: "score",
      score: null,
      verdict: "Real Experience Score",
      body: "Measures the overall user experience. To provide a good user experience, pages should have a RES of more than 80.",
      unavailable:
        "No data available. Make sure you are using the latest @vercel/speed-insights package and the site has real visitors.",
    },
  },
  firewall: {
    title: "Firewall",
    blurb: "Traffic, rules and the audit log for this organization's edge.",
    icon: "shield",
    tint: "rose",
    engine: "edge firewall",
    status: notConfigured("edge firewall"),
    body: {
      kind: "control",
      banner: {
        label: "Firewall is not active",
        detail: "No edge is attached to this deployment.",
      },
      metrics: [
        { label: "Custom Rules", value: "0", note: "Rules you have written" },
        { label: "Bot Protection", value: "Inactive", note: "Managed challenge" },
        { label: "Allowed", value: "0", note: "Requests in range" },
        { label: "Denied", value: "0", note: "Requests in range" },
      ],
      panels: [
        {
          title: "Traffic",
          empty: "No traffic in range. Allowed, denied and challenged requests appear here.",
        },
        { title: "Alerts", empty: "No alerts. Anomalies surface here as they are detected." },
        { title: "Rules", empty: "No rules. Custom rules and their actions appear here." },
      ],
    },
  },
  cdn: {
    title: "CDN",
    blurb: "Cached delivery: requests, cache hit rate and transfer.",
    icon: "pulse",
    tint: "cyan",
    engine: "delivery network",
    status: notConfigured("delivery network"),
    body: {
      kind: "meters",
      meters: [
        {
          label: "Cache hit rate",
          ratio: "—",
          percent: 0,
          note: "Served from the cache over all requests.",
        },
        {
          label: "CDN Requests",
          ratio: "0 / 1M",
          percent: 0,
          note: "Counted per request against this organization's cap.",
        },
        {
          label: "Fast Data Transfer",
          ratio: "0 B / 100 GB",
          percent: 0,
          note: "Between the edge and end users.",
        },
        {
          label: "Edge CPU Duration",
          ratio: "0 / 1h",
          percent: 0,
          note: "Compute time spent at the edge.",
        },
      ],
    },
  },
  env: {
    title: "Environment Variables",
    blurb: "Variables available to this organization's projects.",
    icon: "env",
    tint: "amber",
    engine: "secret store",
    status: notConfigured("secret store"),
    body: emptyTable(
      "Environment variables",
      [
        { key: "key", header: "Key" },
        { key: "environments", header: "Environments" },
        { key: "updated", header: "Updated" },
      ],
      "Search variables",
    ),
  },
  domains: {
    title: "Domains",
    blurb: "Every hostname this organization serves.",
    icon: "domains",
    tint: "teal",
    engine: "domain registry",
    status: notConfigured("domain registry"),
    body: emptyTable(
      "Domains",
      [
        { key: "domain", header: "Domain" },
        { key: "project", header: "Project" },
        { key: "configuration", header: "Configuration" },
      ],
      "Filter domains",
    ),
  },
  connect: {
    title: "Connect",
    blurb: "Connectors and the tokens they issue.",
    icon: "connect",
    tint: "slate",
    engine: "connector registry",
    status: notConfigured("connector registry"),
    body: {
      kind: "empty",
      empty: {
        icon: "connect",
        title: "No connectors connected",
        message:
          "Link an existing team connector or create a new one to access third-party APIs from this organization.",
        action: "Link Connector",
      },
    },
  },
  integrations: {
    title: "Integrations",
    blurb: "Third-party services wired into this organization.",
    icon: "integrations",
    tint: "violet",
    engine: "integration marketplace",
    status: notConfigured("integration marketplace"),
    body: {
      kind: "gallery",
      tiles: [
        {
          title: "Supabase",
          body: "Postgres, auth and storage for your project.",
          icon: "database",
        },
        {
          title: "LaunchDarkly",
          body: "Feature flags and experimentation to ship with confidence.",
          icon: "flag",
        },
        { title: "Algolia", body: "AI-powered search and discovery for your app.", icon: "search" },
        {
          title: "Neon",
          body: "Serverless Postgres with branching for previews.",
          icon: "database",
        },
        {
          title: "Sentry",
          body: "Error and performance monitoring for every deploy.",
          icon: "activity",
        },
        {
          title: "GitHub",
          body: "Deploy on push from a repository you already own.",
          icon: "github",
        },
      ],
    },
  },
  storage: {
    title: "Storage",
    blurb: "Object storage buckets for this organization.",
    icon: "storage",
    tint: "teal",
    engine: "object store",
    status: notConfigured("object store"),
    body: {
      kind: "choosers",
      choosers: [
        {
          title: "Create a bucket",
          body: "Provision a new object store bucket for this organization and connect it to a project.",
          action: "Create bucket",
          featured: true,
          icon: "storage",
        },
        {
          title: "Connect an existing bucket",
          body: "Link a bucket that already exists in this team so its objects are readable from a project.",
          action: "Connect bucket",
          icon: "connect",
        },
      ],
    },
  },
  flags: {
    title: "Flags",
    blurb: "Feature flags and who they are rolled out to.",
    icon: "flag",
    tint: "amber",
    engine: "flag service",
    status: notConfigured("flag service"),
    docs: DOCS,
    body: {
      kind: "choosers",
      choosers: [
        {
          title: "Use Vercel Flags",
          body: "Create and manage feature flags directly here. Toggle behavior instantly, target specific audiences, and ship confidently with progressive rollouts.",
          action: "Create Flag",
          featured: true,
          icon: "flag",
        },
        {
          title: "Connect Providers",
          body: "Choose the experimentation platform of your choice and sync flags, rules and targets into it.",
          action: "Browse Providers",
          icon: "integrations",
        },
      ],
    },
  },
  agent: {
    title: "Agent",
    blurb: "The assistant's tasks and what it has done.",
    icon: "agent",
    tint: "rose",
    engine: "agent runtime",
    status: notConfigured("agent runtime"),
    body: {
      kind: "intro",
      hero: {
        title: "Ship faster and safer with the agent",
        body: "Get your pull requests automatically reviewed, with every suggestion validated before you see it.",
      },
      promises: [
        {
          title: "Validated improvements",
          body: "Every suggestion is validated in a sandbox, so you only see changes that already work.",
        },
        {
          title: "Threat-modelled security",
          body: "All checks run in hardened sandboxes designed to protect against attacks. Issues surface with patches, not just alerts.",
        },
        {
          title: "Framework-aware",
          body: "Optimized for Next.js, React, Nuxt and Svelte. Understands framework best practices and spots misuse early.",
        },
        {
          title: "Last-mile verification",
          body: "A reasoning layer that catches subtle mistakes from both humans and AI before changes ship.",
        },
      ],
    },
  },
  "ai-gateway": {
    title: "AI Gateway",
    blurb: "Models, API keys and spend for the managed AI gateway.",
    icon: "gateway",
    tint: "violet",
    engine: "AI gateway",
    status: notConfigured("AI gateway"),
    docs: DOCS,
    body: {
      kind: "steps",
      steps: [
        {
          title: "Create an API key",
          body: "Use it to authenticate requests, track spend and set budgets.",
        },
        {
          title: "Add credit or use the free tier",
          body: "The free tier covers a limited set of models each month. Paid credit unlocks every available model without rate limits.",
        },
        {
          title: "Export your API key",
          body: "Your key is shown once. Export it in the terminal running the example.",
          code: ['export AI_GATEWAY_API_KEY="your_api_key_here"'],
        },
        {
          title: "Make your first request",
          body: "Try a model through the gateway with cURL, the AI SDK, or a coding agent.",
          code: [
            "# Chat Completions",
            "curl https://ai-gateway.vercel.sh/v1/chat/completions \\",
            '  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \\',
            '  -d \'{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}\'',
          ],
        },
      ],
    },
  },
  sandboxes: {
    title: "Sandboxes",
    blurb: "Isolated machines for agent and one-off workloads.",
    icon: "sandbox",
    tint: "cyan",
    engine: "sandbox runtime",
    status: notConfigured("sandbox runtime"),
    docs: DOCS,
    body: {
      kind: "gallery",
      tiles: [
        {
          title: "Run a coding agent",
          body: "Give Claude, Codex or OpenCode a workspace.",
          icon: "agent",
        },
        {
          title: "Run my code",
          body: "Use Node.js or Python without local setup.",
          icon: "sandbox",
        },
        {
          title: "Run AI-generated code",
          body: "Safely execute output from your app or agent.",
          icon: "shield",
        },
        {
          title: "Long-running jobs",
          body: "Sleep for seconds, hours or days without using compute.",
          icon: "workflow",
        },
      ],
    },
  },
  workflows: {
    title: "Workflows",
    blurb: "Durable multi-step runs and their steps.",
    icon: "workflow",
    tint: "blue",
    engine: "workflow runtime",
    status: notConfigured("workflow runtime"),
    docs: DOCS,
    body: {
      kind: "steps",
      steps: [
        {
          title: "Install the Workflow SDK",
          body: "Add durable, resumable functions to any Next.js, Astro or Express app.",
          code: ["$ npx workflow"],
        },
        {
          title: "Write a workflow",
          body: "Replace hand-rolled queues and retries with code that sleeps, retries and resumes.",
          code: [
            'import { sleep } from "workflow";',
            "",
            "export async function handleSignup(email: string) {",
            '  "use workflow";',
            "  const user = await createUser(email);",
            "  await sendWelcomeEmail(user);",
            '  await sleep("5s");',
            "  await sendOnboardingEmail(user);",
            "}",
          ],
        },
        {
          title: "Create your first workflow",
          body: "Run this command to scaffold a workflow in your project.",
          code: ["$ npx skills add vercel/workflow --skill workflow-init"],
        },
      ],
    },
  },
  images: {
    title: "Images",
    blurb: "Image transformations served from this organization.",
    icon: "images",
    tint: "green",
    engine: "image optimizer",
    status: notConfigured("image optimizer"),
    docs: DOCS,
    body: {
      kind: "empty",
      empty: {
        icon: "images",
        title: "No repositories",
        message:
          "Repositories store container images for this organization, then run them on functions or sandboxes. Create a repository to start storing container images.",
        action: "Create Repository",
      },
    },
  },
  usage: {
    title: "Usage",
    blurb: "Metered usage against each resource's cap.",
    icon: "chart",
    tint: "amber",
    engine: "metering service",
    status: notConfigured("metering service"),
    body: {
      kind: "meters",
      meters: [
        {
          label: "Fast Data Transfer",
          ratio: "0 B / 100 GB",
          percent: 0,
          note: "Between the CDN and end users.",
        },
        {
          label: "Fast Origin Transfer",
          ratio: "0 B / 10 GB",
          percent: 0,
          note: "Between the CDN and compute.",
        },
        { label: "CDN Requests", ratio: "0 / 1M", percent: 0, note: "Counted per request." },
        {
          label: "Microfrontends Routing",
          ratio: "0 / 50K",
          percent: 0,
          note: "Routing decisions per month.",
        },
        {
          label: "ISR Reads",
          ratio: "0 / 1M",
          percent: 0,
          note: "Incremental static regeneration reads.",
        },
      ],
    },
  },
  support: {
    title: "Support",
    blurb: "Open a case and read what has been filed.",
    icon: "support",
    tint: "blue",
    engine: "support desk",
    status: notConfigured("support desk"),
    body: emptyTable(
      "Cases",
      [
        { key: "subject", header: "Subject" },
        { key: "status", header: "Status" },
        { key: "severity", header: "Severity" },
        { key: "updated", header: "Updated" },
      ],
      "Search cases",
    ),
  },
};

/** The one-line, project-scoped wording for each shared section. */
const PROJECT_BLURBS: Readonly<Record<ProjectSection, string>> = {
  "speed-insights": "Real-user performance: the Core Web Vitals for this project.",
  observability: "Requests, traces and errors for this project.",
  firewall: "Traffic, rules and the audit log for this project's edge.",
  cdn: "Cached delivery for this project.",
  connect: "Connectors this project uses.",
  integrations: "Third-party services wired into this project.",
  storage: "Object storage buckets for this project.",
  flags: "Feature flags for this project.",
  agent: "The assistant's tasks for this project.",
  "ai-gateway": "Model routing and spend for this project.",
  sandboxes: "Isolated machines for this project's agent workloads.",
  workflows: "Durable runs for this project.",
  images: "Image transformations served for this project.",
  usage: "Metered usage for this project.",
  support: "Support cases for this project.",
};

/**
 * Observability is project-scoped only — a request is served by one project's
 * deployment, so there is no organization-wide view to draw. It is defined here
 * rather than in the workspace record because the workspace sidebar does not
 * list it.
 */
const OBSERVABILITY_SPEC: SectionSpec = {
  title: "Observability",
  blurb: PROJECT_BLURBS.observability,
  icon: "pulse",
  tint: "violet",
  engine: "observability store",
  status: notConfigured("observability store"),
  body: {
    kind: "board",
    metrics: [
      { label: "Requests", value: "0", note: "Last 24 hours" },
      { label: "Error rate", value: "0%", note: "5xx over all responses" },
      { label: "P95 latency", value: "—", note: "Edge to origin" },
    ],
    panels: [
      {
        title: "CDN Requests",
        empty: "No requests recorded. Traffic appears here once this project serves a request.",
      },
      {
        title: "Fast Data Transfer",
        empty: "No transfer recorded. Outgoing and incoming are read from the edge.",
      },
      {
        title: "Functions",
        empty: "No invocations recorded. Errors and timeouts appear here per function.",
      },
    ],
  },
};

/**
 * The project-level specs.
 *
 * A project's sections are the same pages scoped to one project, so they are
 * derived from the workspace spec rather than restated — only the blurb changes.
 * Deriving them is what keeps a fix to a section's shape from having to be made
 * twice. Observability is the one project-only section, so it is merged in.
 */
export const PROJECT_SECTIONS_SPEC: Readonly<Record<ProjectSection, SectionSpec>> =
  Object.fromEntries(
    (Object.keys(PROJECT_BLURBS) as readonly ProjectSection[]).map((section) => [
      section,
      section === "observability"
        ? OBSERVABILITY_SPEC
        : { ...WORKSPACE_SECTIONS_SPEC[section], blurb: PROJECT_BLURBS[section] },
    ]),
  ) as Readonly<Record<ProjectSection, SectionSpec>>;
