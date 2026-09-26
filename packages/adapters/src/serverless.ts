/**
 * Serverless execution adapter (AWS Lambda).
 *
 * The architectural point of this engine: a workload whose provider is `lambda`
 * does not run on the container host at all. The edge forwards to a serverless
 * function, so there is no always-on origin with a private IP for an attacker to
 * find — the origin-isolation property becomes structural rather than a firewall
 * rule. That is why serverless is a distinct provider and a distinct adapter,
 * not a Coolify build pack (ADR-0017).
 *
 * Three honest limits are built into the shape rather than hidden:
 *
 *   * **Lambda does not build from git.** A serverless deploy needs a *built*
 *     artifact — a zip in S3 or an image in ECR. `deploy` requires one and
 *     refuses otherwise; it never claims a build it did not run. The build step
 *     (CodeBuild) is a separate engine and stays `not_configured` until it is
 *     wired, so the gap is visible instead of faked.
 *   * **Every call is signed with SigV4** (`aws-signature.ts`), pinned against
 *     AWS's published test vector. An unsigned call would be a 403 that we
 *     misreported as a deployment failure.
 *   * **Credentials are per organization** and resolved per call, so one
 *     tenant's function is unreachable with another tenant's credentials — the
 *     same tenant boundary the Coolify adapter keeps.
 *
 * The Lambda routes here are the documented REST API paths for the management
 * plane (`2015-03-31/functions`, function URL configs at `2021-10-31`), and log
 * reads go to the CloudWatch Logs `FilterLogEvents` target. They are checked
 * against `tests/fixtures/lambda-routes.json` by `tests/engines/lambda-routes.test.ts`.
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
  CreateFunctionInput,
  DeploymentState,
  LogPage,
  ServerlessAdapter,
  ServerlessArtifact,
} from "./index.js";
import { request, type HttpClientOptions } from "./http.js";
import { signSigV4Request, type SigV4Credentials } from "./aws-signature.js";

const ENGINE: ProviderRef["provider"] = "lambda";

export interface LambdaCredentials extends SigV4Credentials {
  /** e.g. `us-east-1`. Part of the signing scope, not optional. */
  readonly region: string;
  /**
   * The account's execution-role ARN for functions created without one.
   *
   * A Lambda function cannot be created without an IAM role, so this belongs to
   * the tenant's credential record the way Coolify's project/server do.
   */
  readonly executionRoleArn?: string | undefined;
}

export interface LambdaAdapterOptions extends HttpClientOptions {
  readonly credentials: (
    organizationId: AdapterContext["organizationId"],
  ) => LambdaCredentials | null;
  /** Override for tests and regions with a non-default endpoint. */
  readonly endpointFor?: ((region: string) => string) | undefined;
  /** Injectable clock so signature tests are deterministic. */
  readonly now?: (() => Date) | undefined;
}

/** The Lambda management endpoint for a region. */
function lambdaEndpoint(region: string): string {
  return `https://lambda.${region}.amazonaws.com`;
}

/** The CloudWatch Logs endpoint for a region. */
function logsEndpoint(region: string): string {
  return `https://logs.${region}.amazonaws.com`;
}

/**
 * Validate an artifact before signing anything.
 *
 * A deploy with no artifact is refused here, in the adapter, rather than sent to
 * AWS: the API would reject it, and we would then be reporting "the engine
 * refused" for a request we should never have made.
 */
export function validateArtifact(artifact: ServerlessArtifact | undefined): {
  ok: boolean;
  reason: string;
} {
  if (!artifact) {
    return {
      ok: false,
      reason:
        "A serverless deploy needs a built artifact (an S3 object or a container image); " +
        "Lambda does not build from a git repository.",
    };
  }
  if (artifact.kind === "s3") {
    if (!artifact.bucket.trim() || !artifact.key.trim()) {
      return { ok: false, reason: "An S3 artifact needs both a bucket and a key." };
    }
    return { ok: true, reason: "" };
  }
  if (artifact.kind === "image") {
    // ECR URIs look like `<account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>`.
    if (!/^[a-z0-9-]+\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/.+/.test(artifact.uri)) {
      return { ok: false, reason: "An image artifact must be an ECR image URI." };
    }
    return { ok: true, reason: "" };
  }
  return { ok: false, reason: "Unknown artifact kind." };
}

/** Map a Lambda `State`/`LastUpdateStatus` pair onto Cloud Wai's vocabulary. */
export function mapLambdaStatus(
  state: string | undefined,
  lastUpdateStatus: string | undefined,
): DeploymentState["status"] {
  // A function that exists but whose last update failed is degraded, not
  // succeeded: the old code may still serve, but the change did not apply.
  if (lastUpdateStatus === "Failed") return "degraded";
  if (lastUpdateStatus === "InProgress") return "running";
  switch ((state ?? "").toLowerCase()) {
    case "active":
      return "succeeded";
    case "pending":
      return "running";
    case "inactive":
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

interface LambdaFunctionConfiguration {
  readonly FunctionName?: string;
  readonly State?: string;
  readonly LastUpdateStatus?: string;
  readonly FunctionArn?: string;
}

export function createLambdaServerless(options: LambdaAdapterOptions): ServerlessAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  const notConfigured = <T>(org: string): AdapterResult<T> =>
    err(
      "not_configured",
      `Serverless execution is not configured for organization ${org}. ` +
        "Provision AWS access keys (and a region) for this organization.",
    );

  const credentialsFor = <T>(
    ctx: AdapterContext,
  ): { ok: true; creds: LambdaCredentials } | { ok: false; result: AdapterResult<T> } => {
    const creds = options.credentials(ctx.organizationId);
    if (!creds || !creds.accessKeyId || !creds.secretAccessKey || !creds.region) {
      return { ok: false, result: notConfigured<T>(ctx.organizationId) };
    }
    return { ok: true, creds };
  };

  /**
   * Sign and send one request.
   *
   * `body` is signed as the exact string that is sent, so the payload hash and
   * the wire bytes agree — a request whose hash does not match its body is
   * rejected by AWS, and we would misread that as an engine fault.
   */
  const signedCall = <T>(
    ctx: AdapterContext,
    creds: LambdaCredentials,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
    service = "lambda",
    extraHeaders: Record<string, string> = {},
  ): Promise<AdapterResult<{ statusCode: number; value: T }>> => {
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const signed = signSigV4Request(creds, {
      method,
      url,
      region: creds.region,
      service,
      headers: { "content-type": "application/json", ...extraHeaders },
      body: bodyText,
      now: now(),
    });
    return request<T>(
      { fetchImpl: doFetch, classify: options.classify },
      {
        method,
        url,
        headers: signed.headers,
        ...(body === undefined ? {} : { body }),
        timeoutMs: ctx.timeoutMs,
      },
    );
  };

  /**
   * Sign and send, returning just the engine's payload.
   *
   * Most callers want the decoded body, not the status envelope, so this wraps
   * `signedCall` rather than repeating the unwrap at each site.
   */
  const signedValue = async <T>(
    ctx: AdapterContext,
    creds: LambdaCredentials,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
    service = "lambda",
    extraHeaders: Record<string, string> = {},
  ): Promise<AdapterResult<T>> => {
    const response = await signedCall<T>(ctx, creds, method, url, body, service, extraHeaders);
    return response.ok ? ok(response.status, response.value.value) : response;
  };

  const opRef = (ctx: AdapterContext, name: string): OperationRef => ({
    jobId: `lambda-function-${name}` as OperationRef["jobId"],
    providerRef: {
      organizationId: ctx.organizationId,
      provider: ENGINE,
      resourceType: "function",
      resourceId: name,
    },
  });

  return {
    async createFunction(ctx, input: CreateFunctionInput): Promise<AdapterResult<OperationRef>> {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;
      const { creds } = resolved;

      const artifact = validateArtifact(input.artifact);
      if (!artifact.ok) return err("failed", artifact.reason);

      const roleArn = input.roleArn ?? creds.executionRoleArn;
      if (!roleArn) {
        return err(
          "not_configured",
          "Creating a serverless function needs an IAM execution role ARN, " +
            "and this organization's AWS credentials do not name one.",
        );
      }

      const code =
        input.artifact!.kind === "s3"
          ? { S3Bucket: input.artifact!.bucket, S3Key: input.artifact!.key }
          : { ImageUri: input.artifact!.uri };

      const url = `${(options.endpointFor ?? lambdaEndpoint)(creds.region)}/2015-03-31/functions`;
      const response = await signedCall<LambdaFunctionConfiguration>(ctx, creds, "POST", url, {
        FunctionName: input.name,
        // Lambda defaults to `Zip`, and a `Zip` package rejects an `ImageUri`
        // code, so an image artifact that omitted this would fail at AWS for a
        // reason that looks like our request was malformed.
        PackageType: input.artifact!.kind === "image" ? "Image" : "Zip",
        Runtime: input.artifact!.kind === "s3" ? input.runtime : undefined,
        Handler: input.artifact!.kind === "s3" ? input.handler : undefined,
        Role: roleArn,
        ...(input.memoryMb ? { MemorySize: input.memoryMb } : {}),
        ...(input.timeoutSeconds ? { Timeout: input.timeoutSeconds } : {}),
        ...(input.environment ? { Environment: { Variables: input.environment } } : {}),
        Code: code,
      });
      if (!response.ok) return response;

      return ok("succeeded", opRef(ctx, input.name));
    },

    /**
     * Publish new code to an existing function.
     *
     * The artifact is mandatory: this is the serverless equivalent of "deploy",
     * and a deploy with nothing to deploy is refused rather than reported as a
     * success that changed nothing.
     */
    async deploy(ctx, input): Promise<AdapterResult<OperationRef>> {
      const resolved = credentialsFor<OperationRef>(ctx);
      if (!resolved.ok) return resolved.result;
      const { creds } = resolved;

      const artifact = validateArtifact(input.artifact);
      if (!artifact.ok) return err("failed", artifact.reason);

      const name = input.functionRef.resourceId;
      const code =
        input.artifact!.kind === "s3"
          ? { S3Bucket: input.artifact!.bucket, S3Key: input.artifact!.key }
          : { ImageUri: input.artifact!.uri };

      const url = `${(options.endpointFor ?? lambdaEndpoint)(creds.region)}/2015-03-31/functions/${encodeURIComponent(name)}/code`;
      const response = await signedCall<LambdaFunctionConfiguration>(ctx, creds, "PUT", url, {
        ...code,
        ...(input.publish ? { Publish: true } : {}),
      });
      if (!response.ok) return response;

      return ok("succeeded", opRef(ctx, name));
    },

    async getDeployment(ctx, ref): Promise<AdapterResult<DeploymentState>> {
      const resolved = credentialsFor<DeploymentState>(ctx);
      if (!resolved.ok) return resolved.result;
      const { creds } = resolved;

      const name = ref.resourceId;
      const base = (options.endpointFor ?? lambdaEndpoint)(creds.region);
      const state = await signedValue<LambdaFunctionConfiguration>(
        ctx,
        creds,
        "GET",
        `${base}/2015-03-31/functions/${encodeURIComponent(name)}/configuration`,
      );
      if (!state.ok) return state;

      // A function URL is what the edge forwards to; a function without one is
      // reachable only by an AWS-signed invoke, so the url is honestly null.
      const urlConfig = await signedValue<{ FunctionUrl?: string }>(
        ctx,
        creds,
        "GET",
        `${base}/2021-10-31/functions/${encodeURIComponent(name)}/url`,
      );

      return ok("succeeded", {
        ref,
        status: mapLambdaStatus(state.value.State, state.value.LastUpdateStatus),
        url: urlConfig.ok ? (urlConfig.value.FunctionUrl ?? null) : null,
      });
    },

    async deleteFunction(ctx, ref): Promise<AdapterResult<void>> {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;
      const { creds } = resolved;
      const name = ref.resourceId;
      const url = `${(options.endpointFor ?? lambdaEndpoint)(creds.region)}/2015-03-31/functions/${encodeURIComponent(name)}`;
      const response = await signedCall<unknown>(ctx, creds, "DELETE", url);
      if (!response.ok) return response;
      return ok("succeeded", undefined);
    },

    /**
     * Read a function's logs from CloudWatch.
     *
     * Lambda writes its own log group (`/aws/lambda/<name>`); the adapter reads
     * it with `FilterLogEvents`, which is the documented API rather than a
     * console scrape. `cursor` is the CloudWatch `nextToken`.
     */
    async getLogs(ctx, ref, cursor): Promise<AdapterResult<LogPage>> {
      const resolved = credentialsFor<LogPage>(ctx);
      if (!resolved.ok) return resolved.result;
      const { creds } = resolved;

      // CloudWatch Logs is a JSON-RPC service, not a REST one: the operation is
      // named in `X-Amz-Target` and the body is `application/x-amz-json-1.1`.
      // Without the target header the endpoint answers 400 ("missing
      // X-Amz-Target"), which we would have misread as an engine fault.
      const response = await signedValue<{
        events?: readonly { message?: string }[];
        nextToken?: string;
      }>(
        ctx,
        creds,
        "POST",
        options.endpointFor ? options.endpointFor(creds.region) : logsEndpoint(creds.region) + "/",
        {
          logGroupName: `/aws/lambda/${ref.resourceId}`,
          ...(cursor ? { nextToken: cursor } : {}),
          limit: 200,
        },
        "logs",
        {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": "Logs_20140328.FilterLogEvents",
        },
      );
      if (!response.ok) return response;

      const events = response.value.events ?? [];
      const lines = events
        .map((event) => event.message)
        .filter((message): message is string => typeof message === "string");
      return ok("succeeded", {
        lines,
        cursor: response.value.nextToken ?? null,
      });
    },
  };
}
