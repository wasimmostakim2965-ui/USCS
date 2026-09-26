/**
 * Railpack build adapter.
 *
 * Railpack is Railway's BuildKit-based source-to-image builder, the successor to
 * Nixpacks (which is in maintenance mode). It takes a source directory and
 * produces an OCI image with no configuration, which is the "framework
 * auto-detect" behaviour Vercel describes for its own build container.
 *
 * The platform reaches it the same way it reaches Coolify: a per-organization
 * builder endpoint and token, over the shared JSON HTTP client. The platform
 * never learns Railpack's internals, and Railpack never learns about tenants —
 * the organization's own endpoint is the boundary (ADR-0002, ADR-0018).
 *
 * Two facts shape this file:
 *
 * 1. **A build is async.** `build` returns an `OperationRef`; the artifact is
 *    read back with `getArtifact` once the job has finished. A build that is
 *    still running has no artifact, and that is reported as an error rather than
 *    an empty artifact, so "not finished" and "finished with no output" can
 *    never be confused.
 * 2. **An `image` source has nothing to build.** It is accepted and reported as
 *    a no-op artifact, because refusing it would force a caller that already has
 *    an image to invent a build step to satisfy the type.
 */
import {
  err,
  ok,
  type AdapterResult,
  type OperationRef,
  type ProviderRef,
} from "@cloud-wai/contracts";
import type { AdapterContext, LogPage } from "./index.js";
import type { BuildArtifact, BuildEngine, BuildRequest } from "./build.js";
import { request, type HttpClientOptions } from "./http.js";

const ENGINE: ProviderRef["provider"] = "railpack";

export interface BuildCredentials {
  /** Base URL of the builder service, e.g. `https://builder.internal:8080`. */
  readonly baseUrl: string;
  /** A token scoped to exactly one organization's builder. Never shared. */
  readonly token: string;
}

export type BuildCredentialResolver = (
  organizationId: AdapterContext["organizationId"],
) => BuildCredentials | null;

export interface RailpackAdapterOptions extends HttpClientOptions {
  readonly credentials: BuildCredentialResolver;
}

/** The builder service's own view of a build, as it appears in responses. */
interface BuildJobResponse {
  readonly id?: string;
  readonly status?: string;
  readonly artifact?: {
    readonly image?: string;
    readonly staticPrefix?: string;
    readonly functions?: Record<string, string>;
    readonly edgeFunctions?: Record<string, string>;
    readonly resolvedCommit?: string;
    readonly framework?: string | null;
  };
  readonly logs?: readonly string[];
  readonly nextCursor?: string;
}

/**
 * Map the builder's artifact payload onto ours.
 *
 * `framework` is reported as the builder sent it — including `null` when the
 * builder could not classify the source. Guessing a framework here would put a
 * claim in the deployment record that no engine made.
 */
function toArtifact(payload: BuildJobResponse["artifact"]): BuildArtifact | null {
  if (!payload) return null;
  const hasAnyOutput =
    payload.image !== undefined ||
    payload.staticPrefix !== undefined ||
    payload.functions !== undefined ||
    payload.edgeFunctions !== undefined;
  if (!hasAnyOutput) return null;
  return {
    ...(payload.image !== undefined ? { image: payload.image } : {}),
    ...(payload.staticPrefix !== undefined ? { staticPrefix: payload.staticPrefix } : {}),
    ...(payload.functions !== undefined ? { functions: payload.functions } : {}),
    ...(payload.edgeFunctions !== undefined ? { edgeFunctions: payload.edgeFunctions } : {}),
    ...(payload.resolvedCommit !== undefined ? { resolvedCommit: payload.resolvedCommit } : {}),
    framework: payload.framework ?? null,
  };
}

export function createRailpackBuildEngine(options: RailpackAdapterOptions): BuildEngine {
  const notConfigured = <T>(org: string): AdapterResult<T> =>
    err(
      "not_configured",
      `No build engine is configured for organization ${org}. ` +
        "Provision a builder endpoint and token for this organization.",
    );

  const credentialsFor = <T>(
    ctx: AdapterContext,
  ): { ok: true; creds: BuildCredentials } | { ok: false; result: AdapterResult<T> } => {
    const creds = options.credentials(ctx.organizationId);
    if (!creds || !creds.baseUrl || !creds.token) {
      return { ok: false, result: notConfigured<T>(ctx.organizationId) };
    }
    return { ok: true, creds };
  };

  const refFor = (organizationId: AdapterContext["organizationId"], id: string): ProviderRef => ({
    organizationId,
    provider: ENGINE,
    resourceType: "build",
    resourceId: id,
  });

  return {
    async build(ctx, request_): Promise<AdapterResult<OperationRef>> {
      const source = request_.source;
      if (source.kind === "git") {
        if (source.repository.trim() === "") {
          return err("failed", "A git source needs a repository URL.");
        }
      } else if (source.uri.trim() === "") {
        return err("failed", "An image source needs a URI.");
      }

      const creds = credentialsFor<OperationRef>(ctx);
      if (!creds.ok) return creds.result;

      const response = await request<BuildJobResponse>(
        { ...options },
        {
          method: "POST",
          url: `${creds.creds.baseUrl.replace(/\/$/, "")}/builds`,
          headers: { authorization: `Bearer ${creds.creds.token}` },
          body: {
            source,
            ...(request_.buildPack !== undefined ? { buildPack: request_.buildPack } : {}),
            ...(request_.environment !== undefined ? { environment: request_.environment } : {}),
            ...(request_.buildCommand !== undefined ? { buildCommand: request_.buildCommand } : {}),
            // The platform's own idempotency key, so a replayed build does not
            // produce a second artifact.
            idempotencyKey: ctx.idempotencyKey,
          },
          timeoutMs: ctx.timeoutMs,
        },
      );
      if (!response.ok) return response;
      const id = response.value.value.id;
      if (!id) {
        // A 2xx with no id is the engine answering in a shape we do not
        // understand. Reporting success would hand back a reference that names
        // nothing, so this is a failure.
        return err("failed", "The builder accepted the build but returned no build id.");
      }
      // `request` already turned a non-2xx into an error, so reaching here means
      // the builder accepted the build.
      return ok("succeeded", {
        jobId: ctx.idempotencyKey as OperationRef["jobId"],
        providerRef: refFor(ctx.organizationId, id),
      });
    },

    async getArtifact(ctx, ref): Promise<AdapterResult<BuildArtifact>> {
      const creds = credentialsFor<BuildArtifact>(ctx);
      if (!creds.ok) return creds.result;

      const response = await request<BuildJobResponse>(
        { ...options },
        {
          method: "GET",
          url: `${creds.creds.baseUrl.replace(/\/$/, "")}/builds/${encodeURIComponent(ref.resourceId)}`,
          headers: { authorization: `Bearer ${creds.creds.token}` },
          timeoutMs: ctx.timeoutMs,
        },
      );
      if (!response.ok) return response;

      const job = response.value.value;
      const artifact = toArtifact(job.artifact);
      if (!artifact) {
        // Distinguish the two reasons there is no artifact, because they mean
        // different things to a caller: still running (wait) versus finished
        // with nothing (a failure).
        const running = job.status === "queued" || job.status === "running";
        return err(
          running ? "degraded" : "failed",
          running
            ? "The build is still running, so it has no artifact yet."
            : "The build finished without producing an artifact.",
        );
      }
      return ok("succeeded", artifact);
    },

    async cancelBuild(ctx, ref): Promise<AdapterResult<void>> {
      const creds = credentialsFor<void>(ctx);
      if (!creds.ok) return creds.result;

      const response = await request<BuildJobResponse>(
        { ...options },
        {
          method: "POST",
          url: `${creds.creds.baseUrl.replace(/\/$/, "")}/builds/${encodeURIComponent(ref.resourceId)}/cancel`,
          headers: { authorization: `Bearer ${creds.creds.token}` },
          timeoutMs: ctx.timeoutMs,
        },
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async getBuildLogs(ctx, ref, cursor): Promise<AdapterResult<LogPage>> {
      const creds = credentialsFor<LogPage>(ctx);
      if (!creds.ok) return creds.result;

      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await request<BuildJobResponse>(
        { ...options },
        {
          method: "GET",
          url: `${creds.creds.baseUrl.replace(/\/$/, "")}/builds/${encodeURIComponent(ref.resourceId)}/logs${query}`,
          headers: { authorization: `Bearer ${creds.creds.token}` },
          timeoutMs: ctx.timeoutMs,
        },
      );
      if (!response.ok) return response;

      const job = response.value.value;
      return ok("succeeded", {
        lines: job.logs ?? [],
        // A builder that does not paginate leaves the cursor null rather than an
        // invented value.
        cursor: job.nextCursor ?? null,
      });
    },
  };
}
