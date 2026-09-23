import { describe, expect, it } from "vitest";
import { stateForStatus } from "@cloud-wai/ui";
import type { EngineStatus } from "@cloud-wai/contracts";

describe("view state mapping", () => {
  it("renders success only for a succeeded engine status", () => {
    expect(stateForStatus("succeeded").kind).toBe("success");
  });

  it("renders a degraded, not a success, when the engine is not configured", () => {
    // This is the anti-fake-success guarantee at the UI layer: an unconfigured
    // engine must never paint a green state.
    const state = stateForStatus("not_configured");
    expect(state.kind).toBe("degraded");
    if (state.kind === "degraded") {
      expect(state.reason).toMatch(/not configured/i);
    }
  });

  it("maps failed to an error state", () => {
    const state = stateForStatus("failed", "engine refused the request");
    expect(state.kind).toBe("error");
    if (state.kind === "error") expect(state.message).toBe("engine refused the request");
  });

  it("maps in-flight statuses to loading", () => {
    expect(stateForStatus("pending").kind).toBe("loading");
    expect(stateForStatus("running").kind).toBe("loading");
  });

  it("never maps a non-success status to success", () => {
    const nonSuccess: EngineStatus[] = [
      "pending",
      "running",
      "failed",
      "degraded",
      "not_configured",
    ];
    for (const status of nonSuccess) {
      expect(stateForStatus(status).kind, status).not.toBe("success");
    }
  });
});
