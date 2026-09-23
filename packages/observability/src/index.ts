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

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly service: string;
  /** Sink for the serialized record. Defaults to stdout via `console.log`. */
  readonly sink?: (record: Record<string, unknown>) => void;
  readonly minLevel?: "debug" | "info" | "warn" | "error";
  readonly base?: Record<string, unknown>;
}

const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;

/**
 * Create a redacting logger.
 *
 * Every field passes through `redact`, so a caller cannot accidentally log a
 * token by handing over a raw request object.
 */
export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((record) => console.log(JSON.stringify(record)));
  const min = LEVEL_ORDER[options.minLevel ?? "info"];

  const emit =
    (level: keyof typeof LEVEL_ORDER) =>
    (event: string, fields = {}) => {
      if (LEVEL_ORDER[level] < min) return;
      sink({
        ...logRecord(level, event, { ...options.base, ...fields }),
        service: options.service,
        time: new Date().toISOString(),
      });
    };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}

// =============================================================================
// Timing and load reporting
// =============================================================================

/**
 * A sample of finished request durations, in milliseconds.
 *
 * The blueprint's load gate asks for p50/p95/p99 and throughput, so the report
 * is built from raw samples rather than an average: an average hides the tail
 * that a user actually feels, and the tail is where timeouts live.
 */
export interface LatencySample {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/**
 * Nearest-rank percentile over a copy of the samples.
 *
 * Nearest-rank is used deliberately: it always returns an observed duration, so
 * a reported p99 cannot be a value that never actually happened. The input is
 * not mutated, because the caller usually wants the raw list afterwards.
 */
export function percentiles(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) return 0;
  if (percentile <= 0) return Math.min(...samples);
  if (percentile >= 100) return Math.max(...samples);

  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))]!;
}

export function summarizeLatency(samples: readonly number[]): LatencySample {
  if (samples.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  return {
    count: samples.length,
    min: Math.min(...samples),
    p50: percentiles(samples, 50),
    p95: percentiles(samples, 95),
    p99: percentiles(samples, 99),
    max: Math.max(...samples),
  };
}

export interface LoadReport {
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
  /** Requests per second over the measured wall-clock window. */
  readonly throughput: number;
  readonly latency: LatencySample;
}

/**
 * Build a load report from a batch of observations.
 *
 * `elapsedMs` is wall-clock time for the whole batch, not the sum of the
 * request durations, so `throughput` reflects the real degree of concurrency.
 */
export function summarizeLoad(
  observations: readonly { readonly ok: boolean; readonly durationMs: number }[],
  elapsedMs: number,
): LoadReport {
  const durations = observations.map((o) => o.durationMs);
  const ok = observations.filter((o) => o.ok).length;
  return {
    total: observations.length,
    ok,
    failed: observations.length - ok,
    throughput: elapsedMs > 0 ? (observations.length / elapsedMs) * 1000 : 0,
    latency: summarizeLatency(durations),
  };
}

/** One line a CI log or a dashboard can carry without further formatting. */
export function formatLoadReport(label: string, report: LoadReport): string {
  const { latency } = report;
  return (
    `${label}: ${report.total} requests, ${report.ok} ok, ${report.failed} failed, ` +
    `${report.throughput.toFixed(1)} req/s, ` +
    `p50=${latency.p50.toFixed(2)}ms p95=${latency.p95.toFixed(2)}ms ` +
    `p99=${latency.p99.toFixed(2)}ms max=${latency.max.toFixed(2)}ms`
  );
}
