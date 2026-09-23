/**
 * MinIO / S3-compatible object storage adapter.
 *
 * MinIO speaks the S3 API, so this adapter signs requests with SigV4 and calls
 * the documented bucket endpoints:
 *
 *   PUT    /{bucket}          create a bucket
 *   DELETE /{bucket}          delete a bucket
 *   HEAD   /{bucket}          does the bucket exist, and whose is it
 *
 * Two decisions worth stating:
 *
 * 1. SigV4 is implemented here rather than pulled in. It is ~60 lines of
 *    HMAC-SHA256 with a documented canonical-request layout, and a dependency
 *    that signs credentials would sit on the path of every storage call.
 *
 * 2. Per-organization credentials, as everywhere else. One MinIO access key per
 *    organization, and a bucket policy that confines it to that organization's
 *    prefix. The prefix is derived from the organization id and included in
 *    every object path.
 */
import { err, ok, type AdapterResult, type ProviderRef } from "@cloud-wai/contracts";
import { createHash, createHmac } from "node:crypto";
import type { AdapterContext, StorageAdapter } from "./index.js";

const ENGINE: ProviderRef["provider"] = "minio";

export interface StorageCredentials {
  /** e.g. `https://minio.internal:9000` */
  readonly endpoint: string;
  readonly accessKey: string;
  readonly secretKey: string;
  /** MinIO's default region; it accepts any value as long as it is consistent. */
  readonly region?: string;
}

export interface MinioAdapterOptions {
  readonly fetchImpl?: typeof fetch;
  readonly credentials: (
    organizationId: AdapterContext["organizationId"],
  ) => StorageCredentials | null;
  /** Injected for deterministic tests. */
  readonly now?: () => Date;
}

/** The bucket-name prefix that belongs to one organization. */
export function bucketPrefixFor(organizationId: AdapterContext["organizationId"]): string {
  const org = createHash("sha256").update(organizationId).digest("hex").slice(0, 12);
  return `cw-${org}-`;
}

/** Buckets are namespaced by organization, so a name is never global. */
export function bucketNameFor(
  organizationId: AdapterContext["organizationId"],
  logicalName: string,
): string {
  const slug = logicalName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${bucketPrefixFor(organizationId)}${slug || "bucket"}`;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** RFC 3986 encoding, as SigV4 requires (and stricter than encodeURIComponent). */
function uriEncode(value: string, encodeSlash = true): string {
  return value
    .split("")
    .map((char) => {
      if (/[A-Za-z0-9\-._~]/.test(char)) return char;
      if (char === "/" && !encodeSlash) return char;
      return Array.from(new TextEncoder().encode(char))
        .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
        .join("");
    })
    .join("");
}

export interface SignedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * Produce a SigV4-signed request.
 *
 * Exported because the signature is the part most likely to be subtly wrong, and
 * a unit test against the AWS reference vectors is more convincing than an
 * end-to-end test that happens to pass.
 */
export function signRequest(input: {
  readonly method: "PUT" | "DELETE" | "HEAD" | "GET";
  readonly endpoint: string;
  readonly path: string;
  readonly credentials: StorageCredentials;
  readonly payload?: string;
  readonly now: Date;
}): SignedRequest {
  const region = input.credentials.region ?? "us-east-1";
  const service = "s3";
  const host = new URL(input.endpoint).host;
  const payload = input.payload ?? "";
  const payloadHash = sha256Hex(payload);

  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = input.path
    .split("/")
    .map((segment) => uriEncode(segment, false))
    .join("/");

  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    input.method,
    canonicalUri,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    url: `${input.endpoint.replace(/\/$/, "")}${canonicalUri}`,
    headers: {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

export function createMinioStorage(options: MinioAdapterOptions): StorageAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  const credentialsFor = <T>(
    ctx: AdapterContext,
  ): { ok: true; creds: StorageCredentials } | { ok: false; result: AdapterResult<T> } => {
    const creds = options.credentials(ctx.organizationId);
    if (!creds || creds.endpoint.trim() === "" || !creds.accessKey || !creds.secretKey) {
      return {
        ok: false,
        result: err(
          "not_configured",
          `Object storage is not configured for organization ${ctx.organizationId}. Provision storage credentials for this organization.`,
        ),
      };
    }
    return { ok: true, creds };
  };

  const send = async <T>(
    ctx: AdapterContext,
    creds: StorageCredentials,
    method: "PUT" | "DELETE" | "HEAD" | "GET",
    path: string,
  ): Promise<AdapterResult<{ statusCode: number }>> => {
    const signed = signRequest({
      method,
      endpoint: creds.endpoint,
      path,
      credentials: creds,
      now: now(),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const response = await doFetch(signed.url, {
        method,
        headers: signed.headers,
        signal: controller.signal,
      });
      if (response.ok) return ok("succeeded", { statusCode: response.status });
      if (response.status >= 500 || response.status === 429) {
        return err("degraded", `${method} ${path} returned ${response.status}.`);
      }
      return err("failed", `${method} ${path} returned ${response.status}.`);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return err("failed", `${method} ${path} timed out after ${ctx.timeoutMs}ms.`);
      }
      return err("degraded", `${method} ${path} unreachable.`);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async createBucket(ctx, input) {
      const resolved = credentialsFor<ProviderRef>(ctx);
      if (!resolved.ok) return resolved.result;

      const name = bucketNameFor(ctx.organizationId, input.name);
      const result = await send(ctx, resolved.creds, "PUT", `/${name}`);
      if (!result.ok) return result;

      return ok("succeeded", {
        organizationId: ctx.organizationId,
        provider: ENGINE,
        resourceType: "bucket",
        resourceId: name,
      });
    },

    async deleteBucket(ctx, ref) {
      const resolved = credentialsFor<void>(ctx);
      if (!resolved.ok) return resolved.result;

      // Only a bucket this organization owns may be deleted: the name must carry
      // the organization's own prefix, so a caller cannot name someone else's.
      const prefix = bucketPrefixFor(ctx.organizationId);
      if (!ref.resourceId.startsWith(prefix) || ref.resourceId.length === prefix.length) {
        return err("failed", "The bucket does not belong to this organization.");
      }

      const result = await send(ctx, resolved.creds, "DELETE", `/${ref.resourceId}`);
      if (!result.ok) return result;
      return ok("succeeded", undefined);
    },
  };
}
