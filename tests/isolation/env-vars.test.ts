/**
 * Phase 4: project environment variables, end to end.
 *
 * Set, list and remove are exercised through the router the API actually
 * mounts, over the real procedure table, with a real in-memory store that
 * applies the SQL layer's membership filter, the real `SecretCipher`, and the
 * real hosting adapter's own application handles.
 *
 * The properties that matter, and that a mock would hide:
 *
 *   * a value is encrypted before it reaches the store, and a list returns a
 *     fingerprint, never the value;
 *   * no encryption key means `engine_unavailable`, never a stored plaintext;
 *   * a variable is stored even when the engine has no application yet, and the
 *     answer says `stored` rather than claiming it was applied;
 *   * the engine write resolves the application by the handle the deploy stored,
 *     so it lands on the same application a deploy would;
 *   * a non-member cannot set, list or remove, and cannot learn the project
 *     exists;
 *   * removing deletes the engine's copy before the row, so a refused engine
 *     deletion keeps the variable visible.
 */
import { describe, expect, it } from "vitest";
import {
  createSecretCipher,
  valueFingerprint,
  type SecretCipher,
  type SessionVerifier,
  type SupabaseSession,
} from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  AuditEvent,
  AuditEventInput,
  ControlPlaneWrites,
  DataStore,
  EnvVarSaveInput,
  MembershipStore,
  Organization,
  Project,
  ProjectEnvironment,
  ProjectEnvVar,
  ProjectEnvVarSecret,
} from "@cloud-wai/database";
import type {
  AdapterContext,
  EnvironmentId,
  OrganizationId,
  ProjectId,
  ProviderRef,
  UserId,
} from "@cloud-wai/contracts";
import {
  databaseNotConfigured,
  domainVerifierNotConfigured,
  fakeHosting,
  hostingNotConfigured,
  securityNotConfigured,
  serverlessNotConfigured,
  storageNotConfigured,
  type Engines,
} from "@cloud-wai/adapters";
import { buildProcedures, buildRouter, type RouterDeps } from "@cloud-wai/api";

const ALICE = "u-alice";
const CAROL = "u-carol";
const ORG_A = "org-a" as OrganizationId;
const PROJ_A = "proj-a" as ProjectId;
const ENV_PROD = "env-prod" as EnvironmentId;
const ENV_PREVIEW = "env-preview" as EnvironmentId;
const TOKEN_ALICE = "t-alice";
const TOKEN_CAROL = "t-carol";

const sessions: Record<string, SupabaseSession> = {
  [TOKEN_ALICE]: {
    userId: ALICE,
    email: "alice@example.com",
    displayName: "Alice",
    accessToken: TOKEN_ALICE,
  },
  [TOKEN_CAROL]: {
    userId: CAROL,
    email: "carol@example.com",
    displayName: "Carol",
    accessToken: TOKEN_CAROL,
  },
};

const verifier: SessionVerifier = {
  async verify(token) {
    return sessions[token] ?? null;
  },
};

const memberships: Membership[] = [{ organizationId: ORG_A, userId: ALICE, role: "owner" }];
const membershipStore: MembershipStore = {
  async membershipsFor(userId) {
    return memberships.filter((m) => m.userId === userId);
  },
};

/** A fixed key so a test can prove the cipher ran and decrypt what it stored. */
const CIPHER: SecretCipher = createSecretCipher(Buffer.alloc(32, 7).toString("base64"))!;

function makeStore() {
  const organizations: Organization[] = [
    { id: ORG_A, name: "A", slug: "a", createdAt: "2026-01-01T00:00:00Z" },
  ];
  const projects: Project[] = [
    {
      id: PROJ_A,
      organizationId: ORG_A,
      name: "Alpha",
      slug: "alpha",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const envVars: ProjectEnvVar[] = [];
  // The two platform environments every project has (`0024`). The store models
  // them for real, because the procedures resolve an environment by membership
  // and a variable is scoped to one: a test that skipped this would not exercise
  // the environment resolution at all.
  const environments: ProjectEnvironment[] = [
    {
      id: ENV_PROD,
      organizationId: ORG_A,
      projectId: PROJ_A,
      name: "Production",
      kind: "production",
      isDefault: true,
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      id: ENV_PREVIEW,
      organizationId: ORG_A,
      projectId: PROJ_A,
      name: "Preview",
      kind: "preview",
      isDefault: false,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const encrypted = new Map<string, string>();
  const engineRefs = new Map<string, string>();
  const audit: AuditEvent[] = [];
  // The engine-side handle the project's application was recorded under. A test
  // sets this from what the *real* hosting adapter returned when it created the
  // application, so an env write resolves the same application a deploy would —
  // never a handle the engine does not know.
  const target: { providerResourceId: string | null } = { providerResourceId: null };

  const isMember = (userId: UserId, org: OrganizationId) =>
    memberships.some((m) => m.userId === userId && m.organizationId === org);

  const toEnvVar = (input: EnvVarSaveInput): ProjectEnvVar => ({
    id: input.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    key: input.key,
    valuePrefix: input.valuePrefix,
    isBuildTime: input.isBuildTime,
    updatedBy: input.updatedBy,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const refKey = (
    org: OrganizationId,
    project: ProjectId,
    environment: EnvironmentId,
    key: string,
  ) => `${org}|${project}|${environment}|${key}`;

  const store = {
    async listOrganizations(userId: UserId) {
      return organizations.filter((o) => isMember(userId, o.id));
    },
    async getOrganization(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? (organizations.find((o) => o.id === org) ?? null) : null;
    },
    async listProjects(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? projects.filter((p) => p.organizationId === org) : [];
    },
    async getProject(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId) ? p : null;
    },
    async listAuditEvents(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? audit.filter((a) => a.organizationId === org) : [];
    },
    async recordAuditEvent(input: AuditEventInput) {
      const e: AuditEvent = {
        ...input,
        id: `a-${audit.length + 1}`,
        createdAt: "2026-01-01T00:00:00Z",
      };
      audit.push(e);
      return e;
    },

    // The read half this phase is about.
    async listEnvVars(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      if (!p || !isMember(userId, p.organizationId)) return [];
      return envVars.filter((v) => v.projectId === projectId);
    },

    // The write half.
    async saveEnvVar(input: EnvVarSaveInput) {
      const existing = envVars.find(
        (v) =>
          v.organizationId === input.organizationId &&
          v.projectId === input.projectId &&
          v.environmentId === input.environmentId &&
          v.key === input.key,
      );
      const next = toEnvVar(input);
      if (existing) envVars[envVars.indexOf(existing)] = next;
      else envVars.push(next);
      encrypted.set(
        refKey(input.organizationId, input.projectId, input.environmentId, input.key),
        input.valueEncrypted,
      );
      return next;
    },
    async listEnvVarsForService(
      org: OrganizationId,
      projectId: ProjectId,
      environmentId: EnvironmentId,
    ): Promise<readonly ProjectEnvVarSecret[]> {
      return envVars
        .filter(
          (v) =>
            v.organizationId === org &&
            v.projectId === projectId &&
            v.environmentId === environmentId,
        )
        .map((v) => ({
          ...v,
          valueEncrypted:
            encrypted.get(refKey(v.organizationId, v.projectId, v.environmentId, v.key)) ?? "",
        }));
    },
    async setEnvVarEngineRef(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      environmentId: EnvironmentId;
      key: string;
      engineRef: string;
    }) {
      engineRefs.set(
        refKey(input.organizationId, input.projectId, input.environmentId, input.key),
        input.engineRef,
      );
      return (
        envVars.find(
          (v) =>
            v.projectId === input.projectId &&
            v.environmentId === input.environmentId &&
            v.key === input.key,
        ) ?? null
      );
    },
    async getEnvVarEngineRef(
      _userId: UserId,
      org: OrganizationId,
      project: ProjectId,
      environmentId: EnvironmentId,
      key: string,
    ) {
      return engineRefs.get(refKey(org, project, environmentId, key)) ?? null;
    },
    async deleteEnvVar(
      _userId: UserId,
      org: OrganizationId,
      project: ProjectId,
      environmentId: EnvironmentId,
      key: string,
    ) {
      const index = envVars.findIndex(
        (v) =>
          v.organizationId === org &&
          v.projectId === project &&
          v.environmentId === environmentId &&
          v.key === key,
      );
      if (index < 0) return false;
      envVars.splice(index, 1);
      engineRefs.delete(refKey(org, project, environmentId, key));
      encrypted.delete(refKey(org, project, environmentId, key));
      return true;
    },
    async listEnvironments(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      if (!p || !isMember(userId, p.organizationId)) return [];
      return environments.filter((environment) => environment.projectId === projectId);
    },
    async getEnvironment(userId: UserId, projectId: ProjectId, environmentId: EnvironmentId) {
      const p = projects.find((x) => x.id === projectId);
      if (!p || !isMember(userId, p.organizationId)) return null;
      return (
        environments.find(
          (environment) => environment.projectId === projectId && environment.id === environmentId,
        ) ?? null
      );
    },
    async listEnvironmentsForService(org: OrganizationId, projectId: ProjectId) {
      return environments.filter(
        (environment) => environment.organizationId === org && environment.projectId === projectId,
      );
    },
    async getProjectDeploymentTarget() {
      return target.providerResourceId
        ? { provider: "coolify" as const, providerResourceId: target.providerResourceId }
        : { provider: null, providerResourceId: null };
    },
  } satisfies DataStore & Partial<ControlPlaneWrites>;

  return { store, envVars, environments, engineRefs, encrypted, audit, target };
}

type StoreLike = DataStore & Partial<ControlPlaneWrites>;

function enginesWith(hosting: Engines["hosting"]): Engines {
  return {
    hosting,
    serverless: serverlessNotConfigured("lambda"),
    database: databaseNotConfigured("postgres"),
    storage: storageNotConfigured("minio"),
    securityEdge: securityNotConfigured("envoy"),
    domainVerifier: domainVerifierNotConfigured("dns"),
  };
}

/**
 * A hosting engine with a real application behind the project.
 *
 * The application is created through the fake hosting adapter's own
 * `createApplication` — the same call a deploy makes — and the handle it returns
 * is what the store records as the project's target. An env write then has to
 * resolve that exact handle, the way Coolify addresses an application by its
 * uuid; a write against a handle the engine never issued would 404.
 */
async function provisionedHosting(org: OrganizationId): Promise<{
  hosting: Engines["hosting"];
  resourceId: string;
}> {
  const hosting = fakeHosting();
  const created = await hosting.createApplication(
    { organizationId: org, idempotencyKey: "provision-1", timeoutMs: 100 } satisfies AdapterContext,
    { name: "alpha" },
  );
  if (!created.ok) throw new Error("the fake engine refused to create the application");
  return { hosting, resourceId: created.value.providerRef.resourceId };
}

/** A store with a working engine behind its project, ready for env writes. */
async function provisioned() {
  const made = makeStore();
  const { hosting, resourceId } = await provisionedHosting(ORG_A);
  made.target.providerResourceId = resourceId;
  return { ...made, hosting };
}

function deps(store: StoreLike): RouterDeps {
  return {
    verifier,
    memberships: membershipStore,
    store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

function routerWith(
  store: StoreLike,
  engines: Engines,
  extras: { cipher?: SecretCipher | null; newId?: () => string } = {},
) {
  const procedures = buildProcedures(store, {
    engines,
    newId: extras.newId ?? (() => "env-1"),
    secretCipher: extras.cipher === undefined ? CIPHER : extras.cipher,
  });
  return buildRouter(deps(store), procedures);
}

const set = (
  router: ReturnType<typeof routerWith>,
  input: Record<string, unknown>,
  token = TOKEN_ALICE,
) => router.route({ procedure: "env.set", accessToken: token, input });

describe("env.set through the registered procedures", () => {
  it("stores an encrypted value, applies it to the engine, and never returns the plaintext", async () => {
    const { store, envVars, encrypted, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    const res = await set(router, {
      projectId: PROJ_A,
      key: "database_url",
      value: "postgres://secret",
    });

    expect(res.ok).toBe(true);
    const data = res.data as {
      variable: ProjectEnvVar;
      applied: string;
      redeployRequired: boolean;
    };
    // The key is normalised and the value never appears in the response.
    expect(data.variable.key).toBe("DATABASE_URL");
    expect(JSON.stringify(data)).not.toContain("postgres://secret");
    expect(envVars).toHaveLength(1);
    expect(data.applied).toBe("engine");
    expect(data.redeployRequired).toBe(true);
    // The stored ciphertext is genuinely encrypted: it decrypts back to the value.
    const ciphertext = encrypted.get(`${ORG_A}|${PROJ_A}|${ENV_PROD}|DATABASE_URL`)!;
    expect(ciphertext).not.toContain("postgres://secret");
    expect(CIPHER.decrypt(ciphertext)).toBe("postgres://secret");
    expect(data.variable.valuePrefix).toBe(valueFingerprint("postgres://secret"));
  });

  it("normalises the key to the engine's shape", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    await set(router, { projectId: PROJ_A, key: "  api_key  ", value: "x" });

    expect(envVars[0]!.key).toBe("API_KEY");
  });

  it("refuses an invalid key and a value beyond the size bound", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    const badKey = await set(router, { projectId: PROJ_A, key: "1leading", value: "x" });
    expect(badKey.ok).toBe(false);
    expect(badKey.error?.code).toBe("invalid_input");

    const bigValue = await set(router, { projectId: PROJ_A, key: "OK", value: "x".repeat(70_000) });
    expect(bigValue.ok).toBe(false);
    expect(bigValue.error?.code).toBe("invalid_input");
    expect(envVars).toHaveLength(0);
  });

  it("answers engine_unavailable with no encryption key rather than storing plaintext", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting), { cipher: null });

    const res = await set(router, { projectId: PROJ_A, key: "OK", value: "secret" });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("engine_unavailable");
    expect(envVars).toHaveLength(0);
  });

  it("stores the variable when the project has no application yet, reporting stored", async () => {
    const made = makeStore();
    const router = routerWith(made.store, enginesWith(fakeHosting()));

    const res = await set(router, { projectId: PROJ_A, key: "OK", value: "secret" });

    expect(res.ok).toBe(true);
    const data = res.data as { applied: string; engineReason: string | null };
    expect(data.applied).toBe("stored");
    expect(data.engineReason).toMatch(/no application/i);
    // Never lost: it is saved and reconciliation pushes it on the next deploy.
    expect(made.envVars).toHaveLength(1);
  });

  it("stores the variable and reports not_configured when the engine is unreachable", async () => {
    const made = makeStore();
    // The project has a stored handle, but this deployment has no engine creds.
    made.target.providerResourceId = "app-1";
    const router = routerWith(made.store, enginesWith(hostingNotConfigured("coolify")));

    const res = await set(router, { projectId: PROJ_A, key: "OK", value: "secret" });

    expect(res.ok).toBe(true);
    const data = res.data as { applied: string; engineReason: string | null };
    expect(data.applied).toBe("stored");
    expect(data.engineReason).toMatch(/not configured/i);
    expect(made.envVars).toHaveLength(1);
  });

  it("refuses a caller with no membership and does not learn the project exists", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    const res = await set(router, { projectId: PROJ_A, key: "OK", value: "secret" }, TOKEN_CAROL);

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_found");
    expect(envVars).toHaveLength(0);
  });

  it("does not write the value into the audit trail", async () => {
    const { store, audit, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    await set(router, { projectId: PROJ_A, key: "TOKEN", value: "hunter2" });

    expect(audit.some((a) => a.event === "env.set")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("hunter2");
  });
});

describe("env.list through the registered procedures", () => {
  it("names keys and fingerprints, never values", async () => {
    const { store, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));
    await set(router, { projectId: PROJ_A, key: "SECRET", value: "top-secret" });

    const res = await router.route({
      procedure: "env.list",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A },
    });

    expect(res.ok).toBe(true);
    const rows = res.data as readonly ProjectEnvVar[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("SECRET");
    expect(rows[0]!.valuePrefix).toBe(valueFingerprint("top-secret"));
    expect(JSON.stringify(rows)).not.toContain("top-secret");
  });

  it("refuses a non-member rather than leaking the project's variables", async () => {
    const { store, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));
    await set(router, { projectId: PROJ_A, key: "SECRET", value: "x" });

    const res = await router.route({
      procedure: "env.list",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A },
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_found");
  });
});

describe("env.remove through the registered procedures", () => {
  it("removes the row and reports it", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));
    await set(router, { projectId: PROJ_A, key: "OK", value: "x" });

    const res = await router.route({
      procedure: "env.remove",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, key: "OK" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { removed: boolean; engineReason: string | null };
    expect(data.removed).toBe(true);
    expect(envVars).toHaveLength(0);
  });

  it("keeps the row when the engine refuses the delete, so it can be retried", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));
    await set(router, { projectId: PROJ_A, key: "OK", value: "x" });
    // The application was recorded on the store, so the removal calls the engine;
    // this router's engine refuses every operation, modelling an unreachable
    // engine at removal time. The row must survive so the customer can retry.
    const failing = routerWith(store, enginesWith(fakeHosting({ behaviour: "failed" })));

    const res = await failing.route({
      procedure: "env.remove",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, key: "OK" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { removed: boolean; engineReason: string | null };
    expect(data.removed).toBe(false);
    expect(data.engineReason).toMatch(/refused/i);
    expect(envVars).toHaveLength(1);
  });

  it("treats removing an absent variable as already gone", async () => {
    const { store, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    const res = await router.route({
      procedure: "env.remove",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, key: "MISSING" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { removed: boolean };
    expect(data.removed).toBe(false);
  });

  it("refuses a caller with no membership", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));
    await set(router, { projectId: PROJ_A, key: "OK", value: "x" });

    const res = await router.route({
      procedure: "env.remove",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A, key: "OK" },
    });

    expect(res.ok).toBe(false);
    expect(envVars).toHaveLength(1);
  });
});

describe("the engine resolves an application by the deploy's resourceId", () => {
  it("finds the application the deploy created and no other handle", async () => {
    const { hosting, resourceId } = await provisionedHosting(ORG_A);
    const ctx: AdapterContext = {
      organizationId: ORG_A,
      idempotencyKey: "anything",
      timeoutMs: 100,
    };
    const known = await hosting.listEnvVars(ctx, {
      organizationId: ORG_A,
      provider: "coolify",
      resourceType: "application",
      resourceId,
    });
    expect(known.ok).toBe(true);

    const unknown = await hosting.listEnvVars(ctx, {
      organizationId: ORG_A,
      provider: "coolify",
      resourceType: "application",
      resourceId: "app-that-does-not-exist",
    } satisfies ProviderRef);
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.value).toHaveLength(0);
  });
});

describe("variables are scoped per environment (P13 / audit D5)", () => {
  it("stores the same key twice, once per environment, with different values", async () => {
    const { store, envVars, encrypted, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    const prod = await set(router, {
      projectId: PROJ_A,
      key: "DATABASE_URL",
      value: "postgres://prod",
      environmentId: ENV_PROD,
    });
    const preview = await set(router, {
      projectId: PROJ_A,
      key: "DATABASE_URL",
      value: "postgres://preview",
      environmentId: ENV_PREVIEW,
    });

    expect(prod.ok).toBe(true);
    expect(preview.ok).toBe(true);
    // Two rows, one per environment — not one row overwritten.
    expect(envVars).toHaveLength(2);
    expect(envVars.map((v) => v.environmentId).sort()).toEqual([ENV_PROD, ENV_PREVIEW].sort());
    // Each environment keeps its own ciphertext, so neither value leaked across.
    expect(CIPHER.decrypt(encrypted.get(`${ORG_A}|${PROJ_A}|${ENV_PROD}|DATABASE_URL`)!)).toBe(
      "postgres://prod",
    );
    expect(CIPHER.decrypt(encrypted.get(`${ORG_A}|${PROJ_A}|${ENV_PREVIEW}|DATABASE_URL`)!)).toBe(
      "postgres://preview",
    );
  });

  it("lists only the named environment's variables when one is given", async () => {
    const { store, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));
    await set(router, { projectId: PROJ_A, key: "PROD_ONLY", value: "1", environmentId: ENV_PROD });
    await set(router, {
      projectId: PROJ_A,
      key: "PREVIEW_ONLY",
      value: "2",
      environmentId: ENV_PREVIEW,
    });

    const scoped = await router.route({
      procedure: "env.list",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, environmentId: ENV_PREVIEW },
    });

    expect(scoped.ok).toBe(true);
    const rows = scoped.data as readonly ProjectEnvVar[];
    expect(rows.map((row) => row.key)).toEqual(["PREVIEW_ONLY"]);

    // The unscoped list still names both, which is what a grouped page wants.
    const all = await router.route({
      procedure: "env.list",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A },
    });
    expect((all.data as readonly ProjectEnvVar[]).map((row) => row.key).sort()).toEqual([
      "PREVIEW_ONLY",
      "PROD_ONLY",
    ]);
  });

  it("defaults to Production when no environment is named", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    await set(router, { projectId: PROJ_A, key: "OK", value: "x" });

    expect(envVars).toHaveLength(1);
    expect(envVars[0]!.environmentId).toBe(ENV_PROD);
  });

  it("refuses an environment that belongs to no project the caller can see", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    const res = await set(router, {
      projectId: PROJ_A,
      key: "OK",
      value: "x",
      environmentId: "env-from-another-tenant" as EnvironmentId,
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_found");
    expect(envVars).toHaveLength(0);
  });

  it("removes only the named environment's copy, leaving the other", async () => {
    const { store, envVars, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));
    await set(router, { projectId: PROJ_A, key: "SHARED", value: "prod", environmentId: ENV_PROD });
    await set(router, {
      projectId: PROJ_A,
      key: "SHARED",
      value: "preview",
      environmentId: ENV_PREVIEW,
    });

    const res = await router.route({
      procedure: "env.remove",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A, key: "SHARED", environmentId: ENV_PREVIEW },
    });

    expect(res.ok).toBe(true);
    expect((res.data as { removed: boolean }).removed).toBe(true);
    expect(envVars).toHaveLength(1);
    expect(envVars[0]!.environmentId).toBe(ENV_PROD);
  });
});

describe("environments.list through the registered procedures", () => {
  it("returns the project's environments, production first", async () => {
    const { store, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    const res = await router.route({
      procedure: "environments.list",
      accessToken: TOKEN_ALICE,
      input: { projectId: PROJ_A },
    });

    expect(res.ok).toBe(true);
    const rows = res.data as readonly ProjectEnvironment[];
    expect(rows.map((row) => row.kind)).toEqual(["production", "preview"]);
    expect(rows[0]!.isDefault).toBe(true);
  });

  it("refuses a non-member rather than revealing the project exists", async () => {
    const { store, hosting } = await provisioned();
    const router = routerWith(store, enginesWith(hosting));

    const res = await router.route({
      procedure: "environments.list",
      accessToken: TOKEN_CAROL,
      input: { projectId: PROJ_A },
    });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("not_found");
  });
});
