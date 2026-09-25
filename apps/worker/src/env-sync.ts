/**
 * The worker's environment reconciliation: make the engine match what is stored.
 *
 * A customer can save a variable before their project has an application — they
 * configure the project, then deploy. The API stores it (honestly reporting that
 * the engine has not been reached yet); this is the step that pushes it once the
 * application exists. It runs before the build, so a pre-deploy variable is part
 * of the first build rather than silently missing from it.
 *
 * It reconciles, it does not overwrite blindly: what the control plane stores is
 * the source of truth for the keys it knows about, and the engine's own list is
 * read first so a variable the platform did not create (an engine default) is
 * left alone. A create that collides with an existing key becomes an update,
 * which is the one shape Coolify's routes require.
 *
 * A failure never fails the deployment. The build is the customer's work and it
 * has already been asked for; an env push that could not run is a configuration
 * problem the env page reports, not a reason to discard a build the engine made.
 */
import type { EnvVarState, HostingAdapter } from "@cloud-wai/adapters";
import type { OrganizationId, ProviderRef } from "@cloud-wai/contracts";
import type { SecretCipher } from "@cloud-wai/auth";

/** The two store reads this needs, and no more. */
export interface EnvSyncStore {
  readonly listEnvVarsForService: (
    organizationId: OrganizationId,
    projectId: string,
  ) => Promise<
    readonly {
      readonly key: string;
      readonly valueEncrypted: string;
      readonly isBuildTime: boolean;
    }[]
  >;
  readonly setEnvVarEngineRef: (input: {
    readonly organizationId: OrganizationId;
    readonly projectId: string;
    readonly key: string;
    readonly engineRef: string;
    readonly provider: string | null;
    readonly providerResourceId: string | null;
  }) => Promise<unknown>;
}

export interface EnvSyncDeps {
  readonly hosting: HostingAdapter;
  readonly store: EnvSyncStore;
  readonly cipher: SecretCipher | null;
}

/**
 * Build the reconciler a deployment calls before it builds.
 *
 * Returns null when there is no cipher: with no key to decrypt the stored
 * values, there is nothing this step can honestly do, and a null port means
 * "not configured" rather than "ran and found nothing".
 */
export function buildEnvVarSync(deps: EnvSyncDeps): {
  sync(
    ctx: { organizationId: OrganizationId; idempotencyKey: string; timeoutMs: number },
    applicationRef: ProviderRef,
    projectId: string,
  ): Promise<void>;
} | null {
  if (!deps.cipher) return null;
  const cipher = deps.cipher;

  return {
    async sync(ctx, applicationRef, projectId): Promise<void> {
      const stored = await deps.store.listEnvVarsForService(ctx.organizationId, projectId);
      if (stored.length === 0) return;

      const existing = await deps.hosting.listEnvVars(ctx, applicationRef);
      // An engine that cannot be listed is not an engine to blind-write. Leave
      // the deploy to proceed; the variables are already safe in the table.
      if (!existing.ok) return;
      const byKey = new Map(existing.value.map((item: EnvVarState) => [item.key, item]));

      for (const variable of stored) {
        const value = cipher.decrypt(variable.valueEncrypted);
        // A row that will not decrypt (a rotated key, a tampered value) is
        // skipped, never written as garbage. The env page reports it by its
        // unchanged state; the build still runs with the engine's current value.
        if (value === null) continue;

        const present = byKey.get(variable.key);
        const result = present
          ? await deps.hosting.updateEnvVar(ctx, {
              applicationRef,
              variable: { key: variable.key, value, isBuildTime: variable.isBuildTime },
            })
          : await deps.hosting.createEnvVar(ctx, {
              applicationRef,
              variable: { key: variable.key, value, isBuildTime: variable.isBuildTime },
            });
        if (result.ok) {
          await deps.store.setEnvVarEngineRef({
            organizationId: ctx.organizationId,
            projectId,
            key: variable.key,
            engineRef: result.value.engineRef ?? "",
            provider: applicationRef.provider,
            providerResourceId: applicationRef.resourceId,
          });
        }
        // A failed write leaves the stored row as it is; the next deploy retries.
      }
    },
  };
}
