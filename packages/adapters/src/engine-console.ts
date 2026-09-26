/**
 * Engine-console deep links.
 *
 * ADR-0011 (Option A) keeps Cloud Wai out of the tenant data plane: it never
 * opens a connection to a tenant database and never issues SQL. The Database
 * section is therefore not a query console — it is a control-plane view that
 * points at the engine's *own* console for the operations Cloud Wai does not
 * proxy.
 *
 * This module is the one place that knows the console's URL shape, and it is a
 * pure function so it can be checked against the engine's real route table
 * rather than guessed. The route suffixes below are the ones Coolify exposes at
 * the pinned commit (`tests/fixtures/coolify-console-routes.json`); the
 * conformance test fails the build if a suffix here is absent there.
 *
 * A link is returned only when *every* identifier the path needs is present and
 * well-formed. A partial configuration yields `null`, which the dashboard shows
 * as an honest "console link is not configured" rather than a dead or broken
 * link. The base URL is supplied by the deployment (`ENGINE_CONSOLE_URL`), so a
 * deployment that has no tenant-reachable console simply has no links.
 */
import type { CoolifyCredentials } from "./coolify.js";

/**
 * The database-resource sections of the engine console.
 *
 * This is the vocabulary the dashboard's Database sub-pages map onto, so a
 * sub-page that cannot act through the control plane can still send the operator
 * to the engine's own screen for that concern.
 */
export const CONSOLE_SECTIONS = [
  "overview",
  "environment-variables",
  "logs",
  "backups",
  "metrics",
  "resource-limits",
  "import-backup",
  "persistent-storage",
  "healthcheck",
  "servers",
  "webhooks",
  "tags",
  "danger",
  "terminal",
] as const;

export type ConsoleSection = (typeof CONSOLE_SECTIONS)[number];

/**
 * The path suffix each section appends to the database-resource prefix.
 *
 * `overview` is the prefix itself, which is why its suffix is empty. Every
 * non-empty value is a literal from the pinned console route table.
 */
const SECTION_SUFFIX: Readonly<Record<ConsoleSection, string>> = {
  overview: "",
  "environment-variables": "/environment-variables",
  logs: "/logs",
  backups: "/backups",
  metrics: "/metrics",
  "resource-limits": "/resource-limits",
  "import-backup": "/import-backup",
  "persistent-storage": "/persistent-storage",
  healthcheck: "/healthcheck",
  servers: "/servers",
  webhooks: "/webhooks",
  tags: "/tags",
  danger: "/danger",
  terminal: "/terminal",
};

/**
 * The console's database-resource route prefix, with `{placeholders}`.
 *
 * Kept as a template so the conformance test can expand it and compare against
 * the pinned table, instead of the test restating the path and drifting from it.
 */
export const DATABASE_CONSOLE_PREFIX =
  "/project/{project_uuid}/environment/{environment_uuid}/database/{database_uuid}";

/**
 * Coolify's own identifier grammar.
 *
 * Ids are alphanumeric and 20–36 characters (a CUID or a UUID). Anything else —
 * an empty string, a path segment, a `..` — is refused before it reaches a URL,
 * so a malformed handle cannot turn into a traversal in a link we render.
 */
const ID_PATTERN = /^[A-Za-z0-9]{20,36}$/;

/** The provider whose console these routes belong to. */
const CONSOLE_PROVIDER = "postgres";

export interface EngineConsoleInput {
  /** The tenant-reachable console origin, or undefined when none is configured. */
  readonly baseUrl?: string | undefined;
  /** The resource's provider, as the control plane recorded it. */
  readonly provider: string | null;
  /** Only a database has this console; a bucket is served by the storage engine. */
  readonly resourceKind: "postgres" | "object_storage";
  /** The engine's own handle for the resource. Null until provisioning answered. */
  readonly resourceUuid: string | null;
  /** The tenant's placement in the engine. */
  readonly infra?:
    | Pick<CoolifyCredentials, "projectUuid" | "environmentUuid" | "environmentName">
    | undefined;
  readonly section?: ConsoleSection | undefined;
}

/**
 * A tenant-reachable console link for a resource, or null.
 *
 * Null is the honest answer for every incomplete case — no base URL, a bucket, a
 * resource the engine has not named yet, a placement that names its environment
 * by name rather than by uuid (the console path needs the uuid), or a malformed
 * identifier. The caller renders that as "not configured", never as a dead link.
 */
export function engineConsoleUrl(input: EngineConsoleInput): string | null {
  const origin = normalizeOrigin(input.baseUrl);
  if (!origin) return null;
  if (input.provider !== CONSOLE_PROVIDER) return null;
  if (input.resourceKind !== "postgres") return null;

  const projectUuid = input.infra?.projectUuid?.trim() ?? "";
  const environmentUuid = input.infra?.environmentUuid?.trim() ?? "";
  const resourceUuid = input.resourceUuid?.trim() ?? "";
  if (!ID_PATTERN.test(projectUuid)) return null;
  if (!ID_PATTERN.test(environmentUuid)) return null;
  if (!ID_PATTERN.test(resourceUuid)) return null;

  const section = input.section ?? "overview";
  const suffix = SECTION_SUFFIX[section];
  if (suffix === undefined) return null;

  const path = DATABASE_CONSOLE_PREFIX.replace("{project_uuid}", projectUuid)
    .replace("{environment_uuid}", environmentUuid)
    .replace("{database_uuid}", resourceUuid);
  return `${origin}${path}${suffix}`;
}

/**
 * A bare origin, or null.
 *
 * Only `http`/`https` are accepted: a `javascript:` or `data:` base would make
 * the rendered link a script URL. A trailing slash is dropped so the result
 * cannot carry a double slash.
 */
function normalizeOrigin(baseUrl: string | undefined): string | null {
  const raw = baseUrl?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * The resource facts a console link needs.
 *
 * Structural, not the control-plane `DataResource` type: the adapters package
 * must not depend on the database package's shape, and a caller that has those
 * four facts can build a link without constructing a whole resource row.
 */
export interface ConsoleResourceFacts {
  readonly provider: string | null;
  readonly kind: "postgres" | "object_storage";
  readonly providerResourceId: string | null;
}

/** The engine identifiers a console link needs, from the deployment's env. */
export interface ConsoleLinkerInput {
  readonly organizationId: string;
  readonly resource: ConsoleResourceFacts;
}

/**
 * The console links the dashboard needs for one resource, keyed by section.
 *
 * The whole record is resolved server-side so the browser bundle never restates
 * the engine's URL grammar: it picks a key, not a path. Every section is present
 * because the link is all-or-nothing — a deployment either has a console for
 * this resource or it does not, and a half-built record would let a page render
 * one working link beside a dead one.
 */
export type EngineConsoleLinks = Readonly<Record<ConsoleSection, string>>;

/**
 * Build the console links for one resource, or null.
 *
 * The whole record is null when any section cannot be built, so the dashboard
 * never renders a row with one working link and one dead one: either the
 * deployment has a console for this resource or it says it does not.
 */
export function engineConsoleLinks(input: EngineConsoleInput): EngineConsoleLinks | null {
  const links = {} as Record<ConsoleSection, string>;
  for (const section of CONSOLE_SECTIONS) {
    const url = engineConsoleUrl({ ...input, section });
    if (!url) return null;
    links[section] = url;
  }
  return links;
}

/**
 * Build a resolver from a deployment's environment, or undefined.
 *
 * Undefined when `ENGINE_CONSOLE_URL` is unset: a deployment with no
 * tenant-reachable console has no links to offer, and saying so once at wiring
 * time is clearer than testing the origin on every resource.
 *
 * The placement (`COOLIFY_PROJECT_UUID__<org>`, `COOLIFY_ENVIRONMENT_UUID__<org>`)
 * is read from the same variables the adapters use, so the link and the engine
 * call cannot disagree about where a tenant's database lives. Environment *name*
 * is deliberately not a fallback: the console path needs the uuid.
 */
export function createEngineConsoleLinker(
  env: Record<string, string | undefined>,
): ((input: ConsoleLinkerInput) => EngineConsoleLinks | null) | undefined {
  const baseUrl = env.ENGINE_CONSOLE_URL;
  if (!baseUrl || baseUrl.trim() === "") return undefined;

  const placement: Record<string, { projectUuid?: string; environmentUuid?: string }> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.trim() === "") continue;
    const project = key.match(/^COOLIFY_PROJECT_UUID__(.+)$/);
    if (project) {
      (placement[project[1]!] ??= {}).projectUuid = value.trim();
      continue;
    }
    const environment = key.match(/^COOLIFY_ENVIRONMENT_UUID__(.+)$/);
    if (environment) {
      (placement[environment[1]!] ??= {}).environmentUuid = value.trim();
    }
  }

  return (input) =>
    engineConsoleLinks({
      baseUrl,
      provider: input.resource.provider,
      resourceKind: input.resource.kind,
      resourceUuid: input.resource.providerResourceId,
      infra: placement[input.organizationId],
    });
}
