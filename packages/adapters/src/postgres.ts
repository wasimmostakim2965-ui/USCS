/**
 * PostgreSQL database adapter.
 *
 * Tenant databases are provisioned through Coolify's database API (ADR-0002),
 * which is the engine that actually runs them. Cloud Wai never speaks the
 * PostgreSQL wire protocol to a tenant database: it does not hold tenant
 * data-plane credentials, and it has no business issuing SQL (ADR-0011, which
 * the owner reaffirmed as Option A).
 *
 * Every route here is checked against the pinned upstream route table
 * (`tests/fixtures/coolify-routes.json`) by `tests/engines/coolify-routes.test.ts`.
 * That test found real divergences this file used to carry — a
 * `rotate-credentials` route and a `POST /backups/{id}/executions` route, neither
 * of which Coolify exposes. They are replaced by the operations that do exist:
 * credential rotation is a `PATCH /databases/{uuid}` that writes a new password
 * (the engine persists it and never returns it), and a restore is a
 * `POST /databases/{uuid}/imports` naming an engine-side backup file. The pinned
 * upstream routes are the source of truth, not the shape this adapter assumed.
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
  /**
   * Mint the replacement password for a credential rotation.
   *
   * Coolify's `PATCH /databases/{uuid}` accepts a `postgres_password` and stores
   * it; the engine never returns it, so the control plane has to choose one. It
   * is generated here and immediately handed to the engine — it is never
   * returned to the caller, logged, or kept by Cloud Wai. Injected so a test can
   * pin it, and so the deployment can use its own entropy source.
   */
  readonly newPassword?: (() => string) | undefined;
}

interface CoolifyDatabase {
  readonly uuid?: string;
  readonly name?: string;
  readonly status?: string;
}

/**
 * Coolify's own password grammar (`ValidationPatterns::DB_PASSWORD_PATTERN`).
 *
 * A rotation that produced a value outside it would be rejected 422, so the
 * generator draws only from this alphabet.
 */
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*()_+-=";
const PASSWORD_LENGTH = 40;

/** A password the engine will accept. Not cryptographic on its own: see below. */
export function generateDatabasePassword(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    out += PASSWORD_ALPHABET[Math.floor(random() * PASSWORD_ALPHABET.length)] ?? "a";
  }
  return out;
}

/**
 * A backup becomes a `ProviderRef` so a restore names an engine-owned artifact.
 *
 * `resourceId` is `<databaseUuid>/<executionUuid>` for a recorded backup
 * execution. The engine's restore is addressed by the backup *file path*, which
 * the control plane reads from the execution record when it performs the
 * restore, so the ref carries the identity the engine can resolve.
 */
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
    method: "GET" | "POST" | "PATCH" | "DELETE",
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

  /**
   * The create request's mandatory placement fields.
   *
   * Coolify requires `project_uuid`, `server_uuid` and one of
   * `environment_name`/`environment_uuid` (checked in the pinned
   * `DatabasesController::create_database`). A credential record without them
   * cannot create a database, so this reports `not_configured` with the missing
   * field named rather than sending a body the engine answers 422 to.
   */
  const placementFrom = (
    creds: CoolifyCredentials,
  ):
    | { ok: true; body: Record<string, string | boolean> }
    | { ok: false; reason: string } => {
    const projectUuid = creds.projectUuid?.trim();
    const serverUuid = creds.serverUuid?.trim();
    const environmentName = creds.environmentName?.trim();
    const environmentUuid = creds.environmentUuid?.trim();
    const missing: string[] = [];
    if (!projectUuid) missing.push("COOLIFY_PROJECT_UUID__<org>");
    if (!serverUuid) missing.push("COOLIFY_SERVER_UUID__<org>");
    if (!environmentName && !environmentUuid) {
      missing.push("COOLIFY_ENVIRONMENT_NAME__<org> (or COOLIFY_ENVIRONMENT_UUID__<org>)");
    }
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `The database engine is configured but cannot place a database: ${missing.join(", ")} is unset.`,
      };
    }
    const body: Record<string, string | boolean> = {
      project_uuid: projectUuid!,
      server_uuid: serverUuid!,
      instant_deploy: true,
    };
    if (environmentUuid) body.environment_uuid = environmentUuid;
    if (environmentName) body.environment_name = environmentName;
    const destinationUuid = creds.destinationUuid?.trim();
    if (destinationUuid) body.destination_uuid = destinationUuid;
    return { ok: true, body };
  };

  interface CoolifyExecution {
    readonly uuid?: string;
    readonly filename?: string | null;
    readonly status?: string;
  }

  /**
   * The newest backup execution that names a real file.
   *
   * A scheduled backup's executions are listed under the config uuid; only a
   * `successful` one with a `filename` is restorable, so the newest such record
   * is the one a restore addresses. Returning null is honest: the backup has not
   * produced a restorable artifact yet.
   */
  const latestBackupFile = async (
    ctx: AdapterContext,
    creds: CoolifyCredentials,
    databaseUuid: string,
    configUuid: string,
  ): Promise<{ ok: true; filename: string } | { ok: false; result: AdapterResult<never> }> => {
    const response = await call<{ executions?: readonly CoolifyExecution[] }>(
      ctx,
      creds,
      "GET",
      `${dbPath(databaseUuid)}/backups/${encodeURIComponent(configUuid)}/executions`,
    );
    if (!response.ok) return { ok: false, result: response };
    const executions = response.value.value?.executions ?? [];
    const withFile = executions.find((e) => e.filename && e.filename.trim() !== "");
    if (!withFile?.filename) {
      return {
        ok: false,
        result: err(
          "degraded",
          "The engine has no restorable backup file for this database yet.",
        ),
      };
    }
    return { ok: true, filename: withFile.filename };
  };

  return {
    async provision(ctx, input) {
      const resolved = credentialsFor<ProviderRef>(ctx);
      if (!resolved.ok) return resolved.result;
      const placement = placementFrom(resolved.creds);
      if (!placement.ok) {
        return err("not_configured", placement.reason);
      }

      const response = await call<CoolifyDatabase>(
        ctx,
        resolved.creds,
        "POST",
        "/api/v1/databases/postgresql",
        {
          name: input.name,
          ...placement.body,
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
     * Coolify has no rotate route; `PATCH /databases/{uuid}` writes
     * `postgres_password`. The adapter mints a compliant password, hands it to
     * the engine, and deliberately does not return it: the engine persists it
     * and the control plane keeps no copy, so a tenant credential never reaches
     * an API response or a log line. A rotation whose password was *returned*
     * would be the leak this avoids.
     */
    async rotateCredentials(ctx, ref) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      const password = (options.newPassword ?? generateDatabasePassword)();
      const response = await call<unknown>(ctx, resolved.creds, "PATCH", dbPath(ref.resourceId), {
        postgres_password: password,
      });
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    /**
     * Take a backup.
     *
     * Coolify's `POST /databases/{uuid}/backups` creates a *scheduled* backup
     * configuration and, with `backup_now: true`, dispatches one immediately. The
     * response names the config uuid, which is what a restore reads executions
     * from, so that uuid is what the returned reference carries.
     */
    async backup(ctx, ref) {
      const resolved = credentialsFor<ProviderRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const response = await call<{ uuid?: string }>(
        ctx,
        resolved.creds,
        "POST",
        `${dbPath(ref.resourceId)}/backups`,
        { frequency: "0 3 * * *", enabled: true, dump_all: true, backup_now: true },
      );
      if (!response.ok) return response;

      const configUuid = response.value.value?.uuid;
      if (!configUuid) {
        return err("degraded", "The database engine accepted a backup but returned no backup id.");
      }
      return ok("succeeded", backupRef(ctx.organizationId, ref.resourceId, configUuid));
    },

    /**
     * Restore from a backup.
     *
     * Coolify restores by importing a backup *file*: `POST /databases/{uuid}/imports`
     * with `source: 'server'` and the engine-side `path`. The path is not in the
     * backup reference, so it is read from the configuration's newest execution
     * — the engine's own record of where the dump landed. A backup that has not
     * produced a file yet is refused honestly rather than reported as restored.
     */
    async restore(ctx, input) {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const [databaseUuid, configUuid] = input.backupRef.resourceId.split("/");
      if (!databaseUuid || !configUuid) {
        return err("failed", "A backup reference must name a database and a backup.");
      }

      const file = await latestBackupFile(ctx, resolved.creds, databaseUuid, configUuid);
      if (!file.ok) return file.result;

      const response = await call<unknown>(
        ctx,
        resolved.creds,
        "POST",
        `${dbPath(databaseUuid)}/imports`,
        { source: "server", path: file.filename, dump_all: true, replace_existing: true },
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
