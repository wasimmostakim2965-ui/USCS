/**
 * Adapter conformance rules.
 *
 * Every adapter in this package goes through these helpers so that three
 * properties hold uniformly:
 *   * a call is always bounded in time;
 *   * an engine that is not configured reports `not_configured` and never
 *     `succeeded`;
 *   * a thrown error from an engine SDK becomes an `AdapterErr`, not an
 *     exception that unwinds into the API layer.
 */
import { err, ok, type AdapterResult } from "@cloud-wai/contracts";
import type { EngineStatus } from "@cloud-wai/contracts";

export class AdapterTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`Adapter operation '${operation}' exceeded ${timeoutMs}ms.`);
    this.name = "AdapterTimeoutError";
  }
}

/** Run `work` with a hard deadline. The timer is always cleared. */
export async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AdapterTimeoutError(operation, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wrap an adapter call so it always returns an `AdapterResult`.
 *
 * The engine's own message is retained as the reason for diagnostics, but the
 * status is never upgraded beyond what the engine actually reported.
 */
export async function guarded<T>(
  operation: string,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<AdapterResult<T>>,
): Promise<AdapterResult<T>> {
  try {
    return await withTimeout(operation, timeoutMs, work);
  } catch (error) {
    if (error instanceof AdapterTimeoutError) {
      return err("failed", error.message);
    }
    const reason = error instanceof Error ? error.message : String(error);
    return err("failed", `${operation} failed: ${reason}`);
  }
}

/** The honest result for an engine this deployment has no credentials for. */
export function notConfigured<T>(engine: string, hint?: string): AdapterResult<T> {
  const detail = hint ? ` ${hint}` : "";
  return err("not_configured", `${engine} is not configured in this deployment.${detail}`);
}

export interface AdapterCapabilities {
  readonly engine: string;
  /** Operations this deployment can actually perform. */
  readonly operations: readonly string[];
  readonly configured: boolean;
  /** Why the adapter is unconfigured, when it is. */
  readonly reason?: string;
}

/**
 * Compare a reported status against what the caller asked for.
 *
 * Used by the worker before persisting a result: a `succeeded` status is only
 * written when the adapter really returned success.
 */
export function statusIsHonest(status: EngineStatus, claimedSuccess: boolean): boolean {
  return claimedSuccess ? status === "succeeded" : status !== "succeeded";
}
