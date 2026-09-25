/**
 * Webhook secrets: encrypted at rest, verified constant-time.
 *
 * A git webhook needs the *same* secret twice — at connect time, to show the
 * user and to store against the link, and at delivery time, to recompute the
 * HMAC over the raw body. That is why this is not the one-way hash `api_keys`
 * uses: the receiver must be able to recover the key material. Recovering it is
 * therefore the one operation that must never be reachable from a browser, and
 * it is not: the ciphertext is excluded from the client SELECT grant
 * (`0011_project_git_links.sql`), and the decrypt call lives on the service
 * path only.
 *
 * Two rules this module enforces rather than trusts:
 *
 *   1. **No key configured means no link.** With `CLOUD_WAI_SECRET_ENCRYPTION_KEY`
 *      unset, `encryptSecret` reports null and the API answers `not_configured`
 *      instead of storing a plaintext secret. A missing key must never
 *      downgrade to an unencrypted column.
 *   2. **A signature is compared in constant time, over the raw body.** A
 *      generic `===` on a hex digest leaks the correct prefix one byte at a
 *      time, and a re-serialised JSON body changes bytes the sender signed.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM over a per-secret random IV.
 *
 * The format is `v1:<iv>:<tag>:<ciphertext>`, all base64url. The version tag is
 * load-bearing: a future scheme can be added and an old row still decrypted
 * without guessing which one wrote it.
 */
export interface SecretCipher {
  /** Encrypt to the on-disk format. Throws only on an internal crypto failure. */
  encrypt(plaintext: string): string;
  /** Decrypt, or null when the value is malformed or the tag does not verify. */
  decrypt(ciphertext: string): string | null;
}

const CIPHER_VERSION = "v1";
const IV_BYTES = 12;

/**
 * Build the cipher from a base64 32-byte key, or null when unconfigured.
 *
 * A key of the wrong length is treated as unconfigured rather than padded or
 * truncated: silently deriving a key from whatever bytes were given is how a
 * weak key gets shipped.
 */
export function createSecretCipher(keyBase64: string | undefined): SecretCipher | null {
  const trimmed = keyBase64?.trim();
  if (!trimmed) return null;

  let key: Buffer;
  try {
    key = Buffer.from(trimmed, "base64");
  } catch {
    return null;
  }
  if (key.length !== 32) return null;

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        CIPHER_VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(":");
    },
    decrypt(value: string): string | null {
      const parts = value.split(":");
      if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) return null;
      const iv = Buffer.from(parts[1]!, "base64url");
      const tag = Buffer.from(parts[2]!, "base64url");
      const ciphertext = Buffer.from(parts[3]!, "base64url");
      if (iv.length !== IV_BYTES || tag.length !== 16) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // A tampered ciphertext fails the GCM tag here. That is a refusal, not
        // an error: the caller reports "signature could not be verified".
        return null;
      }
    },
  };
}

/** Read the cipher from the environment, or null. */
export function secretCipherFromEnv(
  env: Record<string, string | undefined> = process.env,
): SecretCipher | null {
  return createSecretCipher(env.CLOUD_WAI_SECRET_ENCRYPTION_KEY);
}

/** Generate a key suitable for `CLOUD_WAI_SECRET_ENCRYPTION_KEY`, base64. */
export function generateSecretEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

/** The HMAC-signed header value, hex, as a provider sends it. */
export function computeSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Compare a presented signature to the expected one, constant-time.
 *
 * Accepts the two shapes providers actually send: a bare hex digest (GitLab's
 * older style, generic senders) and `sha256=<hex>` (GitHub, Bitbucket). A
 * length mismatch short-circuits to false *before* `timingSafeEqual`, which
 * throws on unequal lengths — and a mismatch is itself not a secret.
 */
export function signatureMatches(expectedHex: string, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const value = presented.includes("=") ? presented.slice(presented.indexOf("=") + 1) : presented;
  const candidate = Buffer.from(value.trim().toLowerCase(), "hex");
  const expected = Buffer.from(expectedHex.toLowerCase(), "hex");
  if (candidate.length !== expected.length || candidate.length === 0) return false;
  return timingSafeEqual(candidate, expected);
}

/** Compare a shared token (GitLab's `X-Gitlab-Token`), constant-time. */
export function tokenMatches(secret: string, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const candidate = Buffer.from(presented, "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/** A short, non-secret fragment shown in the dashboard to name a secret. */
export function secretPrefix(secret: string): string {
  return `whsec_${secret.slice(0, 4)}`;
}

/** Generate a webhook secret. 32 bytes, base64url, so it is URL-safe to paste. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}
