/**
 * AWS Signature Version 4.
 *
 * The serverless adapter signs real AWS API calls, so the signer has to be the
 * documented algorithm rather than an approximation: a wrong signature is a 403
 * and the adapter would report a deployment failure that is really our bug. The
 * implementation is therefore pinned by `tests/engines/aws-signature.test.ts`
 * against AWS's own published test vector (the `get-vanilla` case from the
 * Signature Version 4 test suite), not against a golden string this repository
 * produced itself.
 *
 * It is deliberately dependency-free and synchronous: signing is pure, and a
 * pure function is the easiest thing to prove correct. `crypto` here is Node's,
 * which every workspace app already runs on.
 */
import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for temporary credentials (STS/SSO). Absent for long-lived keys. */
  readonly sessionToken?: string | undefined;
}

export interface SigV4Request {
  readonly method: string;
  /** The full request URL. Its query string is canonicalised, not dropped. */
  readonly url: string;
  readonly region: string;
  readonly service: string;
  /** Request headers; `host`, `x-amz-date` and `x-amz-content-sha256` are added. */
  readonly headers?: Record<string, string> | undefined;
  /** The request body, hashed into the canonical request. */
  readonly body?: string | undefined;
  /** Injectable so a test can pin the `x-amz-date` value. */
  readonly now?: Date | undefined;
}

export interface SigV4SignedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

/** `20260925T120000Z` — the ISO basic format AWS requires. */
function amzDate(now: Date): { amz: string; date: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/**
 * Per RFC 3986. AWS is stricter than `encodeURIComponent` in exactly two ways
 * that matter: `!`, `'`, `(` and `)` must be percent-encoded, and the encoding
 * is byte-wise, so a multi-byte character becomes one escape per UTF-8 byte
 * rather than one for the code point.
 */
export function uriEncode(value: string, encodeSlash: boolean): string {
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

/** Parse a URL into its canonical path and sorted, encoded query pairs. */
function canonicalPathAndQuery(rawUrl: string): { path: string; query: string } {
  const url = new URL(rawUrl);
  // S3-style service prefixes aside, the canonical URI is the encoded path.
  const path = uriEncode(decodeURIComponent(url.pathname), false) || "/";
  const params: [string, string][] = [];
  for (const [key, value] of url.searchParams.entries()) params.push([key, value]);
  params.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? (aValue < bValue ? -1 : aValue > bValue ? 1 : 0) : aKey < bKey ? -1 : 1,
  );
  const query = params
    .map(([key, value]) => `${uriEncode(key, true)}=${uriEncode(value, true)}`)
    .join("&");
  return { path, query };
}

/** Canonical headers: lowercased names, trimmed values, sorted, newline-joined. */
function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    canonical: entries.map(([key, value]) => `${key}:${value}\n`).join(""),
    signed: entries.map(([key]) => key).join(";"),
  };
}

/** The HMAC chain that turns a secret into a date/region/service scoped key. */
export function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Sign a request and return the headers to send.
 *
 * The signed header set is exactly the caller's headers plus `host` and
 * `x-amz-date`. That is deliberate: AWS's published `get-vanilla` vector signs
 * those two alone, so a signer that injected anything else could not be checked
 * against it. `x-amz-content-sha256` is an S3-specific requirement and is added
 * by the S3 caller, not here.
 *
 * The body is still covered: its SHA-256 is a field of the canonical request and
 * therefore of the string to sign, so a signature that equals the reference
 * value proves the body was part of what was signed.
 *
 * A temporary-credential session token is added when present, because an
 * unsigned token header is rejected by AWS.
 */
export function signSigV4Request(
  credentials: SigV4Credentials,
  req: SigV4Request,
): SigV4SignedRequest {
  const now = req.now ?? new Date();
  const { amz, date } = amzDate(now);
  const url = new URL(req.url);
  const payloadHash = sha256Hex(req.body ?? "");

  const headers: Record<string, string> = {
    ...req.headers,
    host: url.host,
    "x-amz-date": amz,
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

  const { path, query } = canonicalPathAndQuery(req.url);
  const { canonical, signed } = canonicalHeaders(headers);
  const canonicalRequest = [
    req.method.toUpperCase(),
    path,
    query,
    canonical,
    signed,
    payloadHash,
  ].join("\n");

  const scope = `${date}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amz, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(
    signingKey(credentials.secretAccessKey, date, req.region, req.service),
    stringToSign,
  ).toString("hex");

  headers.authorization =
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signed}, Signature=${signature}`;

  return { url: req.url, headers };
}
