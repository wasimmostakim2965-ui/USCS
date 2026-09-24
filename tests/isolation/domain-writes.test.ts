/**
 * Phase 1b acceptance: the domain write path, end to end.
 *
 * Add, verify and remove are exercised through the router the API actually
 * mounts, over the real procedure table, with a real in-memory store that
 * applies the SQL layer's membership filter and the real domain verifier
 * adapter (a fake resolver, but the adapter's own logic).
 *
 * The properties that matter, and that a mock would hide:
 *
 *   * adding a domain issues a challenge and stores it; `verified` is not an
 *     input, and a caller cannot assert it;
 *   * verifying compares the record on the wire against the stored challenge —
 *     a name that does not answer correctly stays unverified, and the request
 *     still succeeds;
 *   * an unconfigured verifier writes nothing and is reported honestly;
 *   * a non-member cannot add, verify or remove, and cannot learn the
 *     organization exists.
 */
import { describe, expect, it } from "vitest";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Membership } from "@cloud-wai/authorization";
import type {
  ApiKeySummary,
  AuditEvent,
  AuditEventInput,
  ControlPlaneWrites,
  DataResource,
  Deployment,
  Domain,
  DomainCreateInput,
  DomainVerificationInput,
  MembershipStore,
  Organization,
  Project,
} from "@cloud-wai/database";
import type { DomainId, OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";
import {
  domainVerifierNotConfigured,
  createDnsDomainVerifier,
  hostingNotConfigured,
  databaseNotConfigured,
  storageNotConfigured,
  securityNotConfigured,
  type DnsResolver,
  type Engines,
} from "@cloud-wai/adapters";
import { buildProcedures, buildRouter, type RouterDeps } from "@cloud-wai/api";
import type { DataStore } from "@cloud-wai/database";

const ALICE = "u-alice";
const CAROL = "u-carol";
const ORG_A = "org-a" as OrganizationId;
const PROJ_A = "proj-a" as ProjectId;
const PROJ_B = "proj-b" as ProjectId;
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

/** A resolver whose answers a test controls, so verification is deterministic. */
function stubResolver(records: {
  txt?: Record<string, string[]>;
  cname?: Record<string, string[]>;
}): DnsResolver {
  return {
    async resolveTxt(hostname) {
      const values = records.txt?.[hostname];
      if (!values) {
        const error = new Error("no record") as Error & { code: string };
        error.code = "ENOTFOUND";
        throw error;
      }
      return values.map((v) => [v]);
    },
    async resolveCname(hostname) {
      const values = records.cname?.[hostname];
      if (!values) {
        const error = new Error("no record") as Error & { code: string };
        error.code = "ENOTFOUND";
        throw error;
      }
      return values;
    },
  };
}

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
    {
      id: PROJ_B,
      organizationId: ORG_A,
      name: "Beta",
      slug: "beta",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];
  const domains: Domain[] = [];
  const audit: AuditEvent[] = [];
  const deployments: Deployment[] = [];
  const dataResources: DataResource[] = [];
  const apiKeys: ApiKeySummary[] = [];

  const isMember = (userId: UserId, org: OrganizationId) =>
    memberships.some((m) => m.userId === userId && m.organizationId === org);

  const store = {
    async listOrganizations(userId: UserId) {
      return organizations.filter((o) => isMember(userId, o.id));
    },
    async createOrganization(input: { name: string; slug: string; createdBy: UserId }) {
      const org: Organization = {
        id: `org-${input.slug}` as OrganizationId,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-01T00:00:00Z",
      };
      organizations.push(org);
      memberships.push({ organizationId: org.id, userId: input.createdBy, role: "owner" });
      return org;
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
    async createProject(input: { organizationId: OrganizationId; name: string; slug: string }) {
      const p: Project = {
        id: `proj-${input.slug}` as ProjectId,
        organizationId: input.organizationId,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-01T00:00:00Z",
      };
      projects.push(p);
      return p;
    },
    async listDeployments(userId: UserId, projectId: ProjectId) {
      const p = projects.find((x) => x.id === projectId);
      return p && isMember(userId, p.organizationId)
        ? deployments.filter((d) => d.projectId === projectId)
        : [];
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
    async listDomains(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? domains.filter((d) => d.organizationId === org) : [];
    },
    async listDataResources(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? dataResources.filter((d) => d.organizationId === org) : [];
    },
    async listApiKeys(userId: UserId, org: OrganizationId) {
      return isMember(userId, org) ? apiKeys.filter((k) => k.organizationId === org) : [];
    },

    // The write half this phase is about.
    async createDomain(input: DomainCreateInput) {
      const domain: Domain = {
        id: input.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        hostname: input.hostname,
        verified: false,
        provider: null,
        providerResourceId: null,
        verificationToken: input.verificationToken,
        verifiedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      };
      domains.push(domain);
      return domain;
    },
    async getDomain(userId: UserId, domainId: DomainId) {
      const d = domains.find((x) => x.id === domainId);
      return d && isMember(userId, d.organizationId) ? d : null;
    },
    async deleteDomain(userId: UserId, org: OrganizationId, domainId: DomainId) {
      if (!isMember(userId, org)) return false;
      const index = domains.findIndex((d) => d.id === domainId && d.organizationId === org);
      if (index < 0) return false;
      domains.splice(index, 1);
      return true;
    },
    async setDomainVerification(input: DomainVerificationInput) {
      const d = domains.find((x) => x.id === input.id && x.organizationId === input.organizationId);
      if (!d) return null;
      const next: Domain = {
        ...d,
        verified: input.verified,
        provider: input.provider,
        providerResourceId: input.providerResourceId,
        verifiedAt: input.verifiedAt,
      };
      domains[domains.indexOf(d)] = next;
      return next;
    },
  } satisfies DataStore & Partial<ControlPlaneWrites>;

  return { store, domains, audit };
}

type StoreLike = DataStore & Partial<ControlPlaneWrites>;

function enginesWith(resolver: DnsResolver, edgeHostname?: string): Engines {
  return {
    hosting: hostingNotConfigured("coolify"),
    database: databaseNotConfigured("postgres"),
    storage: storageNotConfigured("minio"),
    securityEdge: securityNotConfigured("envoy"),
    // The real adapter, with a resolver a test controls.
    domainVerifier: createDnsDomainVerifier(
      edgeHostname ? { resolver, edgeHostname } : { resolver },
    ),
  };
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
  extras: { newId?: () => string; newToken?: () => string } = {},
) {
  const procedures = buildProcedures(store, {
    engines,
    newId: extras.newId ?? (() => "gen-key"),
    newToken: extras.newToken ?? (() => "cw-domain-verify=testtoken"),
  });
  return buildRouter(deps(store), procedures);
}

const KNOWN_TOKEN = "cw-domain-verify=testtoken";

describe("domains.create through the registered procedures", () => {
  it("adds an unverified domain and issues a DNS challenge", async () => {
    const { store, domains, audit } = makeStore();
    const router = routerWith(store, enginesWith(stubResolver({})));

    const res = await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, projectId: PROJ_A, hostname: "app.example.com" },
    });

    expect(res.ok).toBe(true);
    const data = res.data as {
      domain: Domain;
      recordName: string;
      recordValue: string;
      recordType: string;
    };
    // Created unverified: verified is not an accepted input, so it is false.
    expect(data.domain.verified).toBe(false);
    expect(data.domain.verifiedAt).toBeNull();
    expect(data.domain.verificationToken).toBe(KNOWN_TOKEN);
    expect(data.recordName).toBe("_cloud-wai-challenge.app.example.com");
    expect(data.recordType).toBe("TXT");
    expect(domains).toHaveLength(1);
    expect(audit.some((a) => a.event === "domain.created")).toBe(true);
  });

  it("ignores a verified flag smuggled into the request body", async () => {
    const { store, domains } = makeStore();
    const router = routerWith(store, enginesWith(stubResolver({})));

    const res = await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input: {
        organizationId: ORG_A,
        hostname: "sneaky.example.com",
        // The client claims verification; the control plane must not believe it.
        verified: true,
      },
    });

    expect(res.ok).toBe(true);
    expect(domains[0]?.verified).toBe(false);
  });

  it("rejects a hostname that is not a DNS name", async () => {
    const { store, domains } = makeStore();
    const router = routerWith(store, enginesWith(stubResolver({})));

    const res = await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, hostname: "not a hostname" },
    });

    expect(res.status).toBe(400);
    expect(domains).toHaveLength(0);
  });

  it("refuses a duplicate hostname", async () => {
    const { store, domains } = makeStore();
    const router = routerWith(store, enginesWith(stubResolver({})));
    const input = { organizationId: ORG_A, hostname: "dup.example.com" };

    await router.route({ procedure: "domains.create", accessToken: TOKEN_ALICE, input });
    const second = await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input,
    });

    expect(second.status).toBe(409);
    expect(domains).toHaveLength(1);
  });

  it("refuses a non-member without revealing the organization", async () => {
    const { store, domains } = makeStore();
    const router = routerWith(store, enginesWith(stubResolver({})));

    const res = await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A, hostname: "carol.example.com" },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(domains).toHaveLength(0);
  });
});

describe("domains.list is project-scoped", () => {
  it("shows a project's domains and organization-wide ones, never another project's", async () => {
    const { store, domains } = makeStore();
    const router = routerWith(store, enginesWith(stubResolver({})));

    // One domain on project A, one on project B, one registered organization-wide.
    await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, projectId: PROJ_A, hostname: "a.example.com" },
    });
    await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, projectId: PROJ_B, hostname: "b.example.com" },
    });
    await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, hostname: "org.example.com" },
    });
    expect(domains).toHaveLength(3);

    const forA = await router.route({
      procedure: "domains.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, projectId: PROJ_A },
    });
    expect(forA.ok).toBe(true);
    const hostnames = (forA.data as readonly Domain[]).map((d) => d.hostname).sort();
    // Project A's own domain plus the organization-wide one; not project B's.
    expect(hostnames).toEqual(["a.example.com", "org.example.com"]);

    const forB = await router.route({
      procedure: "domains.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, projectId: PROJ_B },
    });
    expect((forB.data as readonly Domain[]).map((d) => d.hostname).sort()).toEqual([
      "b.example.com",
      "org.example.com",
    ]);

    // With no project named, the whole organization is still listed.
    const organizationWide = await router.route({
      procedure: "domains.list",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A },
    });
    expect(organizationWide.data as readonly Domain[]).toHaveLength(3);
  });
});

describe("domains.verify through the registered procedures", () => {
  async function added(store: StoreLike, engines: Engines) {
    const router = routerWith(store, engines);
    const created = await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, hostname: "app.example.com" },
    });
    const domain = (created.data as { domain: Domain }).domain;
    return { router, domain };
  }

  it("confirms the domain only when the challenge record matches", async () => {
    const { store, domains, audit } = makeStore();
    // The publisher put the right token at the challenge name.
    const engines = enginesWith(
      stubResolver({ txt: { "_cloud-wai-challenge.app.example.com": [KNOWN_TOKEN] } }),
    );
    const { router, domain } = await added(store, engines);

    const res = await router.route({
      procedure: "domains.verify",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, domainId: domain.id },
    });

    expect(res.ok).toBe(true);
    const data = res.data as { domain: Domain; detail: string };
    expect(data.domain.verified).toBe(true);
    expect(data.domain.verifiedAt).not.toBeNull();
    expect(domains[0]?.verified).toBe(true);
    expect(audit.some((a) => a.event === "domain.verified")).toBe(true);
  });

  it("leaves the domain unverified when the record is wrong, without failing", async () => {
    const { store, domains } = makeStore();
    const engines = enginesWith(
      stubResolver({ txt: { "_cloud-wai-challenge.app.example.com": ["someone-elses-token"] } }),
    );
    const { router, domain } = await added(store, engines);

    const res = await router.route({
      procedure: "domains.verify",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, domainId: domain.id },
    });

    // The request is answered, not rejected: the answer is "not verified".
    expect(res.ok).toBe(true);
    expect((res.data as { domain: Domain }).domain.verified).toBe(false);
    expect(domains[0]?.verified).toBe(false);
  });

  it("reports engine_unavailable and writes nothing when the verifier is absent", async () => {
    const { store, domains } = makeStore();
    const engines: Engines = {
      hosting: hostingNotConfigured("coolify"),
      database: databaseNotConfigured("postgres"),
      storage: storageNotConfigured("minio"),
      securityEdge: securityNotConfigured("envoy"),
      domainVerifier: domainVerifierNotConfigured("dns"),
    };
    const { router, domain } = await added(store, engines);

    const res = await router.route({
      procedure: "domains.verify",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, domainId: domain.id },
    });

    expect(res.status).toBe(503);
    expect(res.error?.code).toBe("engine_unavailable");
    expect(domains[0]?.verified).toBe(false);
  });

  it("will not verify a domain in another organization", async () => {
    const { store, domains } = makeStore();
    const engines = enginesWith(
      stubResolver({ txt: { "_cloud-wai-challenge.app.example.com": [KNOWN_TOKEN] } }),
    );
    const { router, domain } = await added(store, engines);

    const res = await router.route({
      procedure: "domains.verify",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A, domainId: domain.id },
    });

    expect(res.status).toBe(404);
    expect(domains[0]?.verified).toBe(false);
  });
});

describe("domains.remove through the registered procedures", () => {
  it("removes a domain and records the removal", async () => {
    const { store, domains, audit } = makeStore();
    const router = routerWith(store, enginesWith(stubResolver({})));
    const created = await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, hostname: "gone.example.com" },
    });
    const domain = (created.data as { domain: Domain }).domain;

    const res = await router.route({
      procedure: "domains.remove",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, domainId: domain.id },
    });

    expect(res.ok).toBe(true);
    expect((res.data as { removed: boolean }).removed).toBe(true);
    expect(domains).toHaveLength(0);
    expect(audit.some((a) => a.event === "domain.removed")).toBe(true);
  });

  it("reports not_found rather than a false success for an absent domain", async () => {
    const { store } = makeStore();
    const router = routerWith(store, enginesWith(stubResolver({})));

    const res = await router.route({
      procedure: "domains.remove",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, domainId: "d-missing" as DomainId },
    });

    expect(res.status).toBe(404);
  });

  it("refuses a non-member", async () => {
    const { store, domains } = makeStore();
    const router = routerWith(store, enginesWith(stubResolver({})));
    const created = await router.route({
      procedure: "domains.create",
      accessToken: TOKEN_ALICE,
      input: { organizationId: ORG_A, hostname: "keep.example.com" },
    });
    const domain = (created.data as { domain: Domain }).domain;

    const res = await router.route({
      procedure: "domains.remove",
      accessToken: TOKEN_CAROL,
      input: { organizationId: ORG_A, domainId: domain.id },
    });

    expect(res.status).toBe(404);
    expect(domains).toHaveLength(1);
  });
});
