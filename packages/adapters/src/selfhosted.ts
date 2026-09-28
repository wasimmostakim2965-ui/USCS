/**
 * Cloud Wai self-hosted runtime hosting adapter.
 *
 * Wraps this platform's own container runtime
 * (`infra/deployment/runtime-server.mjs`) behind the same `HostingAdapter` port
 * the Coolify adapter implements. The control plane asks for "the container
 * engine" and does not know which one answered — that is the whole point of the
 * port (ADR-0002). What changes is who owns the machine that runs a customer's
 * container: Coolify, or this deployment itself.
 *
 * It is a thin, honest translation. The runtime builds from git through the
 * build plane, runs the resulting image and reports the real status; this
 * adapter never invents a deployment or a URL the runtime did not return. When
 * an organization has no runtime credentials it reports `not_configured` rather
 * than falling back to a shared runtime, because a shared fallback would run one
 * tenant's code on another tenant's machine and call it deployment.
 */
import {
  err,
  ok,
  type AdapterResult,
  type OperationRef,
  type ProviderRef,
} from "@cloud-wai/contracts";
import type {
  AdapterContext,
  CreateApplicationInput,
  DeploymentState,
  EnvVarState,
  HostingAdapter,
  LogPage,
} from "./index.js";
import { request, type HttpClientOptions } from "./http.js";

const ENGINE: ProviderRef["provider"] = "selfhosted";

export interface SelfHostedCredentials {
  /** Base URL of the runtime engine, e.g. `http://runtime.internal:8095`. */
  readonly baseUrl: string;
  /** A token scoped to one organization's applications on that runtime. */
  readonly token: string;
}

export type SelfHostedCredentialResolver = (
  organizationId: AdapterContext["organizationId"],
) => SelfHostedCredentials | null;

export interface SelfHostedAdapterOptions extends HttpClientOptions {
  readonly credentials: SelfHostedCredentialResolver;
}

/** The runtime's own view of an application, as its responses carry it. */
interface RuntimeApp {
  readonly id?: string;
  readonly status?: string;
  readonly url?: string | null;
  readonly engineReason?: string | null;
  readonly artifact?: { readonly image?: string } | null;
}

export function createSelfHostedHostingAdapter(options: SelfHostedAdapterOptions): HostingAdapter {
  const doFetch = options.fetchImpl ?? fetch;

  const notConfigured = <T>(org: string): AdapterResult<T> =>
    err(
      "not_configured",
      `The self-hosted runtime is not configured for organization ${org}. ` +
        `Register a runtime endpoint and token for this organization, or use a configured engine.`,
    );

  const credentialsFor = <T>(
    ctx: AdapterContext,
  ): { ok: true; creds: SelfHostedCredentials } | { ok: false; result: AdapterResult<T> } => {
    const creds = options.credentials(ctx.organizationId);
    if (!creds || creds.baseUrl.trim() === "" || creds.token.trim() === "") {
      return { ok: false, result: notConfigured<T>(ctx.organizationId) };
    }
    return { ok: true, creds };
  };

  const call = <T>(
    ctx: AdapterContext,
    creds: SelfHostedCredentials,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) =>
    request<T>(
      { fetchImpl: doFetch, classify: options.classify },
      {
        method,
        url: `${creds.baseUrl.replace(/\/+$/, "")}${path}`,
        headers: { authorization: `Bearer ${creds.token}` },
        body,
        timeoutMs: ctx.timeoutMs,
      },
    );

  const opRef = (ctx: AdapterContext, id: string, resourceType: string): OperationRef => ({
    jobId: `selfhosted-${resourceType}-${id}` as OperationRef["jobId"],
    providerRef: {
      organizationId: ctx.organizationId,
      provider: ENGINE,
      resourceType,
      resourceId: id,
    },
  });

  /** Translate the runtime's status vocabulary into Cloud Wai's. */
  function mapStatus(raw: string | undefined): DeploymentState["status"] {
    switch ((raw ?? "").toLowerCase()) {
      case "succeeded":
        return "succeeded";
      case "running":
      case "queued":
        return "running";
      case "pending":
        return "pending";
      case "degraded":
        return "degraded";
      case "failed":
        return "failed";
      default:
        return "pending";
    }
  }

  return {
    __engine: "selfhosted" as const,
    async createApplication(ctx, input): Promise<AdapterResult<OperationRef>> {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;
      if (!input.gitRepository && !input.gitBranch) {
        // The runtime can run a bare image, but a project with no git source has
        // nothing to build; that is a caller error, never a success.
        return err(
          "failed",
          "The self-hosted runtime needs a git repository to create an application.",
        );
      }
      const response = await call<{ id?: string; message?: string }>(
        ctx,
        resolved.creds,
        "POST",
        "/apps",
        {
          name: input.name,
          ...(input.gitRepository ? { gitRepository: input.gitRepository } : {}),
          ...(input.gitBranch ? { gitBranch: input.gitBranch } : {}),
          ...(input.buildPack ? { buildPack: input.buildPack } : {}),
          ...(input.rootDirectory ? { rootDirectory: input.rootDirectory } : {}),
        },
      );
      if (!response.ok) return response;
      const id = response.value.value?.id;
      if (!id) return err("degraded", "The runtime created an application but returned no id.");
      return ok("succeeded", opRef(ctx, id, "application"));
    },

    async deploy(ctx, input): Promise<AdapterResult<OperationRef>> {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;
      const id = input.applicationRef.resourceId;
      const response = await call<{ id?: string }>(
        ctx,
        resolved.creds,
        "POST",
        `/apps/${encodeURIComponent(id)}/deploy`,
      );
      if (!response.ok) return response;
      // The deploy is asynchronous: it has been accepted, not finished.
      return ok("running", opRef(ctx, id, "application"));
    },

    async getDeployment(ctx, ref): Promise<AdapterResult<DeploymentState>> {
      const resolved = credentialsFor<DeploymentState>(ctx);
      if (!resolved.ok) return resolved.result;
      const response = await call<RuntimeApp>(
        ctx,
        resolved.creds,
        "GET",
        `/apps/${encodeURIComponent(ref.resourceId)}`,
      );
      if (!response.ok) return response;
      const app = response.value.value ?? {};
      return ok("succeeded", {
        ref,
        status: mapStatus(app.status),
        url: app.url ?? null,
      });
    },

    async cancelDeployment(ctx, ref): Promise<AdapterResult<void>> {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;
      const response = await call<void>(
        ctx,
        resolved.creds,
        "POST",
        `/apps/${encodeURIComponent(ref.resourceId)}/cancel`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async rollback(ctx, input): Promise<AdapterResult<OperationRef>> {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;
      const id = input.applicationRef.resourceId;
      const response = await call<{ message?: string }>(
        ctx,
        resolved.creds,
        "POST",
        `/apps/${encodeURIComponent(id)}/rollback`,
      );
      if (!response.ok) {
        // A rollback with no previous image is a real refusal, not a crash. The
        // HTTP client folds the status into the reason, so a 409 becomes
        // `not_configured` rather than a generic failure.
        return response.reason.includes(" 409")
          ? err(
              "not_configured",
              "The runtime has no previous image for this application to roll back to.",
            )
          : response;
      }
      return ok("running", opRef(ctx, id, "application"));
    },

    async getLogs(ctx, ref, cursor): Promise<AdapterResult<LogPage>> {
      const resolved = credentialsFor<LogPage>(ctx);
      if (!resolved.ok) return resolved.result;
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const response = await call<{ logs?: readonly string[]; nextCursor?: string | null }>(
        ctx,
        resolved.creds,
        "GET",
        `/apps/${encodeURIComponent(ref.resourceId)}/logs${query}`,
      );
      if (!response.ok) return response;
      const value = response.value.value ?? {};
      return ok("succeeded", {
        lines: value.logs ?? [],
        cursor: value.nextCursor ?? null,
      });
    },

    async listEnvVars(ctx, ref): Promise<AdapterResult<readonly EnvVarState[]>> {
      const resolved = credentialsFor<readonly EnvVarState[]>(ctx);
      if (!resolved.ok) return resolved.result;
      const response = await call<{ env?: readonly EnvVarState[] }>(
        ctx,
        resolved.creds,
        "GET",
        `/apps/${encodeURIComponent(ref.resourceId)}/env`,
      );
      if (!response.ok) return response;
      return ok("succeeded", response.value.value?.env ?? []);
    },

    async createEnvVar(ctx, input): Promise<AdapterResult<EnvVarState>> {
      const resolved = credentialsFor<EnvVarState>(ctx);
      if (!resolved.ok) return resolved.result;
      const response = await call<EnvVarState>(
        ctx,
        resolved.creds,
        "POST",
        `/apps/${encodeURIComponent(input.applicationRef.resourceId)}/env`,
        {
          key: input.variable.key,
          value: input.variable.value,
          isBuildTime: input.variable.isBuildTime,
        },
      );
      if (!response.ok) return response;
      const value = response.value.value;
      if (!value)
        return err(
          "degraded",
          "The runtime created an environment variable but returned no record.",
        );
      return ok("succeeded", value);
    },

    async updateEnvVar(ctx, input): Promise<AdapterResult<EnvVarState>> {
      const resolved = credentialsFor<EnvVarState>(ctx);
      if (!resolved.ok) return resolved.result;
      const response = await call<EnvVarState>(
        ctx,
        resolved.creds,
        "PATCH",
        `/apps/${encodeURIComponent(input.applicationRef.resourceId)}/env/${encodeURIComponent(input.variable.key)}`,
        { value: input.variable.value, isBuildTime: input.variable.isBuildTime },
      );
      if (!response.ok) return response;
      const value = response.value.value;
      if (!value)
        return err(
          "degraded",
          "The runtime updated an environment variable but returned no record.",
        );
      return ok("succeeded", value);
    },

    async deleteEnvVar(ctx, input): Promise<AdapterResult<void>> {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;
      const response = await call<void>(
        ctx,
        resolved.creds,
        "DELETE",
        `/apps/${encodeURIComponent(input.applicationRef.resourceId)}/env/${encodeURIComponent(input.engineRef)}`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async deleteApplication(ctx, ref): Promise<AdapterResult<void>> {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;
      const response = await call<void>(
        ctx,
        resolved.creds,
        "DELETE",
        `/apps/${encodeURIComponent(ref.resourceId)}`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async reconcile(ctx, ref): Promise<AdapterResult<DeploymentState>> {
      return this.getDeployment(ctx, ref);
    },

    async setDomains(
      ctx,
      input,
    ): Promise<AdapterResult<{ readonly published: boolean; readonly reason: string | null }>> {
      const resolved = credentialsFor<{ published: boolean; reason: string | null }>(ctx);
      if (!resolved.ok) return resolved.result;
      const response = await call<{
        domains?: readonly string[];
        routeError?: string | null;
      }>(
        ctx,
        resolved.creds,
        "PUT",
        `/apps/${encodeURIComponent(input.applicationRef.resourceId)}/domains`,
        {
          domains: input.hostnames,
        },
      );
      if (!response.ok) return response;
      // The runtime reports its own result: a route it could not publish is
      // surfaced as `published: false` with the runtime's reason, never as a
      // success the hostname does not actually resolve on.
      const routeError = response.value.value?.routeError ?? null;
      return ok("succeeded", { published: routeError === null, reason: routeError });
    },
  };
}
