/**
 * Load gate: the API must report p50/p95/p99 latency and throughput.
 *
 * Two halves, deliberately separated:
 *
 *   1. The percentile maths is pinned exactly, because a load number that is
 *      computed wrong is worse than no number — it would be quoted in a
 *      capacity decision.
 *   2. The harness runs the real router and the real procedure table under
 *      concurrency, so throughput reflects the actual dispatch path rather
 *      than a loop that only measures `await` overhead.
 *
 * This is a control-plane load probe, not a soak test. It proves the harness is
 * real and that percentiles are reported; it does not claim a production RPS
 * figure, which belongs on target hardware against a real database.
 */
import { describe, expect, it } from "vitest";
import { buildProcedures, buildRouter, type DataStore, type RouterDeps } from "@cloud-wai/api";
import {
  formatLoadReport,
  percentiles,
  summarizeLatency,
  summarizeLoad,
} from "@cloud-wai/observability";
import type { Membership, MembershipStore } from "@cloud-wai/authorization";
import type { SessionVerifier, SupabaseSession } from "@cloud-wai/auth";
import type { Organization, OrganizationId } from "@cloud-wai/contracts";

// The API package re-exports its own database types; these small fixtures are
// enough to exercise a read path without a real database.
const ORG_A = "org-a" as OrganizationId;
const USER = "u-alice";
const TOKEN = "t-alice";

const verifier: SessionVerifier = {
  async verify(token) {
    if (token !== TOKEN) return null;
    const session: SupabaseSession = {
      userId: USER,
      email: "a@x.test",
      displayName: "Alice",
      accessToken: TOKEN,
    };
    return session;
  },
};

const memberships: Membership[] = [{ organizationId: ORG_A, userId: USER, role: "owner" }];
const membershipStore: MembershipStore = {
  async membershipsFor(userId) {
    return memberships.filter((m) => m.userId === userId);
  },
};

function storeWithOrganizations(count: number): DataStore {
  const organizations: Organization[] = Array.from({ length: count }, (_, i) => ({
    id: ORG_A,
    name: `Org ${i}`,
    slug: `org-${i}`,
    createdAt: "2026-01-01T00:00:00Z",
  }));

  return {
    async listOrganizations() {
      return organizations;
    },
    async createOrganization(input) {
      return {
        id: ORG_A,
        name: input.name,
        slug: input.slug,
        createdAt: "2026-01-01T00:00:00Z",
      };
    },
    async listProjects() {
      return [];
    },
    async getProject() {
      return null;
    },
    async createProject() {
      throw new Error("not used in the load probe");
    },
    async listDeployments() {
      return [];
    },
    async listAuditEvents() {
      return [];
    },
    async listDomains() {
      return [];
    },
    async listDataResources() {
      return [];
    },
    async listApiKeys() {
      return [];
    },
    async createApiKey() {
      throw new Error("not used in the load probe");
    },
    async revokeApiKey() {
      return false;
    },
    async recordAuditEvent(input) {
      return { ...input, id: "a-1", createdAt: "2026-01-01T00:00:00Z" };
    },
  };
}

function routerDeps(store: DataStore): RouterDeps {
  return {
    verifier,
    memberships: membershipStore,
    store,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

describe("percentile maths", () => {
  const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it("returns observed values, never interpolated ones", () => {
    expect(percentiles(samples, 50)).toBe(50);
    expect(percentiles(samples, 95)).toBe(100);
    expect(percentiles(samples, 99)).toBe(100);
  });

  it("does not mutate the caller's samples", () => {
    const input = [3, 1, 2];
    percentiles(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });

  it("handles the degenerate sizes without inventing a number", () => {
    expect(percentiles([], 95)).toBe(0);
    expect(percentiles([7], 95)).toBe(7);
    expect(summarizeLatency([]).count).toBe(0);
  });

  it("keeps p50 <= p95 <= p99 <= max", () => {
    const summary = summarizeLatency(samples);
    expect(summary.p50).toBeLessThanOrEqual(summary.p95);
    expect(summary.p95).toBeLessThanOrEqual(summary.p99);
    expect(summary.p99).toBeLessThanOrEqual(summary.max);
  });
});

describe("load report", () => {
  it("separates successes from failures rather than averaging them away", () => {
    const report = summarizeLoad(
      [
        { ok: true, durationMs: 5 },
        { ok: true, durationMs: 6 },
        { ok: false, durationMs: 500 },
      ],
      30,
    );
    expect(report.total).toBe(3);
    expect(report.ok).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.latency.max).toBe(500);
    expect(report.throughput).toBeCloseTo(100, 5);
  });

  it("reports zero throughput instead of dividing by zero", () => {
    expect(summarizeLoad([{ ok: true, durationMs: 1 }], 0).throughput).toBe(0);
  });

  it("formats every gate number into one line", () => {
    const line = formatLoadReport(
      "organizations.list",
      summarizeLoad([{ ok: true, durationMs: 4 }], 10),
    );
    expect(line).toContain("p50=");
    expect(line).toContain("p95=");
    expect(line).toContain("p99=");
    expect(line).toContain("req/s");
  });
});

describe("the real router under concurrency", () => {
  it("serves every request and reports all three percentiles", async () => {
    const store = storeWithOrganizations(25);
    const router = buildRouter(routerDeps(store), buildProcedures(store));

    const concurrency = 20;
    const perWorker = 25;

    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: concurrency }, async () => {
        const durations: number[] = [];
        let succeeded = 0;
        for (let i = 0; i < perWorker; i += 1) {
          const t0 = performance.now();
          const res = await router.route({
            procedure: "organizations.list",
            accessToken: TOKEN,
          });
          durations.push(performance.now() - t0);
          if (res.ok) succeeded += 1;
        }
        return { durations, succeeded };
      }),
    );
    const elapsedMs = performance.now() - started;

    const observations = results.flatMap((r) =>
      r.durations.map((durationMs) => ({ ok: true, durationMs })),
    );
    const report = summarizeLoad(observations, elapsedMs);

    // Every request must have succeeded: a load probe that tolerates failures
    // would report a fast p99 for a service that is dropping work.
    expect(results.reduce((n, r) => n + r.succeeded, 0)).toBe(concurrency * perWorker);
    expect(report.ok).toBe(concurrency * perWorker);
    expect(report.failed).toBe(0);
    expect(report.latency.count).toBe(concurrency * perWorker);
    expect(report.throughput).toBeGreaterThan(0);
    expect(report.latency.p99).toBeGreaterThanOrEqual(report.latency.p50);

    console.log(formatLoadReport("organizations.list (in-process fixture)", report));
  });

  it("keeps the unauthenticated path fast and correct under load", async () => {
    // A rejected request must be rejected, not accepted; this is the check that
    // a burst of anonymous traffic cannot be mistaken for real work.
    const store = storeWithOrganizations(5);
    const router = buildRouter(routerDeps(store), buildProcedures(store));

    const started = performance.now();
    const outcomes = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const t0 = performance.now();
        const res = await router.route({ procedure: "organizations.list", accessToken: "nope" });
        return { status: res.status, durationMs: performance.now() - t0 };
      }),
    );
    const elapsedMs = performance.now() - started;

    const report = summarizeLoad(
      outcomes.map((o) => ({ ok: o.status === 401, durationMs: o.durationMs })),
      elapsedMs,
    );
    expect(outcomes.every((o) => o.status === 401)).toBe(true);
    expect(report.ok).toBe(100);
    console.log(formatLoadReport("organizations.list (rejected tokens)", report));
  });
});
