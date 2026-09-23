/**
 * Security control: distribution and incidents.
 *
 * The rules under test are the ones that would be expensive to get wrong in
 * production — a policy that rolls backwards, an incident that closes with no
 * resolution, and a distribution reported successful when the edge refused it.
 */
import { describe, expect, it } from "vitest";
import type { AdapterContext, SecurityEdgeAdapter } from "@cloud-wai/adapters";
import { err, ok, type ProviderRef } from "@cloud-wai/contracts";
import { mayDistribute, validatePolicy, type SecurityPolicy } from "@cloud-wai/security";
import {
  IncidentTracker,
  PolicyVersionRegistry,
  distributePolicy,
} from "@cloud-wai/security-control";

const ORG = "org-sec" as AdapterContext["organizationId"];
const OTHER = "org-other" as AdapterContext["organizationId"];
const ctx = (key = "k"): AdapterContext => ({
  organizationId: ORG,
  idempotencyKey: key,
  timeoutMs: 2_000,
});
const ctxFor = (organizationId: AdapterContext["organizationId"], key: string): AdapterContext => ({
  organizationId,
  idempotencyKey: key,
  timeoutMs: 2_000,
});

const policy = (over: Partial<SecurityPolicy> = {}): SecurityPolicy => ({
  id: "policy-1",
  organizationId: ORG,
  name: "Block SQLi on /api",
  riskLevel: "high",
  action: "block",
  version: 1,
  ...over,
});

const providerRef = (p: SecurityPolicy): ProviderRef => ({
  organizationId: p.organizationId,
  provider: "coraza",
  resourceType: "policy",
  resourceId: p.id,
});

/** A fake edge whose applyPolicy answer the test controls. */
function edge(
  answer: (call: number) => Awaited<ReturnType<SecurityEdgeAdapter["applyPolicy"]>>,
): SecurityEdgeAdapter {
  let call = 0;
  const notConfigured = async () =>
    err<{ version: number }>("not_configured", "edge is not configured");
  return {
    publishRoute: notConfigured,
    removeRoute: notConfigured,
    applyPolicy: async () => answer(++call),
    quarantine: notConfigured,
    inspectHealth: notConfigured,
  } as unknown as SecurityEdgeAdapter;
}

describe("policy validation", () => {
  it("accepts a well-formed policy", () => {
    expect(validatePolicy(policy()).ok).toBe(true);
  });

  it.each([
    ["an empty name", policy({ name: "  " })],
    ["a non-positive version", policy({ version: 0 })],
    ["a fractional version", policy({ version: 1.5 })],
    ["an unknown risk level", policy({ riskLevel: "spicy" as never })],
    ["an unknown action", policy({ action: "delete" as never })],
  ])("rejects %s", (_label, bad) => {
    expect(validatePolicy(bad).ok).toBe(false);
  });
});

describe("monotonic versions", () => {
  it("allows the first distribution", () => {
    expect(mayDistribute({ policyId: "p", version: 1 }, null).ok).toBe(true);
  });

  it("allows re-distributing the same version", () => {
    expect(mayDistribute({ policyId: "p", version: 2 }, { policyId: "p", version: 2 }).ok).toBe(
      true,
    );
  });

  it("refuses an older version", () => {
    const verdict = mayDistribute({ policyId: "p", version: 1 }, { policyId: "p", version: 3 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("roll");
  });

  it("refuses a different policy", () => {
    expect(mayDistribute({ policyId: "q", version: 9 }, { policyId: "p", version: 3 }).ok).toBe(
      false,
    );
  });

  it("never records a lower version, even if the engine echoes one", () => {
    const registry = new PolicyVersionRegistry();
    registry.record(ORG, { policyId: "p", version: 5 });
    registry.record(ORG, { policyId: "p", version: 3 });
    expect(registry.get(ORG)?.version).toBe(5);
  });
});

describe("distribution", () => {
  const deps = (edgeAdapter: SecurityEdgeAdapter) => {
    const registry = new PolicyVersionRegistry();
    const incidents = new IncidentTracker(() => new Date("2026-01-01T00:00:00.000Z"));
    return { registry, incidents, edge: edgeAdapter, providerRef };
  };

  it("distributes a new policy and records the version", async () => {
    const d = deps(edge(() => ok("succeeded", { version: 4 })));
    const result = await distributePolicy(d, policy({ version: 4 }), ctx("d1"));
    expect(result.ok).toBe(true);
    expect(d.registry.get(ORG)?.version).toBe(4);
    expect(d.incidents.openIncidents(ORG)).toHaveLength(0);
  });

  it("refuses to roll a policy backwards without calling the edge", async () => {
    let called = 0;
    const d = deps(
      edge(() => {
        called += 1;
        return ok("succeeded", { version: 5 });
      }),
    );
    await distributePolicy(d, policy({ version: 5 }), ctx("r1"));
    const result = await distributePolicy(d, policy({ version: 4 }), ctx("r2"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("roll");
    // The second call never reached the engine.
    expect(called).toBe(1);
    expect(d.registry.get(ORG)?.version).toBe(5);
  });

  it("opens an incident when the edge rejects a distribution", async () => {
    const d = deps(
      edge(() => err<{ version: number }>("failed", "the edge is holding a newer policy")),
    );
    const result = await distributePolicy(d, policy({ version: 2 }), ctx("rej1"));
    expect(result.ok).toBe(false);

    const open = d.incidents.openIncidents(ORG);
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("policy_distribution_rejected");
    // The version was NOT recorded, because the engine did not accept it.
    expect(d.registry.get(ORG)).toBeNull();
  });

  it("records an incident against the distribution's own organization", async () => {
    const d = deps(edge(() => err<{ version: number }>("degraded", "edge unreachable")));
    await distributePolicy(d, policy({ organizationId: OTHER }), ctxFor(OTHER, "iso"));
    expect(d.incidents.openIncidents(OTHER)).toHaveLength(1);
    expect(d.incidents.openIncidents(ORG)).toHaveLength(0);
  });

  it("never reports success when the engine did not", async () => {
    for (const status of ["failed", "degraded", "not_configured"] as const) {
      const d = deps(edge(() => err<{ version: number }>(status, "no")));
      const result = await distributePolicy(d, policy(), ctx(`s-${status}`));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(status);
    }
  });

  it("does not record a version below what was sent", async () => {
    // A misbehaving engine echoes a *lower* version; we must not accept it.
    const d = deps(edge(() => ok("succeeded", { version: 1 })));
    const result = await distributePolicy(d, policy({ version: 6 }), ctx("low"));
    expect(result.ok).toBe(true);
    expect(d.registry.get(ORG)?.version).toBe(6);
  });
});

describe("incidents", () => {
  const tracker = () => new IncidentTracker(() => new Date("2026-01-01T00:00:00.000Z"));

  it("opens, triages and closes with a resolution", () => {
    const t = tracker();
    const incident = t.open({
      organizationId: ORG,
      kind: "origin_leak",
      severity: "critical",
      summary: "s",
    });
    expect(incident.state).toBe("open");

    const triaged = t.triage(incident.id);
    expect(triaged?.state).toBe("triaged");

    const closed = t.close(incident.id, "Origin firewall rule updated.");
    expect(closed?.state).toBe("resolved");
    expect(closed?.resolution).toBe("Origin firewall rule updated.");
    expect(closed?.closedAt).not.toBeNull();
    expect(t.openIncidents(ORG)).toHaveLength(0);
  });

  it("refuses to close without a resolution", () => {
    const t = tracker();
    const incident = t.open({ organizationId: ORG, kind: "xss", severity: "high", summary: "s" });
    expect(t.close(incident.id, "   ")).toBeNull();
    expect(t.get(incident.id)?.state).toBe("open");
  });

  it("distinguishes a false positive from a real fix", () => {
    const t = tracker();
    const incident = t.open({
      organizationId: ORG,
      kind: "blocked",
      severity: "low",
      summary: "s",
    });
    const closed = t.close(incident.id, "Legitimate traffic.", "false_positive");
    expect(closed?.state).toBe("false_positive");
  });

  it("cannot close an already closed incident", () => {
    const t = tracker();
    const incident = t.open({ organizationId: ORG, kind: "k", severity: "low", summary: "s" });
    t.close(incident.id, "done");
    expect(t.close(incident.id, "done again")).toBeNull();
  });

  it("does not reopen a closed incident by triaging it", () => {
    const t = tracker();
    const incident = t.open({ organizationId: ORG, kind: "k", severity: "low", summary: "s" });
    t.close(incident.id, "done");
    expect(t.triage(incident.id)).toBeNull();
  });
});
