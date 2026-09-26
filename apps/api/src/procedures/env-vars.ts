/**
 * Project environment variables (matrix P13 / audit D5).
 *
 * This is the request-path half of the feature. It stores configuration as
 * data — encrypted at rest, key-visible to a member, value-secret — and pushes
 * it into the hosting engine through `packages/adapters`, so a customer never
 * edits Coolify by hand. The rules it keeps:
 *
 *   * **The value is encrypted by the API and never returned.** `SecretCipher`
 *     (AES-256-GCM) produces the ciphertext; the store never holds a plaintext
 *     value, the table's client SELECT grant excludes `value_encrypted`, and no
 *     procedure here returns one. A list names keys, not secrets.
 *   * **No key means no variable.** With `CLOUD_WAI_SECRET_ENCRYPTION_KEY`
 *     unset, setting a variable answers `engine_unavailable` rather than
 *     storing a plaintext value — the same rule `git.connect` follows.
 *   * **A build-time change is a deployment, not a silent edit.** `is_build_time`
 *     decides whether the running output changed; the page expresses a
 *     build-time save as a redeploy request, and this module reports which
 *     happened rather than pretending a live process reloaded itself.
 *   * **The engine is written through the adapter only.** This module never
 *     imports Coolify; it calls `deps.engines.hosting`. An engine with no
 *     credentials leaves the variable stored and reports `not_configured`, never
 *     a false success.
 */
import { requireCapability } from "../guard.js";
import { ApiError } from "../errors.js";
import type { Engines } from "@cloud-wai/adapters";
import type { ControlPlaneWrites, DataStore, Project, ProjectEnvVar } from "@cloud-wai/database";
import type { OrganizationId, ProjectId, ProviderRef } from "@cloud-wai/contracts";
import type { SecretCipher } from "@cloud-wai/auth";
import { valueFingerprint } from "@cloud-wai/auth";
import type { RequestContext } from "../context.js";

/** A hosting operation is bounded; a hung engine must not hang a request. */
const ADAPTER_TIMEOUT_MS = 30_000;

/** The hosting engine this build wires (ADR-0002: Coolify behind HostingAdapter). */
const HOSTING_PROVIDER = "coolify";

/**
 * The key shape Coolify accepts and the table check constraint enforces.
 *
 * Kept identical to the SQL regex on purpose: if they disagreed, a key the API
 * accepted would be rejected by the database (or vice versa) and the failure
 * would look like a database fault rather than a validation rule.
 */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/** A value is a customer string, bounded so it cannot become a payload store. */
const MAX_VALUE_BYTES = 65_536;

type EnvVarWrites = Pick<
  ControlPlaneWrites,
  | "saveEnvVar"
  | "setEnvVarEngineRef"
  | "getEnvVarEngineRef"
  | "deleteEnvVar"
  | "getProjectDeploymentTarget"
>;

const REQUIRED_WRITES = [
  "saveEnvVar",
  "setEnvVarEngineRef",
  "getEnvVarEngineRef",
  "deleteEnvVar",
  "getProjectDeploymentTarget",
] as const satisfies readonly (keyof ControlPlaneWrites)[];

export interface EnvVarDeps {
  readonly store: DataStore & Partial<ControlPlaneWrites>;
  readonly engines: Engines;
  /** Injected so a variable gets a Cloud Wai UUID, not a provider artifact. */
  readonly newId: () => string;
  /** The cipher for a value. Null means "not configured". */
  readonly cipher: SecretCipher | null;
  readonly now?: () => Date;
}

function writesFor(deps: EnvVarDeps): EnvVarWrites {
  const store = deps.store;
  const missing = REQUIRED_WRITES.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    throw new ApiError(
      "engine_unavailable",
      `This deployment cannot record ${missing.join(", ")} yet.`,
    );
  }
  return store as unknown as EnvVarWrites;
}

/** Normalise a key to the engine's shape, or refuse. Case is the customer's. */
function normaliseKey(value: string): string {
  const key = value.trim().toUpperCase();
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError(
      "invalid_input",
      "A variable name must start with a letter and contain only letters, digits and underscores (max 128).",
    );
  }
  return key;
}

function checkValue(value: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    throw new ApiError("invalid_input", "A variable value may not exceed 64 KiB.");
  }
  return value;
}

/**
 * The engine-side application a variable belongs to, or null.
 *
 * Environment variables live on the *application*, so a project that has never
 * deployed has nowhere to push them. This resolves the project's production
 * application through the same target the deploy path uses; a project with none
 * leaves the variable stored and reports honestly rather than inventing a ref.
 */
async function applicationRefFor(
  deps: EnvVarDeps,
  userId: string,
  project: Project,
): Promise<ProviderRef | null> {
  const target = await writesFor(deps).getProjectDeploymentTarget(userId as never, project.id);
  if (!target?.providerResourceId) return null;
  return {
    organizationId: project.organizationId,
    provider: (target.provider ?? HOSTING_PROVIDER) as ProviderRef["provider"],
    resourceType: "application",
    resourceId: target.providerResourceId,
  };
}

export interface ListEnvVarsInput {
  readonly projectId: ProjectId;
}

/** A project's environment variables. Never includes a value. */
export async function listEnvVars(
  ctx: RequestContext,
  deps: EnvVarDeps,
  input: ListEnvVarsInput,
): Promise<readonly ProjectEnvVar[]> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "project:read");
  return deps.store.listEnvVars(ctx.principal.userId, project.id);
}

export interface SetEnvVarInput {
  readonly projectId: ProjectId;
  readonly key: string;
  readonly value: string;
  readonly isBuildTime?: boolean | undefined;
}

/**
 * The outcome of setting a variable.
 *
 * `applied: "engine"` means the adapter confirmed the write and the engine
 * reference was recorded. `applied: "stored"` means the variable is saved but
 * the engine could not be reached (no application yet, or no credentials) — the
 * value is not lost, and the page says so. `redeployRequired` is true when the
 * variable is build-time, because a build-time change only takes effect on the
 * next build; that is a fact about the engine, not a choice of the UI.
 */
export interface SetEnvVarOutcome {
  readonly variable: ProjectEnvVar;
  readonly applied: "engine" | "stored";
  readonly redeployRequired: boolean;
  /** The engine's own words when it could not be written, for an honest UI. */
  readonly engineReason: string | null;
}

/**
 * Set or replace one environment variable.
 *
 * The secret is encrypted before it reaches the store, so this path is the only
 * place a plaintext value exists and it exists for one call. The engine write is
 * attempted after the row is saved: a value is never lost because an engine was
 * briefly unreachable, and the caller is told exactly which half happened.
 */
export async function setEnvVar(
  ctx: RequestContext,
  deps: EnvVarDeps,
  input: SetEnvVarInput,
): Promise<SetEnvVarOutcome> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "project:update");

  if (!deps.cipher) {
    // No key: refuse rather than store anything. An unencrypted value in the
    // control plane is the failure this branch exists to prevent.
    throw new ApiError(
      "engine_unavailable",
      "Set CLOUD_WAI_SECRET_ENCRYPTION_KEY to store environment variables for this project.",
    );
  }

  const key = normaliseKey(input.key);
  const value = checkValue(input.value);
  const isBuildTime = input.isBuildTime ?? true;

  const writes = writesFor(deps);
  const variable = await writes.saveEnvVar({
    id: deps.newId(),
    organizationId: project.organizationId,
    projectId: project.id,
    key,
    valueEncrypted: deps.cipher.encrypt(value),
    valuePrefix: valueFingerprint(value),
    isBuildTime,
    updatedBy: ctx.principal.userId,
  });

  const ref = await applicationRefFor(deps, ctx.principal.userId, project);
  let applied: "engine" | "stored" = "stored";
  let engineReason: string | null = null;
  if (ref) {
    const result = await deps.engines.hosting.createEnvVar(
      {
        organizationId: project.organizationId,
        idempotencyKey: `env-${project.id}-${key}`,
        timeoutMs: ADAPTER_TIMEOUT_MS,
      },
      { applicationRef: ref, variable: { key, value, isBuildTime } },
    );
    if (result.ok) {
      applied = "engine";
      await writes.setEnvVarEngineRef({
        organizationId: project.organizationId,
        projectId: project.id,
        key,
        engineRef: result.value.engineRef ?? "",
        provider: ref.provider,
        providerResourceId: ref.resourceId,
      });
    } else {
      // The engine refused or is unconfigured. The row stays, and the reason is
      // reported — never a success that did not happen.
      engineReason = result.reason;
    }
  } else {
    engineReason =
      "This project has no application on the hosting engine yet, so the variable is stored but not yet applied.";
  }

  await deps.store.recordAuditEvent({
    organizationId: project.organizationId,
    actorId: ctx.principal.userId,
    actorEmail: ctx.principal.email,
    event: "env.set",
    targetType: "project_env_var",
    targetId: variable.id,
    // The value is deliberately absent: an audit row is readable by every
    // member, and a value in it would be a secret published to the tenant.
    metadata: { projectId: project.id, key, isBuildTime, applied },
  });

  return {
    variable,
    applied,
    // A build-time variable only changes the built output, so a save of one is a
    // redeploy request; a runtime-only variable does not need one.
    redeployRequired: isBuildTime,
    engineReason,
  };
}

export interface RemoveEnvVarInput {
  readonly projectId: ProjectId;
  readonly key: string;
}

export interface RemoveEnvVarOutcome {
  readonly removed: boolean;
  /** The engine's own words when the engine deletion could not be done. */
  readonly engineReason: string | null;
}

/**
 * Remove one environment variable.
 *
 * The engine's copy is deleted first, using the handle recorded from the last
 * write; then the row. That order means a failure leaves a variable the customer
 * can still see and retry, rather than an invisible engine variable still fed to
 * a build. A variable that never reached the engine has no handle, so only the
 * row is removed.
 */
export async function removeEnvVar(
  ctx: RequestContext,
  deps: EnvVarDeps,
  input: RemoveEnvVarInput,
): Promise<RemoveEnvVarOutcome> {
  const project = await deps.store.getProject(ctx.principal.userId, input.projectId);
  if (!project) throw new ApiError("not_found", "Project not found.");
  requireCapability(ctx, project.organizationId, "project:update");

  const key = normaliseKey(input.key);
  const writes = writesFor(deps);

  const existing = (await deps.store.listEnvVars(ctx.principal.userId, project.id)).find(
    (item) => item.key === key,
  );
  if (!existing) {
    // Removing an absent variable is not an error; it is already gone.
    return { removed: false, engineReason: null };
  }

  const ref = await applicationRefFor(deps, ctx.principal.userId, project);
  let engineReason: string | null = null;
  if (ref) {
    const engineRef = await writes.getEnvVarEngineRef(
      ctx.principal.userId,
      project.organizationId,
      project.id,
      key,
    );
    if (engineRef) {
      const result = await deps.engines.hosting.deleteEnvVar(
        {
          organizationId: project.organizationId,
          idempotencyKey: `env-del-${project.id}-${key}`,
          timeoutMs: ADAPTER_TIMEOUT_MS,
        },
        { applicationRef: ref, engineRef },
      );
      if (!result.ok) {
        // The engine refused: keep the row so the customer can retry, and report
        // why. Removing the row now would orphan a live engine variable.
        return { removed: false, engineReason: result.reason };
      }
    }
  }

  const removed = await writes.deleteEnvVar(
    ctx.principal.userId,
    project.organizationId,
    project.id,
    key,
  );

  if (removed) {
    await deps.store.recordAuditEvent({
      organizationId: project.organizationId,
      actorId: ctx.principal.userId,
      actorEmail: ctx.principal.email,
      event: "env.removed",
      targetType: "project_env_var",
      targetId: existing.id,
      metadata: { projectId: project.id, key },
    });
  }
  return { removed, engineReason };
}
