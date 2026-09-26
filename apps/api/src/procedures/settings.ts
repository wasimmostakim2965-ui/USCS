/**
 * Settings procedures: domains, data resources and API keys.
 *
 * Three flows the blueprint lists as required, and the rules they share:
 *
 *   * a domain is created unverified and only the edge may verify it — a client
 *     cannot set `verified` on its own hostname;
 *   * a data resource's state is the worker's to write, so this exposes reads;
 *   * an API key is issued once and never returned again, and its scopes are
 *     bounded by the owner's role before they are stored.
 */
import { issueApiKey, boundedScopes, type ApiKeyScope } from "@cloud-wai/auth";
import { requireCapability, roleFor } from "../guard.js";
import { ApiError } from "../errors.js";
import type { ApiKeySummary, DataResource, DataStore, Domain } from "@cloud-wai/database";
import type { ApiKeyId, OrganizationId, ProjectId, UserId } from "@cloud-wai/contracts";
import type { EngineConsoleLinks } from "@cloud-wai/adapters";
import type { RequestContext } from "../context.js";

/**
 * Resolves a resource's engine-console links, or null.
 *
 * The URL shape belongs to the adapter layer (`engineConsoleUrl`), and the
 * credentials it needs are the deployment's, so this is injected rather than
 * read here: a procedure must not reach into engine configuration, and a test
 * that has no console can pass nothing and get honest nulls.
 */
export type ConsoleLinkResolver = (input: {
  readonly organizationId: OrganizationId;
  readonly resource: DataResource;
}) => EngineConsoleLinks | null;

export interface SettingsDeps {
  readonly store: DataStore;
  /** Injected so a key id is a Cloud Wai UUID, not a provider or test artifact. */
  readonly newId: () => string;
  readonly now?: () => Date;
  /**
   * When wired, `data.list` carries each resource's engine-console link so the
   * dashboard can send an operator to the engine's own screen. Absent means no
   * links — the dashboard says so rather than rendering a broken one.
   */
  readonly consoleLink?: ConsoleLinkResolver | undefined;
}

/**
 * An organization's domains, narrowed to a project when one is named.
 *
 * The sidebar's Domains page is project-scoped, but `domains.projectId` is
 * nullable: a domain can be registered organization-wide with no project. The
 * rule is the same one the Database page uses — a project's Domains page shows
 * that project's domains plus the organization-wide ones, never another
 * project's. Without this, opening project A listed project B's hostnames.
 */
export async function listDomains(
  ctx: RequestContext,
  deps: SettingsDeps,
  organizationId: OrganizationId,
  projectId?: ProjectId | undefined,
): Promise<readonly Domain[]> {
  requireCapability(ctx, organizationId, "domain:read");
  const domains = await deps.store.listDomains(ctx.principal.userId, organizationId);
  if (!projectId) return domains;
  return domains.filter((domain) => domain.projectId == null || domain.projectId === projectId);
}

/**
 * A data resource as the API returns it.
 *
 * `engineConsole` is resolved server-side from the deployment's own engine
 * configuration, so the browser never learns a console origin or a tenant's
 * engine identifiers beyond the links it is given. It is null whenever links
 * cannot be stood behind — no console configured, a bucket, or a resource the
 * engine has not named yet.
 */
export interface DataResourceView extends DataResource {
  readonly engineConsole: EngineConsoleLinks | null;
}

export async function listDataResources(
  ctx: RequestContext,
  deps: SettingsDeps,
  organizationId: OrganizationId,
): Promise<readonly DataResourceView[]> {
  requireCapability(ctx, organizationId, "data:read");
  const resources = await deps.store.listDataResources(ctx.principal.userId, organizationId);
  return resources.map((resource) => ({
    ...resource,
    engineConsole: deps.consoleLink?.({ organizationId, resource }) ?? null,
  }));
}

export async function listApiKeys(
  ctx: RequestContext,
  deps: SettingsDeps,
  organizationId: OrganizationId,
): Promise<readonly ApiKeySummary[]> {
  requireCapability(ctx, organizationId, "apikey:read");
  return deps.store.listApiKeys(ctx.principal.userId, organizationId);
}

export interface IssuedKeyResult {
  readonly key: ApiKeySummary;
  /** Present on this response and no other. */
  readonly secret: string;
}

/**
 * Create a key and return its secret once.
 *
 * The requested scopes are narrowed to the caller's role *before* storage, so a
 * member cannot mint an `org:delete` key by asking for one. The audit record
 * holds the key id and prefix, never the secret.
 */
export async function createApiKey(
  ctx: RequestContext,
  deps: SettingsDeps,
  input: { organizationId: OrganizationId; name: string; scopes: readonly string[] },
): Promise<IssuedKeyResult> {
  requireCapability(ctx, input.organizationId, "apikey:create");

  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    throw new ApiError("invalid_input", "API key name must be 1-120 characters.");
  }

  const role = roleFor(ctx, input.organizationId);
  if (!role) throw new ApiError("not_found", "Organization not found.");

  const issued = issueApiKey({
    id: deps.newId() as ApiKeyId,
    organizationId: input.organizationId,
    ownerId: ctx.principal.userId,
    name,
    role,
    requestedScopes: input.scopes as readonly ApiKeyScope[],
    now: deps.now?.() ?? new Date(),
  });

  const key = await deps.store.createApiKey({
    id: issued.record.id,
    organizationId: issued.record.organizationId,
    name: issued.record.name,
    keyHash: issued.record.keyHash,
    keyPrefix: issued.record.keyPrefix,
    ownerId: issued.record.ownerId,
    scopes: issued.record.scopes,
  });

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "api_key.created",
    targetType: "api_key",
    targetId: key.id,
    // Prefix only: the hash and the secret must never reach an audit row.
    metadata: { prefix: key.keyPrefix, scopes: key.scopes },
  });

  return { key, secret: issued.secret };
}

export async function revokeApiKey(
  ctx: RequestContext,
  deps: SettingsDeps,
  input: { organizationId: OrganizationId; keyId: ApiKeyId },
): Promise<{ revoked: boolean }> {
  requireCapability(ctx, input.organizationId, "apikey:revoke");

  const revoked = await deps.store.revokeApiKey(
    ctx.principal.userId,
    input.organizationId,
    input.keyId,
  );
  if (!revoked) throw new ApiError("not_found", "API key not found.");

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "api_key.revoked",
    targetType: "api_key",
    targetId: input.keyId,
  });

  return { revoked: true };
}

/** Exposed for the boundary test: the scopes a role can actually be granted. */
export function scopesForRole(role: Parameters<typeof boundedScopes>[1]): readonly ApiKeyScope[] {
  return boundedScopes(
    [
      "org:read",
      "org:delete",
      "project:read",
      "project:create",
      "deployment:create",
      "data:destroy",
      "security:quarantine",
      "apikey:create",
      "billing:manage",
    ],
    role,
  );
}

export type { UserId };
