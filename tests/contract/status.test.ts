import { describe, expect, it } from "vitest";
import {
  ENGINE_STATUSES,
  isSuccess,
  isTerminal,
  ok,
  err,
  type AdapterResult,
  type EngineStatus,
} from "@cloud-wai/contracts";

describe("engine status vocabulary", () => {
  it("treats not_configured and failed as terminal non-success states", () => {
    // The core honesty invariant: only `succeeded` means success. A deployment
    // with no engine configured must never read as a green terminal state.
    expect(isTerminal("not_configured")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isSuccess("not_configured")).toBe(false);
    expect(isSuccess("failed")).toBe(false);
  });

  it("does not treat in-flight states as terminal", () => {
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("degraded")).toBe(false);
  });

  it("only reports succeeded for the succeeded status", () => {
    const successes = ENGINE_STATUSES.filter(isSuccess);
    expect(successes).toEqual(["succeeded"]);
  });
});

describe("adapter results", () => {
  it("keeps the honest engine status on the result", () => {
    const result: AdapterResult<number> = ok("succeeded", 1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("succeeded");
  });

  it("discriminates failures and carries a reason", () => {
    const result = err("not_configured", "Coolify is not configured in this deployment.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("not_configured");
      expect(result.reason).toContain("not configured");
    }
  });

  it("never labels an error result as succeeded", () => {
    const statuses: EngineStatus[] = ["failed", "not_configured", "degraded"];
    for (const status of statuses) {
      const result = err(status, "engine refused");
      expect(isSuccess(result.status)).toBe(false);
    }
  });
});
