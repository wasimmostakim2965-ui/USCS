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
  createPostgresDatabase,
  createMinioStorage,
  type CoolifyCredentials,
  type DatabaseAdapter,
  type HostingAdapter,
  type SecurityEdgeAdapter,
  type NotConfiguredBrand,
  type StorageAdapter,
  type StorageCredentials,
} from "./index.js";
import type { OrganizationId } from "@cloud-wai/contracts";

export interface EngineConfig {
  /** Base URL for the Coolify API, or absent when hosting is not configured. */
  readonly coolifyUrl?: string | undefined;
  /** Per-organization Coolify tokens, keyed by organization id. */
  readonly coolifyTokens?: Readonly<Record<string, string>> | undefined;
  /** S3-compatible endpoint for tenant object storage. */
  readonly storageEndpoint?: string | undefined;
  /** Per-organization storage credentials, keyed by organization id. */
  readonly storageCredentials?:
    Readonly<Record<string, { accessKey: string; secretKey: string }>> | undefined;
  /** The security edge (Envoy) is not wired yet; it stays honestly unconfigured. */
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

  const accessKeys: Record<string, string> = {};
  const secretKeys: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const access = key.match(/^STORAGE_ACCESS_KEY__(.+)$/);
    if (access && value && value.trim() !== "") accessKeys[access[1]!] = value;
    const secret = key.match(/^STORAGE_SECRET_KEY__(.+)$/);
    if (secret && value && value.trim() !== "") secretKeys[secret[1]!] = value;
  }

  const credentials: Record<string, { accessKey: string; secretKey: string }> = {};
  for (const org of Object.keys(accessKeys)) {
    const secretKey = secretKeys[org];
    if (secretKey) credentials[org] = { accessKey: accessKeys[org]!, secretKey };
  }

  return {
    coolifyUrl: env.COOLIFY_URL,
    coolifyTokens: tokens,
    storageEndpoint: env.STORAGE_ENDPOINT,
    storageCredentials: credentials,
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

  const credentials = (organizationId: OrganizationId): CoolifyCredentials | null => {
    if (!url) return null;
    const token = tokens[organizationId];
    return token ? { baseUrl: url, token } : null;
  };
  const anyCredential = url !== undefined && Object.keys(tokens).length > 0;

  const hosting: HostingAdapter = anyCredential
    ? createCoolifyHosting({ credentials })
    : hostingNotConfigured(
        "coolify",
        "Set COOLIFY_URL and at least one COOLIFY_TOKEN__<organizationId>.",
      );

  // Tenant databases run *inside* Coolify, so they share its credentials: there
  // is no separate database engine to configure.
  const database: DatabaseAdapter = anyCredential
    ? createPostgresDatabase({ credentials })
    : databaseNotConfigured(
        "postgres",
        "Set COOLIFY_URL and at least one COOLIFY_TOKEN__<organizationId>.",
      );

  const endpoint = config.storageEndpoint?.trim();
  const storageKeys = config.storageCredentials ?? {};
  const storage: StorageAdapter =
    endpoint && Object.keys(storageKeys).length > 0
      ? createMinioStorage({
          credentials: (organizationId: OrganizationId): StorageCredentials | null => {
            const keys = storageKeys[organizationId];
            return keys ? { endpoint, accessKey: keys.accessKey, secretKey: keys.secretKey } : null;
          },
        })
      : storageNotConfigured(
          "minio",
          "Set STORAGE_ENDPOINT and per-organization STORAGE_ACCESS_KEY__<organizationId> / STORAGE_SECRET_KEY__<organizationId>.",
        );

  return {
    hosting,
    database,
    storage,
    // The security edge adapter is not written yet; say so rather than pretend.
    securityEdge: securityNotConfigured(
      "envoy",
      config.securityEdgeConfigured
        ? "The security edge adapter is not implemented in this build."
        : "Set SECURITY_EDGE_URL.",
    ),
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
