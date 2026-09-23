/**
 * Engine wiring.
 *
 * This is the single place a deployment decides which engines are real. The
 * rule: if the configuration for an engine is incomplete, that engine is wired
 * to its `notConfigured` implementation. It is never silently pointed at a fake,
 * because a fake in production would report success for work that never ran.
 *
 * The fakes are available only when explicitly requested, which is what tests
 * and local development do.
 */
import {
  databaseNotConfigured,
  fakeDatabase,
  fakeHosting,
  hostingNotConfigured,
  securityNotConfigured,
  storageNotConfigured,
  createCoolifyHosting,
  type CoolifyCredentials,
  type DatabaseAdapter,
  type HostingAdapter,
  type SecurityEdgeAdapter,
  type NotConfiguredBrand,
  type StorageAdapter,
} from "./index.js";
import type { OrganizationId } from "@cloud-wai/contracts";

export interface EngineConfig {
  /** Base URL for the Coolify API, or absent when hosting is not configured. */
  readonly coolifyUrl?: string | undefined;
  /** Per-organization Coolify tokens, keyed by organization id. */
  readonly coolifyTokens?: Readonly<Record<string, string>> | undefined;
  readonly databaseConfigured?: boolean | undefined;
  readonly storageConfigured?: boolean | undefined;
  readonly securityEdgeConfigured?: boolean | undefined;
  /** Use in-memory engines. Only for tests and local development. */
  readonly useFakes?: boolean | undefined;
}

export interface Engines {
  readonly hosting: HostingAdapter;
  readonly database: DatabaseAdapter;
  readonly storage: StorageAdapter;
  readonly securityEdge: SecurityEdgeAdapter;
}

/** Read engine configuration from an environment-style record. */
export function engineConfigFromEnv(env: Record<string, string | undefined>): EngineConfig {
  const tokens: Record<string, string> = {};
  // Tokens are per organization: COOLIFY_TOKEN__<orgId>=<token>.
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^COOLIFY_TOKEN__(.+)$/);
    if (match && value && value.trim() !== "") tokens[match[1]!] = value;
  }
  return {
    coolifyUrl: env.COOLIFY_URL,
    coolifyTokens: tokens,
    databaseConfigured: Boolean(env.DATABASE_ENGINE_URL),
    storageConfigured: Boolean(env.STORAGE_ENGINE_URL),
    securityEdgeConfigured: Boolean(env.SECURITY_EDGE_URL),
    useFakes: env.CLOUD_WAI_USE_FAKE_ENGINES === "true",
  };
}

/**
 * Build the engine set for this deployment.
 *
 * Every branch that lacks configuration returns the honest `not_configured`
 * adapter, so the UI and API can say "not configured" instead of showing a
 * resource that does not exist.
 */
export function buildEngines(config: EngineConfig): Engines {
  if (config.useFakes) {
    return {
      hosting: fakeHosting(),
      database: fakeDatabase(),
      storage: storageNotConfigured("minio"),
      securityEdge: securityNotConfigured("envoy"),
    };
  }

  const url = config.coolifyUrl?.trim();
  const tokens = config.coolifyTokens ?? {};

  const hosting: HostingAdapter =
    url && Object.keys(tokens).length > 0
      ? createCoolifyHosting({
          credentials: (organizationId: OrganizationId): CoolifyCredentials | null => {
            const token = tokens[organizationId];
            return token ? { baseUrl: url, token } : null;
          },
        })
      : hostingNotConfigured(
          "coolify",
          "Set COOLIFY_URL and at least one COOLIFY_TOKEN__<organizationId>.",
        );

  return {
    hosting,
    database: config.databaseConfigured
      ? databaseNotConfigured("postgres", "Provisioning engine not yet implemented.")
      : databaseNotConfigured("postgres", "Set DATABASE_ENGINE_URL."),
    storage: config.storageConfigured
      ? storageNotConfigured("minio", "Bucket API not yet implemented.")
      : storageNotConfigured("minio", "Set STORAGE_ENGINE_URL."),
    securityEdge: config.securityEdgeConfigured
      ? securityNotConfigured("envoy", "Edge API not yet implemented.")
      : securityNotConfigured("envoy", "Set SECURITY_EDGE_URL."),
  };
}

/**
 * Report which engines this deployment can actually act on.
 *
 * Reads the brand rather than calling the engine: probing would need
 * credentials and could have side effects.
 */
export function engineReport(engines: Engines): readonly {
  engine: string;
  configured: boolean;
}[] {
  const isConfigured = (adapter: NotConfiguredBrand) => adapter.__notConfigured !== true;
  return [
    { engine: "coolify", configured: isConfigured(engines.hosting) },
    { engine: "postgres", configured: isConfigured(engines.database) },
    { engine: "minio", configured: isConfigured(engines.storage) },
    { engine: "envoy", configured: isConfigured(engines.securityEdge) },
  ];
}
