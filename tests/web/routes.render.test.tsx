/**
 * Every route renders.
 *
 * A route that throws on a cold load with real-looking data is worse than a
 * missing route: the URL is reachable and linked, so a user finds it. This
 * loads each one directly and asserts a page renders — no white screen, no
 * boundary fallback. It is the cheap guard that would have caught a broken
 * page before anyone else did.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { listen, type HttpServer } from "@cloud-wai/api";
import type { RpcResponse } from "@cloud-wai/api";
import { App, type SessionController } from "@cloud-wai/web";
import { ToastProvider } from "@cloud-wai/ui/react";

const servers: HttpServer[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  for (const server of servers.splice(0)) void server.close();
});

function signedInSession(): SessionController {
  return {
    configured: true,
    current: () => ({
      userId: "user-1",
      email: "operator@cloud-wai.test",
      displayName: "Operator",
      accessToken: "token",
    }),
    getAccessToken: () => "token",
    signInWithPassword: async () => {},
    signUpWithPassword: async () => ({ needsConfirmation: false }),
    applySession: async () => {},
    signOut: async () => {},
    subscribe: () => () => {},
  };
}

/** A control plane answering every read the shell makes with a plausible row. */
async function startApi(): Promise<string> {
  const rows: Record<string, unknown> = {
    "organizations.list": [{ id: "org-1", name: "Northwind", slug: "northwind" }],
    "projects.list": [{ id: "p-1", name: "Web app", slug: "web-app", region: "iad" }],
    "projects.get": { id: "p-1", name: "Web app", slug: "web-app" },
    "deployments.list": [
      {
        id: "d-1",
        status: "succeeded",
        url: "https://web-app.example.test",
        failureReason: null,
        isCurrent: true,
      },
    ],
    "deployments.listOrganization": [
      { id: "d-1", status: "succeeded", url: "https://web-app.example.test", isCurrent: true },
    ],
    "deployments.logs": { deploymentId: "d-1", lines: ["Build started", "Build succeeded"] },
    "domains.list": [{ id: "dm-1", hostname: "web.example.test", verified: true }],
    "git.links.list": [{ id: "g-1", provider: "github", repository: "acme/web" }],
    "env.list": [{ id: "e-1", key: "DATABASE_URL" }],
    "data.list": [{ id: "db-1", name: "primary", state: "ready", engine: "postgres" }],
    "audit.list": [
      { id: "a-1", action: "deployment.create", actorId: "user-1", at: "2026-09-30T00:00:00Z" },
    ],
    "observability.jobs": [{ id: "j-1", kind: "deploy", state: "succeeded" }],
    "organizations.members.list": [
      { userId: "user-1", email: "operator@cloud-wai.test", role: "owner" },
    ],
    "billing.usage": { plan: "pro", deployments: 1, members: 1 },
    "apiKeys.list": [
      {
        id: "k-1",
        name: "CI",
        keyPrefix: "cw_abc",
        scopes: ["org:read"],
        createdAt: "2026-09-01T00:00:00Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
    "providers.health": [{ provider: "coolify", state: "ready", detail: "Reachable." }],
    "security.policy.get": { policy: null, events: [] },
  };
  const server = await listen(
    {
      route: async (request) =>
        (request.procedure in rows
          ? { ok: true, status: 200, data: rows[request.procedure] }
          : { ok: true, status: 200, data: [] }) as RpcResponse,
      allowedOrigins: [],
      shutdownGraceMs: 50,
    },
    0,
    "127.0.0.1",
  );
  servers.push(server);
  return server.url;
}

const routes = [
  "#/orgs",
  "#/orgs/org-1/projects",
  "#/orgs/org-1/projects/p-1",
  "#/orgs/org-1/projects/p-1/setup",
  "#/orgs/org-1/projects/p-1/deployments",
  "#/orgs/org-1/projects/p-1/domains",
  "#/orgs/org-1/projects/p-1/git",
  "#/orgs/org-1/projects/p-1/env",
  "#/orgs/org-1/projects/p-1/database",
  "#/orgs/org-1/projects/p-1/observability",
  "#/orgs/org-1/members",
  "#/orgs/org-1/billing",
  "#/orgs/org-1/audit",
  "#/orgs/org-1/settings",
  "#/orgs/org-1/settings/api-keys",
] as const;

describe("every route renders on a cold load", () => {
  it.each(routes)(
    "%s shows a page, not a crash",
    async (hash) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const url = await startApi();
      window.history.replaceState(null, "", hash);
      window.localStorage.clear();
      render(
        <ToastProvider>
          <App session={signedInSession()} apiBaseUrl={url} />
        </ToastProvider>,
      );

      await waitFor(() => expect(document.querySelector(".page__title")).toBeTruthy());
      // A boundary fallback means the page threw. That is the failure this guards.
      expect(document.querySelector(".page__title")?.textContent).not.toBe("This page stopped");
      spy.mockRestore();
    },
    30000,
  );
});
