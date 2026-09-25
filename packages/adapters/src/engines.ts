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
  fakeDomainVerifier,
  fakeHosting,
  fakeServerless,
  hostingNotConfigured,
  securityNotConfigured,
  serverlessNotConfigured,
  storageNotConfigured,
  createCoolifyHosting,
  createDnsDomainVerifier,
  createEnvoySecurityEdge,
  createLambdaServerless,
  createPostgresDatabase,
  createMinioStorage,
  type CompileInput,
  type CoolifyCredentials,
  type DatabaseAdapter,
  type DomainVerifier,
  type EdgeRoute,
  type HostingAdapter,
  type LambdaCredentials,
  type SecurityEdgeAdapter,
  type ServerlessAdapter,
  type NotConfiguredBrand,
  type StorageAdapter,
  type StorageCredentials,
} from "./index.js";
import type { OrganizationId, ProviderRef } from "@cloud-wai/contracts";

export interface EngineConfig {
  /** Base URL for the Coolify API, or absent when hosting is not configured. */
  readonly coolifyUrl?: string | undefined;
  /** Per-organization Coolify tokens, keyed by organization id. */
  readonly coolifyTokens?: Readonly<Record<string, string>> | undefined;
  /**
   * Per-organization Coolify project/server/environment UUIDs. Coolify requires
   * these to create an application, so a token without them is not a usable
   * hosting configuration.
   */
  readonly coolifyInfra?:
    | Readonly<
        Record<
          string,
          {
            projectUuid?: string | undefined;
            serverUuid?: string | undefined;
            environmentName?: string | undefined;
            environmentUuid?: string | undefined;
            destinationUuid?: string | undefined;
          }
        >
      >
    | undefined;
  /** S3-compatible endpoint for tenant object storage. */
  readonly storageEndpoint?: string | undefined;
  /**
   * Per-organization AWS credentials for serverless execution, keyed by
   * organization id. Absent means the `not_configured` serverless engine is
   * wired, so a project whose provider is `lambda` reports an honest
   * not-configured state instead of falling through to the container engine.
   */
  readonly serverlessCredentials?: Readonly<Record<string, LambdaCredentials>> | undefined;
  /** Per-organization storage credentials, keyed by organization id. */
  readonly storageCredentials?:
    Readonly<Record<string, { accessKey: string; secretKey: string }>> | undefined;
  /**
   * A pre-built security edge adapter, when this deployment can supply one.
   *
   * The real edge adapter resolves a route's host/origin and a policy's level
   * from the control plane, so it cannot be constructed inside this package
   * without a resolver the API owns. Injecting the built adapter is the seam:
   * absent means the honest `not_configured` edge, present means the real one.
   */
  readonly securityEdge?: SecurityEdgeAdapter | undefined;
  /** The security edge (Envoy) is not wired yet; it stays honestly unconfigured. */
  readonly securityEdgeConfigured?: boolean | undefined;
  /**
   * The edge host a domain may CNAME to. Absent means a hostname can only be
   * verified by a TXT challenge, not by a CNAME the deployment cannot inspect.
   */
  readonly edgeHostname?: string | undefined;
  /** Use in-memory engines. Only for tests and local development. */
  readonly useFakes?: boolean | undefined;
  /**
   * The deployment's runtime environment, read from `NODE_ENV`.
   *
   * Used only to refuse the fakes in a production process: a deployment that
   * set `CLOUD_WAI_USE_FAKE_ENGINES=true` there by mistake would otherwise
   * report success for work no engine performed.
   */
  readonly nodeEnv?: string | undefined;
}

export interface Engines {
  readonly hosting: HostingAdapter;
  /**
   * The serverless execution engine, when this deployment has AWS credentials.
   *
   * Its own slot rather than a fallback of `hosting`: a project chooses its
   * execution model, and a serverless project must never be handed to the
   * container engine (or the reverse) by an unconfigured credential.
   */
  readonly serverless: ServerlessAdapter;
  readonly database: DatabaseAdapter;
  readonly storage: StorageAdapter;
  readonly securityEdge: SecurityEdgeAdapter;
  /**
   * Confirms a hostname points at this deployment. Not an "engine" in the
   * billing sense, but it belongs here: it is a capability that is either wired
   * with real configuration or honestly absent, the same as the others.
   */
  readonly domainVerifier: DomainVerifier;
}

/** Read engine configuration from an environment-style record. */
export function engineConfigFromEnv(env: Record<string, string | undefined>): EngineConfig {
  const tokens: Record<string, string> = {};
  // Tokens are per organization: COOLIFY_TOKEN__<orgId>=<token>.
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^COOLIFY_TOKEN__(.+)$/);
    if (match && value && value.trim() !== "") tokens[match[1]!] = value;
  }

  // Project/server/environment are per organization too. They are what makes a
  // token usable: Coolify rejects a create without them.
  const infra: Record<
    string,
    {
      projectUuid?: string;
      serverUuid?: string;
      environmentName?: string;
      environmentUuid?: string;
      destinationUuid?: string;
    }
  > = {};
  const infraFields = {
    COOLIFY_PROJECT_UUID__: "projectUuid",
    COOLIFY_SERVER_UUID__: "serverUuid",
    COOLIFY_ENVIRONMENT_NAME__: "environmentName",
    COOLIFY_ENVIRONMENT_UUID__: "environmentUuid",
    COOLIFY_DESTINATION_UUID__: "destinationUuid",
  } as const;
  for (const [key, value] of Object.entries(env)) {
    for (const [prefix, field] of Object.entries(infraFields)) {
      if (key.startsWith(prefix) && value && value.trim() !== "") {
        const org = key.slice(prefix.length);
        infra[org] = { ...infra[org], [field]: value };
      }
    }
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

  // Per-organization AWS credentials for the serverless engine. The region is
  // required: it is part of the SigV4 scope, so a key without one cannot sign.
  const awsAccessKeys: Record<string, string> = {};
  const awsSecretKeys: Record<string, string> = {};
  const awsRegions: Record<string, string> = {};
  const awsRoles: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.trim() === "") continue;
    const access = key.match(/^AWS_ACCESS_KEY_ID__(.+)$/);
    if (access) awsAccessKeys[access[1]!] = value;
    const secret = key.match(/^AWS_SECRET_ACCESS_KEY__(.+)$/);
    if (secret) awsSecretKeys[secret[1]!] = value;
    const region = key.match(/^AWS_REGION__(.+)$/);
    if (region) awsRegions[region[1]!] = value;
    const role = key.match(/^AWS_LAMBDA_ROLE_ARN__(.+)$/);
    if (role) awsRoles[role[1]!] = value;
  }
  const serverlessCredentials: Record<string, LambdaCredentials> = {};
  for (const org of Object.keys(awsAccessKeys)) {
    const secretAccessKey = awsSecretKeys[org];
    const region = awsRegions[org];
    if (secretAccessKey && region) {
      serverlessCredentials[org] = {
        accessKeyId: awsAccessKeys[org]!,
        secretAccessKey,
        region,
        ...(awsRoles[org] ? { executionRoleArn: awsRoles[org]! } : {}),
      };
    }
  }

  return {
    coolifyUrl: env.COOLIFY_URL,
    coolifyTokens: tokens,
    coolifyInfra: infra,
    storageEndpoint: env.STORAGE_ENDPOINT,
    storageCredentials: credentials,
    serverlessCredentials,
    securityEdgeConfigured: Boolean(env.SECURITY_EDGE_URL),
    edgeHostname: env.EDGE_HOSTNAME,
    useFakes: env.CLOUD_WAI_USE_FAKE_ENGINES === "true",
    nodeEnv: env.NODE_ENV,
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
    // The fakes report success for work that never ran, which is exactly what a
    // production deployment must not do. Refuse rather than trust that the flag
    // was set deliberately; a test sets NODE_ENV=test and is unaffected.
    if (config.nodeEnv === "production") {
      throw new Error(
        "CLOUD_WAI_USE_FAKE_ENGINES is set in a production process. Fakes would fabricate " +
          "engine success; refusing to build them. Unset it or set NODE_ENV to test/development.",
      );
    }
    return {
      hosting: fakeHosting(),
      serverless: fakeServerless(),
      database: fakeDatabase(),
      storage: storageNotConfigured("minio"),
      securityEdge: securityNotConfigured("envoy"),
      // A deterministic lookup: unverified by default, so a test cannot pass a
      // check production would fail.
      domainVerifier: fakeDomainVerifier(),
    };
  }

  const url = config.coolifyUrl?.trim();
  const tokens = config.coolifyTokens ?? {};
  const infra = config.coolifyInfra ?? {};

  const credentials = (organizationId: OrganizationId): CoolifyCredentials | null => {
    if (!url) return null;
    const token = tokens[organizationId];
    if (!token) return null;
    const forOrg = infra[organizationId];
    return {
      baseUrl: url,
      token,
      ...(forOrg?.projectUuid ? { projectUuid: forOrg.projectUuid } : {}),
      ...(forOrg?.serverUuid ? { serverUuid: forOrg.serverUuid } : {}),
      ...(forOrg?.environmentName ? { environmentName: forOrg.environmentName } : {}),
      ...(forOrg?.environmentUuid ? { environmentUuid: forOrg.environmentUuid } : {}),
      ...(forOrg?.destinationUuid ? { destinationUuid: forOrg.destinationUuid } : {}),
    };
  };
  const anyCredential = url !== undefined && Object.keys(tokens).length > 0;

  const hosting: HostingAdapter = anyCredential
    ? createCoolifyHosting({ credentials })
    : hostingNotConfigured(
        "coolify",
        "Set COOLIFY_URL and at least one COOLIFY_TOKEN__<organizationId>.",
      );

  // The serverless engine is configured independently of Coolify: a deployment
  // can offer serverless execution without a container engine, or the reverse.
  // Absent AWS credentials, the honest `not_configured` engine is wired so a
  // `lambda` project reports that state rather than silently containerising.
  const awsCredentials = config.serverlessCredentials ?? {};
  const serverless: ServerlessAdapter =
    Object.keys(awsCredentials).length > 0
      ? createLambdaServerless({
          credentials: (organizationId: OrganizationId) =>
            awsCredentials[organizationId] ?? null,
        })
      : serverlessNotConfigured(
          "lambda",
          "Set AWS_ACCESS_KEY_ID__<organizationId>, AWS_SECRET_ACCESS_KEY__<organizationId> and AWS_REGION__<organizationId>.",
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
    serverless,
    database,
    storage,
    // A caller that built a real edge adapter supplies it; otherwise the honest
    // `not_configured` edge is wired. An injected adapter is used as given — it
    // already knows how to refuse, and a fake would only be reachable if a caller
    // deliberately passed one.
    securityEdge:
      config.securityEdge ??
      securityNotConfigured(
        "envoy",
        config.securityEdgeConfigured
          ? "An edge URL is set but no edge adapter was supplied to buildEngines."
          : "Set SECURITY_EDGE_URL and supply a security edge adapter.",
      ),
    // Verification needs only a resolver, so a real deployment always has one.
    // The edge host is optional: without it, only the TXT challenge verifies.
    domainVerifier: createDnsDomainVerifier(
      config.edgeHostname ? { edgeHostname: config.edgeHostname } : {},
    ),
  };
}

/**
 * Build a real security edge adapter for a deployment.
 *
 * This is what makes the edge reachable outside tests. The API calls it at
 * startup with the control plane's own readers; the adapter then compiles the
 * *stored* policy — including its protection mode and deny list — and the
 * *stored* route for a hostname, so the compiled ladder is the customer's real
 * configuration, not a guess.
 *
 * The lookups are injected rather than imported so `packages/adapters` keeps its
 * rule: it never reaches into the control plane itself.
 */
export function createControlPlaneSecurityEdge(options: {
  readonly edgeUrl: string;
  readonly tokenFor: (organizationId: OrganizationId) => string | null;
  /** The stored route for a hostname, or null when the host is not registered. */
  readonly loadRoute: (ref: ProviderRef) => Promise<EdgeRoute | null>;
  /** The stored policy compiled with its mode and deny list, or null. */
  readonly loadPolicy: (ref: ProviderRef) => Promise<CompileInput | null>;
  readonly fetchImpl?: typeof fetch | undefined;
}): SecurityEdgeAdapter {
  const adminUrl = options.edgeUrl.trim();
  return createEnvoySecurityEdge({
    credentials: (organizationId) => {
      const token = options.tokenFor(organizationId);
      if (!adminUrl || !token || token.trim() === "") return null;
      return { adminUrl, token };
    },
    loadRoute: options.loadRoute,
    loadPolicy: options.loadPolicy,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
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
    { engine: "lambda", configured: isConfigured(engines.serverless) },
    { engine: "postgres", configured: isConfigured(engines.database) },
    { engine: "minio", configured: isConfigured(engines.storage) },
    { engine: "envoy", configured: isConfigured(engines.securityEdge) },
    { engine: "dns", configured: isConfigured(engines.domainVerifier) },
  ];
}
