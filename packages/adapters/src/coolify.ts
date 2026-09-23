/**
 * Coolify hosting adapter.
 *
 * Wraps Coolify's documented API (ADR-0002, pinned commit 7c86e53422ad). The
 * tenant mapping is explicit: a Cloud Wai organization has its own Coolify team
 * and its own API token, so one organization's applications are not merely
 * filtered out of a shared list — they are unreachable with another
 * organization's credentials.
 *
 * Coolify's UUIDs are stored only inside `ProviderRef` values. They are never a
 * tenant boundary.
 */
import {
  err,
  ok,
  type AdapterResult,
  type OperationRef,
  type ProviderRef,
} from "@cloud-wai/contracts";
import type { AdapterContext, DeploymentState, HostingAdapter, LogPage } from "./index.js";
import { request, type HttpClientOptions } from "./http.js";

const ENGINE: ProviderRef["provider"] = "coolify";

export interface CoolifyCredentials {
  /** Base URL, e.g. `https://coolify.internal:8000`. */
  readonly baseUrl: string;
  /** A Sanctum token scoped to exactly one team. Never shared across tenants. */
  readonly token: string;
}

export type CredentialResolver = (
  organizationId: AdapterContext["organizationId"],
) => CoolifyCredentials | null;

export interface CoolifyAdapterOptions extends HttpClientOptions {
  /**
   * Resolves per-organization credentials. When this returns null the adapter
   * reports `not_configured` for that organization rather than falling back to a
   * shared token.
   */
  readonly credentials: CredentialResolver;
}

interface CoolifyApplication {
  readonly uuid?: string;
  readonly name?: string;
  readonly fqdn?: string;
  readonly status?: string;
}

/** Translate Coolify's deployment vocabulary into Cloud Wai's. */
export function mapDeploymentStatus(raw: string | undefined): DeploymentState["status"] {
  switch ((raw ?? "").toLowerCase()) {
    case "queued":
    case "in_progress":
    case "deploying":
    case "running:starting":
      return "running";
    case "finished":
    case "success":
    case "succeeded":
    case "running:healthy":
      return "succeeded";
    case "failed":
    case "error":
    case "exited":
    case "cancelled":
      return "failed";
    case "degraded":
    case "unhealthy":
      return "degraded";
    default:
      return "pending";
  }
}

export function createCoolifyHosting(options: CoolifyAdapterOptions): HostingAdapter {
  const doFetch = options.fetchImpl ?? fetch;

  const notConfigured = <T>(org: string): AdapterResult<T> =>
    err(
      "not_configured",
      `Coolify is not configured for organization ${org}. Provision a team token for this organization.`,
    );

  /** Resolve credentials, or return the honest refusal. */
  const credentialsFor = <T>(
    ctx: AdapterContext,
  ): { ok: true; creds: CoolifyCredentials } | { ok: false; result: AdapterResult<T> } => {
    const creds = options.credentials(ctx.organizationId);
    if (!creds || creds.baseUrl.trim() === "" || creds.token.trim() === "") {
      return { ok: false, result: notConfigured<T>(ctx.organizationId) };
    }
    return { ok: true, creds };
  };

  const call = <T>(
    ctx: AdapterContext,
    creds: CoolifyCredentials,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ) =>
    request<T>(
      { fetchImpl: doFetch, classify: options.classify },
      {
        method,
        url: `${creds.baseUrl.replace(/\/$/, "")}${path}`,
        headers: { authorization: `Bearer ${creds.token}` },
        body,
        timeoutMs: ctx.timeoutMs,
      },
    );

  const opRef = (ctx: AdapterContext, uuid: string, resourceType: string): OperationRef => ({
    jobId: `coolify-${resourceType}-${uuid}` as OperationRef["jobId"],
    providerRef: {
      organizationId: ctx.organizationId,
      provider: ENGINE,
      resourceType,
      resourceId: uuid,
    },
  });

  return {
    async createApplication(ctx, input) {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<CoolifyApplication>(
        ctx,
        resolved.creds,
        "POST",
        "/api/v1/applications",
        {
          name: input.name,
        },
      );
      if (!response.ok) return response;

      const uuid = response.value.value?.uuid;
      if (!uuid) return err("degraded", "Coolify created an application but returned no uuid.");
      return ok("succeeded", opRef(ctx, uuid, "application"));
    },

    async deploy(ctx, input) {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<unknown>(ctx, resolved.creds, "POST", "/api/v1/deploy", {
        uuid: input.applicationRef.resourceId,
      });
      if (!response.ok) return response;
      return ok("succeeded", opRef(ctx, input.applicationRef.resourceId, "deployment"));
    },

    async getDeployment(ctx, ref) {
      const resolved = credentialsFor<DeploymentState>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<CoolifyApplication>(
        ctx,
        resolved.creds,
        "GET",
        `/api/v1/applications/${encodeURIComponent(ref.resourceId)}`,
      );
      if (!response.ok) return response;

      const app = response.value.value ?? {};
      return ok("succeeded", {
        ref,
        status: mapDeploymentStatus(app.status),
        url: app.fqdn ?? null,
      });
    },

    async cancelDeployment(ctx, ref) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "POST",
        `/api/v1/applications/${encodeURIComponent(ref.resourceId)}/cancel`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async rollback(ctx, input) {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "POST",
        `/api/v1/applications/${encodeURIComponent(input.applicationRef.resourceId)}/rollback`,
      );
      if (!response.ok) return response;
      return ok("succeeded", opRef(ctx, input.applicationRef.resourceId, "rollback"));
    },

    async getLogs(ctx, ref, cursor) {
      const resolved = credentialsFor<LogPage>(ctx);
      if (!resolved.ok) return resolved.result;

      const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await call<{ logs?: string; lines?: string[]; cursor?: string }>(
        ctx,
        resolved.creds,
        "GET",
        `/api/v1/applications/${encodeURIComponent(ref.resourceId)}/logs${suffix}`,
      );
      if (!response.ok) return response;

      const body = response.value.value ?? {};
      const lines = body.lines ?? (body.logs ? body.logs.split("\n") : []);
      return ok("succeeded", { lines, cursor: body.cursor ?? null });
    },

    async deleteApplication(ctx, ref) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "DELETE",
        `/api/v1/applications/${encodeURIComponent(ref.resourceId)}`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    /**
     * Reconcile against the engine.
     *
     * A 404 means Coolify does not have this application: report
     * `not_configured` for that ref rather than inventing a state.
     * Reconciliation is read-only — it never deploys.
     */
    async reconcile(ctx, ref) {
      const resolved = credentialsFor<DeploymentState>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<CoolifyApplication>(
        ctx,
        resolved.creds,
        "GET",
        `/api/v1/applications/${encodeURIComponent(ref.resourceId)}`,
      );
      if (!response.ok) {
        if (response.status === "failed" && response.reason.includes("404")) {
          return err("not_configured", `Coolify has no application ${ref.resourceId}.`);
        }
        return response;
      }

      const app = response.value.value ?? {};
      return ok("succeeded", {
        ref,
        status: mapDeploymentStatus(app.status),
        url: app.fqdn ?? null,
      });
    },
  };
}
