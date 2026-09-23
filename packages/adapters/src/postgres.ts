/**
 * PostgreSQL database adapter.
 *
 * Tenant databases are provisioned through Coolify's database API (ADR-0002:
 * `POST /databases/postgresql`, `/databases/{uuid}/backups`,
 * `/databases/{uuid}/backups/{id}/executions`), which is the engine that
 * actually runs them. Cloud Wai never speaks the PostgreSQL wire protocol to a
 * tenant database: it does not hold tenant data-plane credentials, and it has no
 * business issuing SQL.
 *
 * The tenant boundary is the same as the hosting adapter's: one Coolify team per
 * organization, resolved per call.
 */
import {
  err,
  ok,
  type AdapterResult,
  type OperationRef,
  type ProviderRef,
} from "@cloud-wai/contracts";
import type { AdapterContext, DatabaseAdapter } from "./index.js";
import type { CoolifyCredentials } from "./coolify.js";
import { request, type HttpClientOptions } from "./http.js";

const ENGINE: ProviderRef["provider"] = "postgres";

export interface PostgresAdapterOptions extends HttpClientOptions {
  readonly credentials: (
    organizationId: AdapterContext["organizationId"],
  ) => CoolifyCredentials | null;
}

interface CoolifyDatabase {
  readonly uuid?: string;
  readonly name?: string;
  readonly status?: string;
}

/** A backup becomes a `ProviderRef` so a restore names an engine-owned artifact. */
export function backupRef(
  organizationId: AdapterContext["organizationId"],
  databaseUuid: string,
  backupUuid: string,
): ProviderRef {
  return {
    organizationId,
    provider: ENGINE,
    resourceType: "backup",
    resourceId: `${databaseUuid}/${backupUuid}`,
  };
}

export function createPostgresDatabase(options: PostgresAdapterOptions): DatabaseAdapter {
  const doFetch = options.fetchImpl ?? fetch;

  const credentialsFor = <T>(
    ctx: AdapterContext,
  ): { ok: true; creds: CoolifyCredentials } | { ok: false; result: AdapterResult<T> } => {
    const creds = options.credentials(ctx.organizationId);
    if (!creds || creds.baseUrl.trim() === "" || creds.token.trim() === "") {
      return {
        ok: false,
        result: err(
          "not_configured",
          `The database engine is not configured for organization ${ctx.organizationId}. Provision a team token for this organization.`,
        ),
      };
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

  const dbPath = (uuid: string) => `/api/v1/databases/${encodeURIComponent(uuid)}`;

  return {
    async provision(ctx, input) {
      const resolved = credentialsFor<ProviderRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<CoolifyDatabase>(
        ctx,
        resolved.creds,
        "POST",
        "/api/v1/databases/postgresql",
        {
          name: input.name,
        },
      );
      if (!response.ok) return response;

      const uuid = response.value.value?.uuid;
      if (!uuid)
        return err("degraded", "The database engine created a database but returned no uuid.");
      return ok("succeeded", {
        organizationId: ctx.organizationId,
        provider: ENGINE,
        resourceType: "database",
        resourceId: uuid,
      });
    },

    /**
     * Rotate credentials.
     *
     * The engine returns the new password once. It is deliberately not returned
     * to the caller: this adapter hands it to the engine's own store and the
     * control plane keeps no copy. Returning it would put a tenant credential in
     * an API response and every log along the way.
     */
    async rotateCredentials(ctx, ref) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "POST",
        `${dbPath(ref.resourceId)}/rotate-credentials`,
      );
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async backup(ctx, ref) {
      const resolved = credentialsFor<ProviderRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<CoolifyDatabase & { backups?: { uuid?: string }[] }>(
        ctx,
        resolved.creds,
        "POST",
        `${dbPath(ref.resourceId)}/backups`,
      );
      if (!response.ok) return response;

      const backupUuid = response.value.value?.uuid;
      if (!backupUuid) {
        return err("degraded", "The database engine accepted a backup but returned no backup id.");
      }
      return ok("succeeded", backupRef(ctx.organizationId, ref.resourceId, backupUuid));
    },

    async restore(ctx, input) {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;

      // The backup ref is `<databaseUuid>/<backupUuid>`; both come from the
      // engine, and both are re-checked against this tenant by the engine's team
      // token rather than trusted from the caller.
      const [databaseUuid, backupUuid] = input.backupRef.resourceId.split("/");
      if (!databaseUuid || !backupUuid) {
        return err("failed", "A backup reference must name a database and a backup.");
      }

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "POST",
        `${dbPath(encodeURIComponent(databaseUuid))}/backups/${encodeURIComponent(backupUuid)}/executions`,
      );
      if (!response.ok) return response;

      return ok("succeeded", {
        jobId: `restore-${input.backupRef.resourceId}` as OperationRef["jobId"],
        providerRef: input.targetRef,
      });
    },

    async destroy(ctx, ref) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<unknown>(ctx, resolved.creds, "DELETE", dbPath(ref.resourceId));
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },
  };
}
