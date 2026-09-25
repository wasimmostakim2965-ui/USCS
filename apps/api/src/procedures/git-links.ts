/**
 * Git-link procedures: connect a repository, list what is connected, disconnect.
 *
 * This is the request-path half of git integration. It does not deploy: a push
 * arrives at the `/hooks/git` receiver (`apps/api/src/git-hook.ts`), which
 * verifies the delivery against the secret stored here and enqueues the same
 * `deployments.execute` job the Deploy button enqueues. Nothing about execution
 * is new; only the trigger is.
 *
 * Two rules the module keeps:
 *
 *   * **The webhook secret is generated server-side and never returned in a
 *     list.** It is shown once, at connect time, exactly as an API key is, so the
 *     customer can paste it into their provider. The stored copy is AES-256-GCM
 *     ciphertext, and the ciphertext is not in any client SELECT grant
 *     (`0011_project_git_links.sql`).
 *   * **No encryption key means no link.** With
 *     `CLOUD_WAI_SECRET_ENCRYPTION_KEY` unset, connecting a repository answers
 *     `not_configured` rather than storing a plaintext secret. Honest absence,
 *     never a downgrade.
 */
import { randomBytes } from "node:crypto";
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import type { ControlPlaneWrites, DataStore, ProjectGitLink } from "@cloud-wai/database";
import type { OrganizationId, ProjectId } from "@cloud-wai/contracts";
import type { SecretCipher } from "@cloud-wai/auth";
import { computeSignature, secretPrefix, signatureMatches, tokenMatches } from "@cloud-wai/auth";
import type { RequestContext } from "../context.js";

/**
 * `owner/name`, lower-cased, no scheme, no `.git` suffix.
 *
 * The same normalisation the SQL check constraint enforces, so the API and the
 * table agree on what a repository name is. A URL with a scheme is not accepted
 * here — the provider and repository are separate fields, and accepting a URL
 * would make two spellings of one repository possible.
 */
const REPOSITORY_PATTERN = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;

/** The git providers a link can name. `generic` is an HMAC sender. */
export const GIT_PROVIDERS = ["github", "gitlab", "bitbucket", "generic"] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

type GitLinkWrites = Pick<
  ControlPlaneWrites,
  "createGitLink" | "getGitLinkForService" | "getGitLinkSecret" | "deleteGitLink"
>;

const REQUIRED_WRITES = [
  "createGitLink",
  "getGitLinkForService",
  "getGitLinkSecret",
  "deleteGitLink",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

export interface GitLinkDeps {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  /** Injected so a link id is a Cloud Wai UUID, not a provider artifact. */
  readonly newId: () => string;
  /** The cipher for the webhook secret. Null means "not configured". */
  readonly cipher: SecretCipher | null;
  /** Injected so a webhook secret is deterministic in tests. */
  readonly newSecret?: (() => string) | undefined;
  readonly now?: () => Date;
}

function writesFor(deps: GitLinkDeps): GitLinkWrites {
  const store = deps.store;
  const missing = REQUIRED_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as GitLinkWrites;
}

/** Generate a URL-safe webhook secret. */
export function defaultWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

function normaliseRepository(value: string): string {
  const repository = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new ApiError("invalid_input", "Repository must be in the form owner/name.");
  }
  return repository;
}

function normaliseBranch(value: string, label: string): string {
  const branch = value.trim();
  if (branch === "" || branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
    throw new ApiError("invalid_input", `${label} is not a valid git branch.`);
  }
  return branch;
}

export interface ConnectGitLinkInput {
  readonly projectId: ProjectId;
  readonly provider: GitProvider;
  readonly repository: string;
  readonly productionBranch?: string | undefined;
  readonly previewsEnabled?: boolean | undefined;
}

/**
 * The moment a secret is shown: the link, and the secret exactly once.
 *
 * `webhookSecret` is the only copy that ever leaves the API in the clear. The
 * list procedure returns the link without it, and the database stores the
 * ciphertext, so a later read cannot recover it.
 */
export interface ConnectedGitLink {
  readonly link: ProjectGitLink;
  readonly webhookSecret: string;
}

/**
 * Connect a repository to a project.
 *
 * The caller must be able to update the project (the same threshold as renaming
 * it). The project is read through the caller's own membership, so a project id
 * from another tenant is `not_found`, never a link into it.
 */
export async function connectGitLink(
  ctx: RequestContext,
  deps: GitLinkDeps,
  input: ConnectGitLinkInput,
): Promise<ConnectedGitLink> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "project:update");

  if (!deps.cipher) {
    // No key: refuse rather than store anything. An unencrypted webhook secret
    // in the control plane is the failure this branch exists to prevent.
    throw new ApiError(
      "engine_unavailable",
      "Set CLOUD_WAI_SECRET_ENCRYPTION_KEY to store a webhook secret for this repository.",
    );
  }
  if (!(GIT_PROVIDERS as readonly string[]).includes(input.provider)) {
    throw new ApiError("invalid_input", "Unknown git provider.");
  }

  const repository = normaliseRepository(input.repository);
  const productionBranch = normaliseBranch(input.productionBranch ?? "main", "Production branch");

  const existing = await deps.store.listGitLinks(ctx.principal.userId, project.id);
  if (existing.some((l) => l.provider === input.provider && l.repository === repository)) {
    throw new ApiError("conflict", "That repository is already linked to this project.");
  }

  const writes = writesFor(deps);
  const secret = (deps.newSecret ?? defaultWebhookSecret)();
  const link = await writes.createGitLink({
    id: deps.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    provider: input.provider,
    repository,
    productionBranch,
    previewsEnabled: input.previewsEnabled ?? false,
    secretEncrypted: deps.cipher.encrypt(secret),
    secretPrefix: secretPrefix(secret),
    createdBy: ctx.principal.userId,
  });

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "git.linked",
    targetType: "project_git_link",
    targetId: link.id,
    // The secret is deliberately absent: an audit row is readable by every
    // member, and a secret in it would be a secret published to the tenant.
    metadata: { projectId: project.id, provider: input.provider, repository },
  });

  return { link, webhookSecret: secret };
}

export interface ListGitLinksInput {
  readonly projectId: ProjectId;
}

/** The repositories linked to a project. Never includes a secret. */
export async function listGitLinks(
  ctx: RequestContext,
  deps: GitLinkDeps,
  input: ListGitLinksInput,
): Promise<readonly ProjectGitLink[]> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "project:read");
  return deps.store.listGitLinks(ctx.principal.userId, project.id);
}

export interface DisconnectGitLinkInput {
  readonly projectId: ProjectId;
  readonly linkId: string;
}

/** Remove a link. Idempotent: removing an absent link is not an error. */
export async function disconnectGitLink(
  ctx: RequestContext,
  deps: GitLinkDeps,
  input: DisconnectGitLinkInput,
): Promise<{ readonly removed: boolean }> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "project:update");

  const writes = writesFor(deps);
  const removed = await writes.deleteGitLink(
    ctx.principal.userId,
    project.organizationId,
    input.linkId,
  );
  if (removed) {
    await deps.store.recordAuditEvent({
      organizationId: project.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "git.unlinked",
      targetType: "project_git_link",
      targetId: input.linkId,
      metadata: { projectId: project.id },
    });
  }
  return { removed };
}

/** The organization a link belongs to, for the receiver. Null when absent. */
export async function gitLinkForService(
  deps: GitLinkDeps,
  organizationId: OrganizationId,
  linkId: string,
): Promise<ProjectGitLink | null> {
  const writes = writesFor(deps);
  return writes.getGitLinkForService(organizationId, linkId);
}

/**
 * The result of verifying a delivery.
 *
 * `secret` is returned only on success, and it is the decrypted value the
 * provider signed with — the caller uses it for nothing but the HMAC check, and
 * it is never persisted or logged.
 */
export type GitDeliveryVerification =
  | { readonly ok: true; readonly link: ProjectGitLink; readonly secret: string }
  | { readonly ok: false; readonly reason: "unknown_link" | "not_configured" | "bad_signature" };

export interface VerifyGitDeliveryInput {
  readonly organizationId: OrganizationId;
  readonly linkId: string;
  /** The raw request body, exactly as received. Re-serialising it breaks the HMAC. */
  readonly body: string;
  /** The provider's signature header (`X-Hub-Signature-256`), when it sends one. */
  readonly signature: string | null;
  /**
   * A shared-token header (`X-Gitlab-Token`), when the provider sends one
   * instead of a body HMAC. Exactly one of `signature`/`token` is required;
   * a provider that sends neither is refused.
   */
  readonly token?: string | null;
}

/** The two reads a delivery verification needs, and nothing else. */
type VerifyWrites = Pick<ControlPlaneWrites, "getGitLinkForService" | "getGitLinkSecret">;

/**
 * Verify a webhook delivery against a stored link.
 *
 * The order of checks is deliberate: the link and its secret are resolved first,
 * and only then is the signature compared. Every failure mode returns a distinct
 * reason for the operator's log but the same `{ ok: false }` shape to the
 * caller, which the receiver turns into a single 4xx — a prober learns only that
 * the delivery was not accepted, never which of the three things was wrong.
 *
 * Only the two reads this needs are required: the webhook receiver holds a
 * service-role store wired for delivery handling, not a full project-settings
 * write path.
 */
export async function verifyGitDelivery(
  deps: GitLinkDeps,
  input: VerifyGitDeliveryInput,
): Promise<GitDeliveryVerification> {
  if (!deps.cipher) return { ok: false, reason: "not_configured" };

  const store = deps.store;
  if (
    typeof store.getGitLinkForService !== "function" ||
    typeof store.getGitLinkSecret !== "function"
  ) {
    throw new ApiError("engine_unavailable", "This deployment cannot verify a webhook delivery.");
  }
  const writes = store as unknown as VerifyWrites;
  const link = await writes.getGitLinkForService(input.organizationId, input.linkId);
  if (!link) return { ok: false, reason: "unknown_link" };

  const ciphertext = await writes.getGitLinkSecret(input.organizationId, input.linkId);
  if (!ciphertext) return { ok: false, reason: "unknown_link" };
  const secret = deps.cipher.decrypt(ciphertext);
  if (secret === null) {
    // A ciphertext that will not decrypt (a rotated key, a tampered row) is a
    // configuration failure, not a bad sender. The delivery is still refused.
    return { ok: false, reason: "not_configured" };
  }

  const expected = computeSignature(secret, input.body);
  // A provider sends one or the other. GitLab's older style is a shared token
  // header, GitHub/Bitbucket send a body HMAC. Accepting only the signature
  // would silently refuse every GitLab delivery; accepting a token when a
  // signature was sent would let a token-only spoofer through.
  const okBySignature = input.signature ? signatureMatches(expected, input.signature) : false;
  const okByToken = input.token ? tokenMatches(secret, input.token) : false;
  if (!okBySignature && !okByToken) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, link, secret };
}
