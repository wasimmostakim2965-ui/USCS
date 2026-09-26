/**
 * Domain procedures: add, verify and remove a hostname.
 *
 * The rule the whole module turns on: a client can *ask* for a domain to be
 * verified, but it can never assert that it is. `verified` is written only from
 * the domain verifier's answer, and only for the organization that owns the
 * domain. There is no procedure that accepts a `verified` flag.
 *
 * A second rule keeps the claim honest: adding a domain issues a DNS challenge
 * (a token the customer publishes as a TXT record) and stores it. A verify
 * request compares the record on the wire against that stored token, so a
 * hostname is confirmed only when control of it is actually demonstrated.
 */
import { randomBytes } from "node:crypto";
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import type { Engines } from "@cloud-wai/adapters";
import type { ControlPlaneWrites, DataStore, Domain } from "@cloud-wai/database";
import type { DomainId, OrganizationId, ProjectId } from "@cloud-wai/contracts";
import type { RequestContext } from "../context.js";
import type { SettingsDeps } from "./settings.js";

/** The same grammar the SQL check constraint enforces, so both agree. */
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

type DomainWrites = Pick<
  ControlPlaneWrites,
  "createDomain" | "getDomain" | "deleteDomain" | "setDomainVerification"
>;

/** Bound on an engine call so a hung edge cannot hold the request open. */
const ADAPTER_TIMEOUT_MS = 20_000;

const REQUIRED_WRITES = [
  "createDomain",
  "getDomain",
  "deleteDomain",
  "setDomainVerification",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

export interface DomainDeps extends Omit<SettingsDeps, "store"> {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  readonly engines: Engines;
  /** Injected so a challenge token is deterministic in tests. */
  readonly newToken?: (() => string) | undefined;
}

/**
 * The write half of the store, or an honest refusal.
 *
 * A read-only store must not answer `ok` for a domain it never recorded.
 */
function writesFor(deps: DomainDeps): DomainWrites {
  const store = deps.store;
  const missing = REQUIRED_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as DomainWrites;
}

function normaliseHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_PATTERN.test(hostname)) {
    throw new ApiError("invalid_input", "Hostname is not a valid DNS name.");
  }
  return hostname;
}

/** A URL-safe challenge value. Not a credential: it is published publicly. */
export function defaultChallengeToken(): string {
  return `cw-domain-verify=${randomBytes(16).toString("hex")}`;
}

export interface DomainChallenge {
  readonly domain: Domain;
  /** The record name and value the customer must publish. */
  readonly recordName: string;
  readonly recordValue: string;
  readonly recordType: "TXT";
}

export interface AddDomainInput {
  readonly organizationId: OrganizationId;
  readonly projectId?: ProjectId | undefined;
  readonly hostname: string;
}

/**
 * Add a hostname and issue its verification challenge.
 *
 * The domain is created unverified; `verified` is not accepted from the caller.
 * The challenge token is returned so the customer can publish it, and stored so
 * a later verify call has something to compare against.
 */
export async function addDomain(
  ctx: RequestContext,
  deps: DomainDeps,
  input: AddDomainInput,
): Promise<DomainChallenge> {
  requireCapability(ctx, input.organizationId, "domain:create");

  const hostname = normaliseHostname(input.hostname);

  // A project, when named, must be in the same organization: the domain would
  // otherwise read as belonging to an organization the caller did not choose.
  if (input.projectId) {
    const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
    if (!project || project.organizationId !== input.organizationId) {
      throw new ApiError("not_found", "Project not found.");
    }
  }

  const writes = writesFor(deps);
  const existing = (await deps.store.listDomains(ctx.principal.userId, input.organizationId)).find(
    (d) => d.hostname === hostname,
  );
  if (existing) {
    throw new ApiError("conflict", "That hostname is already registered.");
  }

  const token = (deps.newToken ?? defaultChallengeToken)();
  const domain = await writes.createDomain({
    id: deps.newId() as DomainId,
    organizationId: input.organizationId,
    projectId: input.projectId ?? null,
    hostname,
    verificationToken: token,
  });

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "domain.created",
    targetType: "domain",
    targetId: domain.id,
    metadata: { hostname },
  });

  return {
    domain,
    recordName: `_cloud-wai-challenge.${hostname}`,
    recordValue: token,
    recordType: "TXT",
  };
}

export interface VerifyDomainInput {
  readonly organizationId: OrganizationId;
  readonly domainId: DomainId;
}

export interface VerifyDomainResult {
  readonly domain: Domain;
  /** The verifier's own words, so the UI can say why it did not confirm. */
  readonly detail: string;
  /**
   * Whether the edge now serves this hostname, and why not when it does not.
   *
   * Verification and route publication are separate facts: the DNS verifier can
   * confirm a hostname while the edge is unconfigured, and reporting the second
   * as a verification failure would be a lie in the other direction. `null` means
   * the hostname is not verified yet, so there is no route to publish — not a
   * failure. This is the same honesty rule the rest of the product keeps: an
   * unconfigured engine is reported, never papered over.
   */
  readonly edge: { readonly published: boolean; readonly reason: string | null } | null;
}

/**
 * Ask the verifier whether the hostname now points where it should.
 *
 * The stored challenge token is what the verifier compares against. Whatever it
 * answers becomes the row's state — including a refusal, which leaves the domain
 * unverified rather than failing the request. A verifier that is not configured
 * is reported honestly and writes nothing.
 *
 * When the verifier confirms the hostname, the route is then published to the
 * edge. That step is what makes the domain reachable *through* the edge at all;
 * without it the edge never learns the hostname and the firewall is bypassed by
 * simply not being on the path. A publication that does not succeed (the edge
 * unconfigured, or a refusal) does not undo the verification — the two are
 * distinct — but it is reported, never swallowed.
 */
export async function verifyDomain(
  ctx: RequestContext,
  deps: DomainDeps,
  input: VerifyDomainInput,
): Promise<VerifyDomainResult> {
  requireCapability(ctx, input.organizationId, "domain:verify");

  const writes = writesFor(deps);
  const domain = await writes.getDomain(ctx.principal.userId, input.domainId);
  if (!domain || domain.organizationId !== input.organizationId) {
    throw new ApiError("not_found", "Domain not found.");
  }
  if (!domain.verificationToken) {
    throw new ApiError(
      "conflict",
      "This domain has no verification challenge; remove and re-add it to get one.",
    );
  }

  const result = await deps.engines.domainVerifier.resolveDomainVerification(
    {
      organizationId: domain.organizationId,
      idempotencyKey: `verify-domain-${domain.id}`,
      timeoutMs: 15_000,
    },
    { hostname: domain.hostname, expectedToken: domain.verificationToken },
  );

  if (!result.ok) {
    // Nothing is written on a refusal: the domain keeps its current state and
    // the caller learns the verifier could not answer.
    throw new ApiError(
      result.status === "not_configured" ? "engine_unavailable" : "conflict",
      `The domain verifier could not confirm this hostname: ${result.reason}`,
    );
  }

  const updated = await writes.setDomainVerification({
    id: domain.id,
    organizationId: domain.organizationId,
    verified: result.value.verified,
    provider: result.value.provider,
    providerResourceId: result.value.providerResourceId,
    verifiedAt: result.value.verified ? (deps.now?.() ?? new Date()).toISOString() : null,
  });

  // A verified hostname must be served by the edge, or the firewall is not on
  // the path at all. Publish after the row is written, so the edge resolves the
  // hostname through the same verified state the customer sees — never from a
  // value that only exists in this request.
  let edge: VerifyDomainResult["edge"] = null;
  if (result.value.verified) {
    const published = await deps.engines.securityEdge.publishRoute(
      {
        organizationId: domain.organizationId,
        idempotencyKey: `publish-route-${domain.id}`,
        timeoutMs: ADAPTER_TIMEOUT_MS,
      },
      {
        routeRef: {
          organizationId: domain.organizationId,
          provider: "envoy",
          resourceType: "route",
          resourceId: domain.hostname,
        },
      },
    );
    edge = published.ok
      ? { published: true, reason: null }
      : { published: false, reason: published.reason };

    await deps.store.recordAuditEvent({
      organizationId: domain.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: published.ok ? "domain.route_published" : "domain.route_publish_failed",
      targetType: "domain",
      targetId: domain.id,
      metadata: {
        hostname: domain.hostname,
        status: published.ok ? "succeeded" : published.status,
      },
    });
  }

  await deps.store.recordAuditEvent({
    organizationId: domain.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: result.value.verified ? "domain.verified" : "domain.verification_failed",
    targetType: "domain",
    targetId: domain.id,
    metadata: { hostname: domain.hostname, verified: result.value.verified },
  });

  return {
    domain: updated ?? { ...domain, verified: result.value.verified },
    detail: result.value.detail,
    edge,
  };
}

export interface RemoveDomainInput {
  readonly organizationId: OrganizationId;
  readonly domainId: DomainId;
}

/** Remove a hostname. Idempotent in the store, reported honestly to the caller. */
export async function removeDomain(
  ctx: RequestContext,
  deps: DomainDeps,
  input: RemoveDomainInput,
): Promise<{ removed: boolean }> {
  requireCapability(ctx, input.organizationId, "domain:delete");

  const writes = writesFor(deps);
  // Read first: the hostname is what names the edge route, and after the delete
  // there is nothing left to derive it from. A domain the caller cannot see
  // returns not_found, the same as a missing one, so a non-member cannot probe.
  const domain = await writes.getDomain(ctx.principal.userId, input.domainId);
  if (!domain || domain.organizationId !== input.organizationId) {
    throw new ApiError("not_found", "Domain not found.");
  }

  const removed = await writes.deleteDomain(
    ctx.principal.userId,
    input.organizationId,
    input.domainId,
  );
  if (!removed) throw new ApiError("not_found", "Domain not found.");

  // Withdraw the route so the edge stops serving a hostname the customer has
  // released. A route that fails to withdraw leaves the edge serving a hostname
  // the control plane no longer lists, which is worse than a loud failure — so
  // the outcome is recorded either way, never assumed to have worked.
  const withdrawn = await deps.engines.securityEdge.removeRoute(
    {
      organizationId: input.organizationId,
      idempotencyKey: `remove-route-${input.domainId}`,
      timeoutMs: ADAPTER_TIMEOUT_MS,
    },
    {
      routeRef: {
        organizationId: input.organizationId,
        provider: "envoy",
        resourceType: "route",
        resourceId: domain.hostname,
      },
    },
  );

  await deps.store.recordAuditEvent({
    organizationId: input.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "domain.removed",
    targetType: "domain",
    targetId: input.domainId,
    metadata: {
      hostname: domain.hostname,
      routeWithdrawn: withdrawn.ok,
      ...(withdrawn.ok ? {} : { routeWithdrawReason: withdrawn.reason }),
    },
  });

  return { removed: true };
}
