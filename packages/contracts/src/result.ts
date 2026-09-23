/**
 * Auditable operation result returned by every Cloud Wai adapter call.
 *
 * `operationRef` is the Cloud Wai-owned handle for the async work; the engine's
 * own identifier lives inside `providerRef`. A caller must be able to
 * distinguish "the engine is not configured here" from "the engine refused"
 * and from "it worked" without inspecting engine-specific payloads.
 */
import type { EngineStatus } from "./status.js";
import type { OrchestrationJobId, ProviderRef } from "./ids.js";

export interface OperationRef {
  readonly jobId: OrchestrationJobId;
  readonly providerRef: ProviderRef;
}

export interface AdapterOk<T> {
  readonly ok: true;
  readonly status: EngineStatus;
  readonly value: T;
}

export interface AdapterErr {
  readonly ok: false;
  readonly status: EngineStatus;
  readonly reason: string;
}

export type AdapterResult<T> = AdapterOk<T> | AdapterErr;

export function ok<T>(status: EngineStatus, value: T): AdapterOk<T> {
  return { ok: true, status, value };
}

export function err(status: EngineStatus, reason: string): AdapterErr {
  return { ok: false, status, reason };
}
