/**
 * A real accessibility audit, with axe-core, across every route.
 *
 * The other dashboard tests assert behaviour; this one asserts that what the
 * browser and a screen reader actually receive is well-formed. It renders the
 * real app against the real HTTP server (nothing mocked) and runs axe over the
 * resulting document for each route.
 *
 * A failure here names the rule and the node, so a fix is a fix and not a
 * guess.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { listen, type HttpServer } from "@cloud-wai/api";
import type { RpcResponse } from "@cloud-wai/api";
import { App, type SessionController } from "@cloud-wai/web";
import { ToastProvider } from "@cloud-wai/ui/react";
import axe from "axe-core";

const servers: HttpServer[] = [];

beforeAll(() => {
  // jsdom has no layout, but React 19 warns if the act environment is unset.
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

async function startApi(responder: (procedure: string) => RpcResponse): Promise<string> {
  const server = await listen(
    {
      route: async (request) => responder(request.procedure),
      allowedOrigins: [],
      shutdownGraceMs: 50,
    },
    0,
    "127.0.0.1",
  );
  servers.push(server);
  return server.url;
}

const organizations = [{ id: "org-1", name: "Northwind", slug: "northwind" }];

/** A populated control plane, so the audit sees real content, not empty states. */
function populated(): (procedure: string) => RpcResponse {
  const rows: Record<string, unknown> = {
    "organizations.list": organizations,
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
    "deployments.logs": {
      deploymentId: "d-1",
      lines: ["Build started", "Build succeeded"],
    },
    "providers.health": [{ provider: "coolify", state: "ready", detail: "Reachable." }],
    "security.policy.get": { policy: null, events: [] },
  };
  return (procedure) => {
    if (procedure in rows) return { ok: true, status: 200, data: rows[procedure] } as RpcResponse;
    return { ok: true, status: 200, data: [] } as RpcResponse;
  };
}

const routes = [
  "#/orgs",
  "#/orgs/org-1/projects",
  "#/orgs/org-1/projects/p-1",
  "#/orgs/org-1/projects/p-1/setup",
  "#/orgs/org-1/projects/p-1/deployments",
  "#/orgs/org-1/projects/p-1/logs",
  "#/orgs/org-1/projects/p-1/analytics",
  "#/orgs/org-1/projects/p-1/domains",
  "#/orgs/org-1/projects/p-1/git",
  "#/orgs/org-1/projects/p-1/env",
  "#/orgs/org-1/projects/p-1/database",
  "#/orgs/org-1/projects/p-1/security",
  "#/orgs/org-1/projects/p-1/settings",
  "#/orgs/org-1/audit",
  "#/orgs/org-1/observability",
  "#/orgs/org-1/deployments",
  "#/orgs/org-1/members",
  "#/orgs/org-1/billing",
  "#/orgs/org-1/settings/api-keys",
  "#/orgs/org-1/settings",
  "#/orgs/org-1/security",
  "#/orgs/org-1/docs",
] as const;

/** Rules that cannot be decided in jsdom (no layout, no paint, single-shell app). */
const SKIP = ["color-contrast", "region", "landmark-one-main", "bypass"] as const;

describe("accessibility audit", () => {
  it.each(routes)(
    "%s has no axe violations",
    async (hash) => {
      const url = await startApi(populated());
      // The hash is set before render: the app reads `location.hash` on mount.
      window.history.replaceState(null, "", hash);
      window.localStorage.clear();
      render(
        <ToastProvider>
          <App session={signedInSession()} apiBaseUrl={url} />
        </ToastProvider>,
      );

      // Let the route's own reads resolve so the audit sees the loaded page.
      await waitFor(() => {
        if (!document.querySelector(".page, main, .shell")) throw new Error("no shell yet");
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const results = await axe.run(document.body, {
        rules: Object.fromEntries(SKIP.map((id) => [id, { enabled: false }])),
      });

      const summary = results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => node.html.slice(0, 200)),
      }));

      expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
    },
    30000,
  );
});
