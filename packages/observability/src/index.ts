/**
 * @cloud-wai/observability — redaction helpers and telemetry contracts.
 *
 * The security rule this package exists to enforce: secrets, tokens, cookies,
 * credentials and origin addresses must never reach a log line or a trace.
 */

const REDACTED = "[redacted]";

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|credential|session|dsn|connection[_-]?string|jwt)/i;

/** Keys whose value is always an origin address and must stay private. */
const ORIGIN_KEY_PATTERN = /^(origin|origin_?ip|origin_?host|upstream|backend_?host)$/i;

export function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || ORIGIN_KEY_PATTERN.test(key);
}

/**
 * Recursively replace sensitive values with a placeholder.
 *
 * Depth is bounded so a cyclic or pathologically nested object cannot hang a
 * request thread while logging.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(val, depth + 1);
  }
  return out;
}

/** Emit a structured log record with sensitive fields removed. */
export function logRecord(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    level,
    event,
    fields: redact(fields),
  };
}
