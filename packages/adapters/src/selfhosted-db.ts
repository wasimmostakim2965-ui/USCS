/**
 * Self-hosted PostgreSQL database adapter.
 *
 * Coolify provisions tenant databases when a host rents Coolify
 * (`postgres.ts`). A host that owns its container engine — the same host that
 * runs `runtime-server.mjs` for hosting — owns its databases too, and this
 * adapter is the port to `postgres-server.mjs` on that host.
 *
 * It is a sibling of `selfhosted.ts` (hosting), not a variant of `postgres.ts`:
 * the two engines expose different routes, so sharing one adapter would mean one
 * of them lying about the other's API. What they *do* share is the honesty rule:
 * every call returns the engine's own answer, and a credential rotation's
 * password is handed to the engine and never returned, logged or kept.
 *
 * Cloud Wai still never opens the tenant database (ADR-0011): this adapter
 * provisions, backs up, restores and reads the container log. It does not issue
 * SQL.
 */
import { randomBytes } from "node:crypto";
import {
  err,
  ok,
  type AdapterResult,
  type OperationRef,
  type ProviderRef,
} from "@cloud-wai/contracts";
import type { AdapterContext, DatabaseAdapter, LogPage } from "./index.js";
import { request, type HttpClientOptions } from "./http.js";

const ENGINE: ProviderRef["provider"] = "postgres";

/** A token scoped to one organization's databases on that engine. */
export interface SelfHostedDatabaseCredentials {
  readonly baseUrl: string;
  readonly token: string;
}

export interface SelfHostedDatabaseOptions extends HttpClientOptions {
  readonly credentials: (
    organizationId: AdapterContext["organizationId"],
  ) => SelfHostedDatabaseCredentials | null;
  /**
   * Mint the replacement password for a credential rotation. The engine stores
   * it and never returns it, so the control plane chooses one here and hands it
   * straight to the engine; it is never returned to the caller or logged.
   */
  readonly newPassword?: (() => string) | undefined;
}

interface EngineDatabase {
  readonly id?: string;
  readonly name?: string;
  readonly host?: string;
  readonly port?: number;
  readonly database?: string;
  readonly user?: string;
}

interface EngineExecution {
  readonly uuid?: string;
  readonly filename?: string | null;
  readonly status?: string;
}

export function createSelfHostedDatabase(options: SelfHostedDatabaseOptions): DatabaseAdapter {
  const doFetch = options.fetchImpl ?? fetch;

  const credentialsFor = <T>(
    ctx: AdapterContext,
  ):
    | { ok: true; creds: SelfHostedDatabaseCredentials }
    | { ok: false; result: AdapterResult<T> } => {
    const creds = options.credentials(ctx.organizationId);
    if (!creds || creds.baseUrl.trim() === "" || creds.token.trim() === "") {
      return {
        ok: false,
        result: err(
          "not_configured",
          `The self-hosted database engine is not configured for organization ${ctx.organizationId}. ` +
            `Register a database-engine endpoint and token for this organization.`,
        ),
      };
    }
    return { ok: true, creds };
  };

  const call = <T>(
    ctx: AdapterContext,
    creds: SelfHostedDatabaseCredentials,
    method: "GET" | "POST" | "PATCH" | "DELETE",
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

  const dbPath = (id: string) => `/databases/${encodeURIComponent(id)}`;

  const backupRef = (
    organizationId: AdapterContext["organizationId"],
    databaseId: string,
    backupId: string,
  ): ProviderRef => ({
    organizationId,
    provider: ENGINE,
    resourceType: "backup",
    resourceId: `${databaseId}/${backupId}`,
  });

  /**
   * The engine-side file path for a backup config, read from the engine's own
   * executions. A backup that has produced no file yet is refused honestly
   * rather than reported as restorable.
   */
  const backupPath = async (
    ctx: AdapterContext,
    creds: SelfHostedDatabaseCredentials,
    databaseId: string,
    backupId: string,
  ): Promise<{ ok: true; filename: string } | { ok: false; result: AdapterResult<never> }> => {
    const response = await call<{ executions?: readonly EngineExecution[] }>(
      ctx,
      creds,
      "GET",
      `${dbPath(databaseId)}/backups/${encodeURIComponent(backupId)}/executions`,
    );
    if (!response.ok) return { ok: false, result: response };
    const executions = response.value.value?.executions ?? [];
    const withFile = executions.find((e) => e.filename && e.filename.trim() !== "");
    if (!withFile?.filename) {
      return {
        ok: false,
        result: err("degraded", "The engine has no restorable backup file for this database yet."),
      };
    }
    return { ok: true, filename: withFile.filename };
  };

  return {
    __engine: "postgres",

    async provision(ctx, input) {
      const resolved = credentialsFor<ProviderRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<EngineDatabase>(ctx, resolved.creds, "POST", "/databases", {
        name: input.name,
      });
      if (!response.ok) return response;

      const id = response.value.value?.id;
      if (!id) {
        return err("degraded", "The database engine created a database but returned no id.");
      }
      return ok("succeeded", {
        organizationId: ctx.organizationId,
        provider: ENGINE,
        resourceType: "database",
        resourceId: id,
      });
    },

    async rotateCredentials(ctx, ref) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const password = (options.newPassword ?? defaultPassword)();
      const response = await call<unknown>(ctx, resolved.creds, "PATCH", dbPath(ref.resourceId), {
        postgres_password: password,
      });
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    async backup(ctx, ref) {
      const resolved = credentialsFor<ProviderRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<{ uuid?: string }>(
        ctx,
        resolved.creds,
        "POST",
        `${dbPath(ref.resourceId)}/backups`,
      );
      if (!response.ok) return response;

      const backupId = response.value.value?.uuid;
      if (!backupId) {
        return err("degraded", "The database engine accepted a backup but returned no backup id.");
      }
      return ok("succeeded", backupRef(ctx.organizationId, ref.resourceId, backupId));
    },

    async restore(ctx, input) {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const [databaseId, backupId] = input.backupRef.resourceId.split("/");
      if (!databaseId || !backupId) {
        return err("failed", "A backup reference must name a database and a backup.");
      }

      const file = await backupPath(ctx, resolved.creds, databaseId, backupId);
      if (!file.ok) return file.result;

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "POST",
        `${dbPath(databaseId)}/imports`,
        { path: file.filename },
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

    async getLogs(ctx, ref) {
      const resolved = credentialsFor<LogPage>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<{ logs?: string }>(
        ctx,
        resolved.creds,
        "GET",
        `${dbPath(ref.resourceId)}/logs?lines=100`,
      );
      if (!response.ok) return response;

      const body = response.value.value ?? {};
      return ok("succeeded", {
        lines: body.logs ? body.logs.split("\n") : [],
        cursor: null,
      });
    },
  };
}

/** A password the engine's SQL grammar accepts, minted by the control plane. */
function defaultPassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (const byte of randomBytes(24)) out += alphabet[byte % alphabet.length];
  return `cw${out}`;
}
