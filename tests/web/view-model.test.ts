/**
 * The dashboard's honesty rules.
 *
 * The property that matters: no response other than a successful one can
 * produce a section with data. A `not_configured` engine, a server error and a
 * network failure must all be visibly not-success.
 */
import { describe, expect, it } from "vitest";
import { ApiClient, loadOrganizations, loadProjects, loadRoute, sectionFrom } from "@cloud-wai/web";
import {
  hasData,
  needsAttention,
  presentDeploymentStatus,
  ready,
  stateForStatus,
} from "@cloud-wai/ui";

function clientReturning(body: unknown, status = 200): ApiClient {
  return new ApiClient({
    baseUrl: "https://api.cloud-wai.test",
    getAccessToken: () => "token",
    fetchImpl: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  });
}

describe("section mapping", () => {
  it("renders ready data from a successful response", () => {
    const section = sectionFrom("Organizations", {
      ok: true,
      status: 200,
      data: [{ id: "o1", name: "Org", slug: "org" }],
    });
    expect(hasData(section)).toBe(true);
  });

  it("renders an empty list as empty, not ready", () => {
    const section = sectionFrom("Organizations", { ok: true, status: 200, data: [] });
    expect(section.state.kind).toBe("empty");
    expect(hasData(section)).toBe(false);
  });

  it("never produces data from a failed response", () => {
    const section = sectionFrom("Organizations", {
      ok: false,
      status: 500,
      error: { code: "internal", message: "Internal error." },
    });
    expect(hasData(section)).toBe(false);
    expect(section.state.kind).toBe("error");
    expect(needsAttention(section)).toBe(true);
  });

  it("treats an unconfigured engine as degraded, not as empty success", () => {
    const section = sectionFrom("Deployments", {
      ok: true,
      status: 200,
      notConfigured: true,
      error: { code: "not_configured", message: "Coolify is not configured." },
    });
    expect(section.state.kind).toBe("degraded");
    expect(hasData(section)).toBe(false);
    if (section.state.kind === "degraded") {
      expect(section.state.reason).toContain("Coolify");
    }
  });
});

describe("section construction", () => {
  it("does not report ready for an empty list", () => {
    expect(ready("x", []).state.kind).toBe("empty");
    expect(ready("x", [1]).state.kind).toBe("ready");
  });
});

describe("API client", () => {
  it("refuses to call without a session", async () => {
    const client = new ApiClient({
      baseUrl: "https://api.test",
      getAccessToken: () => null,
    });
    const response = await client.call("organizations.list");
    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
  });

  it("sends the session token and the procedure name", async () => {
    let captured: RequestInit | undefined;
    let url = "";
    const client = new ApiClient({
      baseUrl: "https://api.test/",
      getAccessToken: () => "session-token",
      fetchImpl: async (input, init) => {
        url = String(input);
        captured = init;
        return new Response(JSON.stringify({ ok: true, status: 200, data: [] }), { status: 200 });
      },
    });

    await client.call("projects.list", { organizationId: "org-a" });
    expect(url).toBe("https://api.test/rpc");
    expect((captured?.headers as Record<string, string>).authorization).toBe(
      "Bearer session-token",
    );
    expect(String(captured?.body)).toContain("projects.list");
  });

  it("reports an unreachable API without throwing", async () => {
    const client = new ApiClient({
      baseUrl: "https://api.test",
      getAccessToken: () => "token",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const response = await client.call("organizations.list");
    expect(response.ok).toBe(false);
    expect(response.status).toBe(0);
  });

  it("does not treat an HTML error page as a valid response", async () => {
    const client = new ApiClient({
      baseUrl: "https://api.test",
      getAccessToken: () => "token",
      fetchImpl: async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    });
    const response = await client.call("organizations.list");
    expect(response.ok).toBe(false);
  });
});

describe("loaders", () => {
  it("loads organizations through the real client and maps to a section", async () => {
    const client = clientReturning({
      ok: true,
      status: 200,
      data: [{ id: "o1", name: "Org", slug: "org" }],
    });
    const section = await loadOrganizations(client);
    expect(hasData(section)).toBe(true);
    if (section.state.kind === "ready") expect(section.state.items).toHaveLength(1);
  });

  it("surfaces a forbidden response as an error section", async () => {
    const client = clientReturning(
      { ok: false, status: 403, error: { code: "forbidden", message: "Not allowed." } },
      403,
    );
    const section = await loadProjects(client, "org-a");
    expect(section.state.kind).toBe("error");
    expect(hasData(section)).toBe(false);
  });

  it("builds a model for the organization route without loading unrelated data", async () => {
    const client = clientReturning({ ok: true, status: 200, data: [] });
    const model = await loadRoute(client, { name: "organization", organizationId: "org-a" });
    expect(model.sections).toHaveLength(2);
  });

  it("renders an unknown route as an error section", async () => {
    const client = clientReturning({ ok: true, status: 200, data: [] });
    const model = await loadRoute(client, { name: "not_found", path: "/nope" });
    expect(model.sections[0]!.state.kind).toBe("error");
  });

  it("builds the domains, data and security models from their own procedures", async () => {
    const calls: string[] = [];
    const recording = new ApiClient({
      baseUrl: "https://api.test",
      getAccessToken: () => "token",
      fetchImpl: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)).procedure);
        return new Response(JSON.stringify({ ok: true, status: 200, data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await loadRoute(recording, { name: "domains", organizationId: "org-a", projectId: "p-1" });
    await loadRoute(recording, {
      name: "database",
      organizationId: "org-a",
      projectId: "p-1",
      section: "tables",
    });
    await loadRoute(recording, { name: "security", organizationId: "org-a", projectId: "p-1" });
    await loadRoute(recording, { name: "apiKeys", organizationId: "org-a" });

    expect(calls).toEqual(["domains.list", "data.list", "providers.health", "apiKeys.list"]);
  });

  it("titles a database sub-page by its section, not by the parent section", async () => {
    const client = clientReturning({ ok: true, status: 200, data: [] });

    const tables = await loadRoute(client, {
      name: "database",
      organizationId: "org-a",
      projectId: "p-1",
      section: "tables",
    });
    const overview = await loadRoute(client, {
      name: "database",
      organizationId: "org-a",
      projectId: "p-1",
    });

    expect(tables.title).toBe("Table Editor");
    expect(overview.title).toBe("Overview");
  });

  it("carries each engine's state through to the row instead of collapsing it", async () => {
    const client = clientReturning({
      ok: true,
      status: 200,
      data: [
        { provider: "coolify", state: "not_configured", detail: "No credentials configured." },
        { provider: "minio", state: "ready", detail: "Configured for this deployment." },
      ],
    });
    const model = await loadRoute(client, { name: "settings", organizationId: "org-a" });
    const section = model.sections[0]!;
    expect(section.state.kind).toBe("ready");
    if (section.state.kind === "ready") {
      // The row keeps its own honest state; the section is not forced to
      // degraded just because one engine is unconfigured.
      expect(section.state.items.map((i) => i.state)).toEqual(["not_configured", "ready"]);
    }
  });

  it("treats a not_configured procedure response as degraded, not empty", async () => {
    const client = clientReturning({
      ok: true,
      status: 200,
      notConfigured: true,
      data: [],
    });
    const model = await loadRoute(client, {
      name: "domains",
      organizationId: "org-a",
      projectId: "p-1",
    });
    expect(model.sections[0]!.state.kind).toBe("degraded");
  });
});

describe("status presentation", () => {
  it("gives not_configured its own label, distinct from failure", () => {
    const unconfigured = presentDeploymentStatus("not_configured");
    const failed = presentDeploymentStatus("failed");
    expect(unconfigured.label).toBe("Not configured");
    expect(unconfigured.tone).not.toBe(failed.tone);
  });

  it("maps engine status to a view state without inventing success", () => {
    expect(stateForStatus("not_configured").kind).toBe("degraded");
    expect(stateForStatus("failed").kind).toBe("error");
    expect(stateForStatus("pending").kind).toBe("loading");
    expect(stateForStatus("succeeded").kind).toBe("success");
  });
});
