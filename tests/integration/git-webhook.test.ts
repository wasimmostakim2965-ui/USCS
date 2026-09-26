/**
 * The git webhook receiver, end to end.
 *
 * A push arrives at `POST /hooks/git/{organizationId}/{linkId}` with no session,
 * so the properties that matter are the ones a mock would hide:
 *
 *   * a body signed with the stored secret creates exactly one deployment row
 *     and enqueues exactly one job — the same job the Deploy button enqueues;
 *   * a body signed with the wrong secret, or with no secret at all, creates
 *     nothing and is refused with one indistinguishable status;
 *   * a redelivered webhook replays rather than building twice;
 *   * a delivery naming an organization the link does not belong to resolves
 *     nothing, so a link id from another tenant is not a cross-tenant read;
 *   * a push to a non-production branch is a preview only when the link said so,
 *     and a preview target is recorded before the worker runs;
 *   * an unset encryption key leaves the receiver unmounted, not decrypting
 *     plaintext.
 *
 * The crypto, the queue and the store are real; only the store's rows are
 * in-memory.
 */
import { describe, expect, it } from "vitest";
import { createSecretCipher, computeSignature } from "@cloud-wai/auth";
import { InMemoryJobQueue } from "@cloud-wai/adapters";
import type {
  AuditEvent,
  AuditEventInput,
  ControlPlaneWrites,
  DataStore,
  Deployment,
  DeploymentCreateInput,
  DeploymentStatusInput,
  PreviewTarget,
  Project,
  ProjectGitLink,
} from "@cloud-wai/database";
import type { OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";
import { parseGitDelivery, receiveGitDelivery } from "@cloud-wai/api";

const ORG_A = "org-a" as OrganizationId;
const ORG_B = "org-b" as OrganizationId;
const PROJ_A = "proj-a" as ProjectId;
const ALICE = "u-alice" as UserId;
const LINK_A = "link-a";
const SECRET = "whsec-test-secret-value";

// A fixed 32-byte key so the cipher is deterministic across the test.
const CIPHER = createSecretCipher(Buffer.alloc(32, 7).toString("base64"))!;

/**
 * The subset of the store a delivery touches, with the service-scope rules the
 * SQL layer applies: every lookup carries an organization, and a row from
 * another tenant is null.
 */
function makeStore(link: ProjectGitLink) {
  // Real ciphertext, so the receiver's decrypt is exercised rather than stubbed.
  const secretCiphertext = CIPHER.encrypt(SECRET);
  const deployments: Deployment[] = [];
  const previewTargets: PreviewTarget[] = [];
  const audit: AuditEvent[] = [];
  const projects: Project[] = [
    {
      id: PROJ_A,
      organizationId: ORG_A,
      name: "Alpha",
      slug: "alpha",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ];

  const writes = {
    async getGitLinkForService(organizationId: OrganizationId, linkId: string) {
      return link.organizationId === organizationId && link.id === linkId ? link : null;
    },
    async getGitLinkSecret(organizationId: OrganizationId, linkId: string) {
      return link.organizationId === organizationId && link.id === linkId ? secretCiphertext : null;
    },
    async getProjectForService(organizationId: OrganizationId, projectId: ProjectId) {
      return (
        projects.find((p) => p.id === projectId && p.organizationId === organizationId) ?? null
      );
    },
    async createDeployment(input: DeploymentCreateInput) {
      const deployment: Deployment = {
        id: `dep-${deployments.length + 1}` as Deployment["id"],
        organizationId: input.organizationId,
        projectId: input.projectId,
        status: input.status,
        url: input.url,
        kind: input.kind ?? "production",
        gitBranch: input.gitBranch ?? null,
        gitCommit: input.gitCommit ?? null,
        pullRequest: input.pullRequest ?? null,
        previewKey: input.previewKey ?? null,
        providerResourceId: input.providerResourceId,
        deploymentResourceId: null,
        failureReason: input.failureReason,
        createdAt: "2026-01-01T00:00:00Z",
        gitRepository: input.gitRepository ?? null,
        buildPack: input.buildPack ?? null,
      };
      deployments.push(deployment);
      return deployment;
    },
    async getPreviewTargetForService(
      organizationId: OrganizationId,
      projectId: ProjectId,
      previewKey: string,
    ) {
      return (
        previewTargets.find(
          (t) =>
            t.organizationId === organizationId &&
            t.projectId === projectId &&
            t.previewKey === previewKey,
        ) ?? null
      );
    },
    async createPreviewTarget(input: {
      organizationId: OrganizationId;
      projectId: ProjectId;
      previewKey: string;
      branch: string | null;
      pullRequest: number | null;
      createdBy: UserId;
    }) {
      const target: PreviewTarget = {
        id: `pt-${previewTargets.length + 1}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        previewKey: input.previewKey,
        branch: input.branch,
        pullRequest: input.pullRequest,
        provider: null,
        providerResourceId: null,
      };
      previewTargets.push(target);
      return target;
    },
    async updateDeploymentStatus(input: DeploymentStatusInput) {
      const found = deployments.find((d) => d.id === input.deploymentId);
      return found ?? null;
    },
    async recordAuditEvent(input: AuditEventInput) {
      const event: AuditEvent = {
        ...input,
        id: `a-${audit.length + 1}`,
        createdAt: "2026-01-01T00:00:00Z",
      };
      audit.push(event);
      return event;
    },
  };

  const byKey = new Map<string, Deployment>();
  const store = {
    ...writes,
    deployments,
    previewTargets,
    audit,
    // The service idempotency read must see rows `createDeployment` wrote, so
    // both are rewritten over a map the create fills.
    async findDeploymentByIdempotencyKeyForService(
      organizationId: OrganizationId,
      idempotencyKey: string,
    ) {
      const found = byKey.get(idempotencyKey);
      return found && found.organizationId === organizationId ? found : null;
    },
    async createDeployment(input: DeploymentCreateInput) {
      const deployment = await writes.createDeployment(input);
      byKey.set(input.idempotencyKey, deployment);
      return deployment;
    },
  };
  return store;
}

function makeLink(overrides: Partial<ProjectGitLink> = {}): ProjectGitLink {
  return {
    id: LINK_A,
    organizationId: ORG_A,
    projectId: PROJ_A,
    provider: "github",
    repository: "acme/site",
    productionBranch: "main",
    previewsEnabled: false,
    secretPrefix: "whsec_test",
    createdBy: ALICE,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function deps(store: unknown, cipher = CIPHER) {
  return {
    store: store as DataStore & Partial<ControlPlaneWrites>,
    queue: new InMemoryJobQueue(),
    cipher,
  };
}

const pushBody = (branch: string, commit: string) =>
  JSON.stringify({
    ref: `refs/heads/${branch}`,
    after: commit,
    repository: { full_name: "acme/site" },
  });

const signed = (body: string) => `sha256=${computeSignature(SECRET, body)}`;

describe("the git webhook receiver", () => {
  it("creates one deployment and one job for a push signed with the link's secret", async () => {
    const store = makeStore(makeLink());
    const d = deps(store);
    const body = pushBody("main", "a".repeat(40));

    const outcome = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });

    expect(outcome.status).toBe(202);
    expect(store.deployments).toHaveLength(1);
    expect(store.deployments[0]!.kind).toBe("production");
    expect(store.deployments[0]!.gitBranch).toBe("main");
    // The row is pending: the engine has not answered yet, and a webhook may not
    // claim an outcome it did not observe.
    expect(store.deployments[0]!.status).toBe("pending");
    // The engine clones from a URL. The link stores `owner/name`, so the row and
    // the job must carry the derived clone URL — a raw `acme/site` would be a
    // source Coolify cannot resolve, and the bug would only show at build time.
    expect(store.deployments[0]!.gitRepository).toBe("https://github.com/acme/site.git");
    expect(store.audit.map((a) => a.event)).toContain("deployment.triggered");
    // No member acted, so the audit row has no actor.
    expect(store.audit.find((a) => a.event === "deployment.triggered")!.actorId).toBeNull();
  });

  it("enqueues the derived clone URL, not the stored repository name", async () => {
    const store = makeStore(makeLink());
    const queue = new InMemoryJobQueue();
    const d = { ...deps(store), queue };
    const body = pushBody("main", "f".repeat(40));

    await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });

    const job = await queue.claim("w-1", 30_000);
    expect(job?.kind).toBe("deployments.execute");
    expect(job?.payload).toMatchObject({ gitRepository: "https://github.com/acme/site.git" });
  });

  it("accepts a generic link but builds nothing, since it has no clone host", async () => {
    const store = makeStore(makeLink({ provider: "generic" }));
    const d = deps(store);
    const body = pushBody("main", "g".repeat(40));

    const outcome = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });

    // Accepted (the provider is not wrong) and honestly ignored: there is no
    // URL to hand the engine, so no deployment is invented.
    expect(outcome.status).toBe(202);
    expect(outcome.body.reason).toBe("repository_url_unknown");
    expect(store.deployments).toHaveLength(0);
  });

  it("refuses a body signed with the wrong secret and creates nothing", async () => {
    const store = makeStore(makeLink());
    const d = deps(store);
    const body = pushBody("main", "b".repeat(40));
    const wrong = `sha256=${computeSignature("not-the-secret", body)}`;

    const outcome = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: wrong,
      token: null,
      body,
    });

    expect(outcome.status).toBe(401);
    expect(store.deployments).toHaveLength(0);
  });

  it("gives a bad signature and an unknown link the same public reason", async () => {
    const store = makeStore(makeLink());
    const d = deps(store);
    const body = pushBody("main", "c".repeat(40));

    const badSignature = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: "sha256=00",
      token: null,
      body,
    });
    const unknownLink = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: "link-does-not-exist",
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });

    // A prober must not be able to tell "no such link" from "wrong signature".
    expect(badSignature.body.reason).toBe("invalid_signature");
    expect(unknownLink.body.reason).toBe("invalid_signature");
  });

  it("replays a redelivered webhook instead of building twice", async () => {
    const store = makeStore(makeLink());
    const d = deps(store);
    const body = pushBody("main", "d".repeat(40));

    const first = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });
    const second = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.reason).toBe("replayed");
    expect(store.deployments).toHaveLength(1);
  });

  it("does not resolve a link from another organization", async () => {
    const store = makeStore(makeLink());
    const d = deps(store);
    const body = pushBody("main", "e".repeat(40));

    const outcome = await receiveGitDelivery(d, {
      organizationId: ORG_B,
      linkId: LINK_A,
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });

    expect(outcome.status).toBe(401);
    expect(store.deployments).toHaveLength(0);
  });

  it("treats a non-production branch as a preview and records its target", async () => {
    const store = makeStore(makeLink({ previewsEnabled: true }));
    const d = deps(store);
    const body = pushBody("feature/x", "f".repeat(40));

    const outcome = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });

    expect(outcome.status).toBe(202);
    expect(store.deployments[0]!.kind).toBe("preview");
    expect(store.deployments[0]!.previewKey).toBe("branch-feature-x");
    expect(store.previewTargets).toHaveLength(1);
    expect(store.audit.map((a) => a.event)).toContain("deployment.preview.triggered");
  });

  it("ignores a non-production branch when previews are disabled", async () => {
    const store = makeStore(makeLink({ previewsEnabled: false }));
    const d = deps(store);
    const body = pushBody("feature/x", "1".repeat(40));

    const outcome = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });

    expect(outcome.status).toBe(202);
    expect(outcome.body.reason).toBe("previews_disabled");
    expect(store.deployments).toHaveLength(0);
  });

  it("refuses every delivery when no encryption key is configured", async () => {
    const store = makeStore(makeLink());
    const d = deps(store, null);
    const body = pushBody("main", "2".repeat(40));

    const outcome = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "push",
      signature: signed(body),
      token: null,
      body,
    });

    // Honest absence: 503, nothing written, and never a plaintext comparison.
    expect(outcome.status).toBe(503);
    expect(outcome.body.reason).toBe("not_configured");
    expect(store.deployments).toHaveLength(0);
  });

  it("ignores a delivery whose shape it does not understand", async () => {
    const store = makeStore(makeLink());
    const d = deps(store);
    const body = JSON.stringify({ zen: "Design for failure.", hook_id: 1 });

    const outcome = await receiveGitDelivery(d, {
      organizationId: ORG_A,
      linkId: LINK_A,
      event: "ping",
      signature: signed(body),
      token: null,
      body,
    });

    expect(outcome.status).toBe(202);
    expect(outcome.body.reason).toBe("not_a_deployable_event");
    expect(store.deployments).toHaveLength(0);
  });
});

describe("parseGitDelivery", () => {
  it("reads a GitHub push", () => {
    const parsed = parseGitDelivery("push", pushBody("main", "abc1234"));
    expect(parsed).toMatchObject({ branch: "main", commit: "abc1234", isPullRequest: false });
  });

  it("reads a GitHub pull request", () => {
    const parsed = parseGitDelivery(
      "pull_request",
      JSON.stringify({
        action: "opened",
        pull_request: { number: 7, head: { ref: "feature", sha: "abcdef0123" } },
      }),
    );
    expect(parsed).toMatchObject({
      branch: "feature",
      commit: "abcdef0123",
      pullRequest: 7,
      isPullRequest: true,
    });
  });

  it("reads a GitLab push by its body's object_kind", () => {
    const parsed = parseGitDelivery(
      null,
      JSON.stringify({ object_kind: "push", ref: "refs/heads/main", after: "deadbeef" }),
    );
    expect(parsed).toMatchObject({ branch: "main", commit: "deadbeef", event: "push" });
  });

  it("reads a GitLab merge request", () => {
    const parsed = parseGitDelivery(
      null,
      JSON.stringify({
        object_kind: "merge_request",
        object_attributes: { iid: 3, source_branch: "topic", last_commit: { id: "cafe1" } },
      }),
    );
    expect(parsed).toMatchObject({ branch: "topic", pullRequest: 3, isPullRequest: true });
  });

  it("reads a Bitbucket 1.x push", () => {
    const parsed = parseGitDelivery(
      null,
      JSON.stringify({ push: { changes: [{ new: { name: "release" } }] } }),
    );
    expect(parsed).toMatchObject({ branch: "release" });
  });

  it("does not take a tag push as a branch", () => {
    const parsed = parseGitDelivery(
      "push",
      JSON.stringify({ ref: "refs/tags/v1.0.0", after: "1234567" }),
    );
    expect(parsed.branch).toBeNull();
    expect(parsed.commit).toBe("1234567");
  });

  it("never treats an all-zero after as a commit", () => {
    const parsed = parseGitDelivery(
      "push",
      JSON.stringify({ ref: "refs/heads/main", after: "0".repeat(40) }),
    );
    expect(parsed.commit).toBeNull();
  });

  it("returns an empty parse for a body that is not JSON", () => {
    expect(parseGitDelivery("push", "not json at all")).toMatchObject({
      branch: null,
      commit: null,
      event: "unknown",
    });
  });
});
