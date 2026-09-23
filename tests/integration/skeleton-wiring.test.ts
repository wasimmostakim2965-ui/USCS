import { describe, expect, it } from "vitest";

import { describe as describeApi } from "@cloud-wai/api";
import { describe as describeOrchestrator } from "@cloud-wai/orchestrator";
import { describe as describeWorker } from "@cloud-wai/worker";
import { describe as describeSecurityControl } from "@cloud-wai/security-control";
import { describe as describeWeb } from "@cloud-wai/web";
import { CONTROL_PLANE_TABLES, controlPlaneConfig } from "@cloud-wai/database";
import { UnauthenticatedError, resolvePrincipal, toPrincipal } from "@cloud-wai/auth";
import { ENGINE_STATUSES, UNCONFIGURED_STATUS } from "@cloud-wai/contracts";
import { CAPABILITIES, ROLE_CAPABILITIES } from "@cloud-wai/authorization";
import { PROVIDER_NAMES } from "@cloud-wai/contracts";

const apps = [
  describeApi,
  describeOrchestrator,
  describeWorker,
  describeSecurityControl,
  describeWeb,
];

describe("monorepo wiring", () => {
  it("exposes a descriptor for every app with enforced boundaries", () => {
    for (const describeApp of apps) {
      const descriptor = describeApp();
      expect(descriptor.name).toBeTruthy();
      expect(descriptor.role).toBeTruthy();
      expect(descriptor.boundaries.length).toBeGreaterThan(0);
    }
  });

  it("keeps app names unique", () => {
    const names = apps.map((d) => d().name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares the control-plane tables the blueprint specifies", () => {
    // Identity, org, project, billing, policy, audit and orchestration state all
    // live in the control plane, not in a provider.
    expect(CONTROL_PLANE_TABLES).toContain("organizations");
    expect(CONTROL_PLANE_TABLES).toContain("organization_members");
    expect(CONTROL_PLANE_TABLES).toContain("audit_logs");
    expect(CONTROL_PLANE_TABLES).toContain("orchestration_jobs");
    expect(CONTROL_PLANE_TABLES).toContain("api_keys");
  });

  it("reports an unconfigured control plane instead of guessing", () => {
    expect(controlPlaneConfig({})).toBeNull();
    const config = controlPlaneConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    });
    expect(config?.url).toBe("https://example.supabase.co");
  });

  it("does not expose a default provider that could silently succeed", () => {
    expect(UNCONFIGURED_STATUS).toBe("not_configured");
    expect(ENGINE_STATUSES).toContain(UNCONFIGURED_STATUS);
    // `fake` exists so tests can exercise the adapter path, but it is opt-in.
    expect(PROVIDER_NAMES).toContain("fake");
  });

  it("gives owners strictly more than viewers", () => {
    expect(ROLE_CAPABILITIES.owner.length).toBe(CAPABILITIES.length);
    for (const capability of ROLE_CAPABILITIES.viewer) {
      expect(ROLE_CAPABILITIES.owner).toContain(capability);
    }
    expect(ROLE_CAPABILITIES.viewer.length).toBeLessThan(ROLE_CAPABILITIES.owner.length);
  });
});

describe("supabase session to principal", () => {
  it("rejects a session with no bearer token", async () => {
    const verifier = { verify: async () => null };
    await expect(resolvePrincipal(verifier, undefined)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("rejects a session the verifier cannot confirm", async () => {
    const verifier = { verify: async () => null };
    await expect(resolvePrincipal(verifier, "bogus")).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("requires an email, since audit records identify humans by email", () => {
    expect(() =>
      toPrincipal({ userId: "u1", email: null, displayName: null, accessToken: "t" }),
    ).toThrow(UnauthenticatedError);
  });

  it("maps a verified session to a principal", async () => {
    const verifier = {
      verify: async () => ({
        userId: "u1",
        email: "a@example.com",
        displayName: "A",
        accessToken: "t",
      }),
    };
    await expect(resolvePrincipal(verifier, "t")).resolves.toEqual({
      userId: "u1",
      email: "a@example.com",
      displayName: "A",
    });
  });
});
