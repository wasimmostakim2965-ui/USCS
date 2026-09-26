/**
 * The build engine: Git source becomes a deployable artifact.
 *
 * This is the layer Vercel puts at the centre of its architecture — a build
 * container takes the source, runs the framework build, and the output is what
 * the request phase later routes by. It was the one port this platform did not
 * have, which is why a serverless deploy could only ever report `not_configured`
 * for a missing build rather than a missing credential (ADR-0018).
 *
 * Two boundaries this port keeps deliberately:
 *
 * 1. **A build is not a deploy.** A build produces an artifact; a runtime
 *    publishes it. `HostingAdapter` and `ServerlessAdapter` consume the artifact,
 *    and neither of them knows how it was produced. Merging build into either
 *    would force the other to lie about what it does.
 * 2. **The port is engine-agnostic.** Railpack, Cloud Native Buildpacks and
 *    herokuish all speak this contract; the platform never learns which one is
 *    behind it, the same way it never learns Coolify's internals (ADR-0002).
 *
 * Honesty is unchanged: with no builder configured, a build reports
 * `not_configured`. It never invents an artifact.
 */
import type { AdapterResult, OperationRef, ProviderRef } from "@cloud-wai/contracts";
import type { AdapterContext, LogPage, NotConfiguredBrand } from "./index.js";

/**
 * Where a build gets its source.
 *
 * `git` is the only source this build supports today. It is modelled as a union
 * rather than a bare URL so that adding a source (an uploaded tarball, a local
 * directory) is a new variant rather than a breaking change to the shape.
 */
export type BuildSource =
  | {
      readonly kind: "git";
      /** HTTPS or SSH URL. Validated by the adapter before any command runs. */
      readonly repository: string;
      readonly branch?: string | undefined;
      /** A specific commit to build. Omitted means the branch head. */
      readonly commit?: string | undefined;
      /** Monorepo subdirectory, when the project is not at the repository root. */
      readonly rootDirectory?: string | undefined;
    }
  | {
      readonly kind: "image";
      /** A pre-built image: nothing to build, the artifact already exists. */
      readonly uri: string;
    };

/**
 * What a build produced.
 *
 * Mirrors Vercel's output classification: the same build yields static assets,
 * one or more serverless functions, and edge functions, and each is served by a
 * different layer. The artifact records all three so the request phase can route
 * by metadata rather than by re-inspecting the source.
 */
export interface BuildArtifact {
  /** An OCI image a container runtime can pull, when the build produced one. */
  readonly image?: string | undefined;
  /** Static output, staged in object storage for the CDN. */
  readonly staticPrefix?: string | undefined;
  /**
   * Serverless function bundles, keyed by the route they answer.
   *
   * The value is the object-storage key of the bundle, not the bundle itself:
   * an artifact reference stays small enough to store in the deployment record.
   */
  readonly functions?: Readonly<Record<string, string>> | undefined;
  /** Edge function bundles, keyed by route. */
  readonly edgeFunctions?: Readonly<Record<string, string>> | undefined;
  /** The commit actually built, resolved from the branch when it was omitted. */
  readonly resolvedCommit?: string | undefined;
  /**
   * The framework the builder detected, when it detected one.
   *
   * Reported rather than assumed: a `null` here means the builder could not
   * classify the source, which is a fact the dashboard shows instead of
   * guessing "Next.js".
   */
  readonly framework: string | null;
}

export interface BuildRequest {
  readonly source: BuildSource;
  /** The build pack to use, when the project pins one. Omitted means auto-detect. */
  readonly buildPack?: BuildPackName | undefined;
  /** Non-secret build-time environment. Secrets are resolved by the engine, not passed here. */
  readonly environment?: Readonly<Record<string, string>> | undefined;
  /** The command to run, when the project overrides the detected one. */
  readonly buildCommand?: string | undefined;
}

/** The build packs a builder may accept. Mirrors the hosting adapter's own list. */
export const BUILD_PACK_NAMES = ["railpack", "nixpacks", "buildpacks", "dockerfile"] as const;
export type BuildPackName = (typeof BUILD_PACK_NAMES)[number];

/**
 * A build engine.
 *
 * `build` returns an `OperationRef` rather than an artifact: a build is async
 * work, and the same job machinery that runs deployments and backups must run
 * builds too. The artifact is read back with `getArtifact` once the job
 * succeeds, so a slow build does not hold a request open.
 */
export interface BuildEngine extends NotConfiguredBrand {
  build(ctx: AdapterContext, request: BuildRequest): Promise<AdapterResult<OperationRef>>;
  /**
   * The artifact a finished build produced.
   *
   * A build that is still running, failed, or was cancelled has no artifact, and
   * this returns an error rather than an empty artifact — an absent artifact must
   * never be indistinguishable from a successful one with no output.
   */
  getArtifact(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<BuildArtifact>>;
  /** Cancel an in-flight build. A build already finished is left alone. */
  cancelBuild(ctx: AdapterContext, ref: ProviderRef): Promise<AdapterResult<void>>;
  /**
   * Build logs, paginated.
   *
   * The same `LogPage` shape the hosting adapter uses, so the dashboard renders
   * build logs and deployment logs with one component.
   */
  getBuildLogs(
    ctx: AdapterContext,
    ref: ProviderRef,
    cursor?: string,
  ): Promise<AdapterResult<LogPage>>;
}
