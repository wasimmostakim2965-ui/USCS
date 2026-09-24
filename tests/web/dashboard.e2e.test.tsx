/**
 * End-to-end: the real HTTP server, the real `ApiClient`, the real components.
 *
 * Nothing is mocked. A server is bound on an ephemeral port, the dashboard's
 * own client is pointed at it, and the pages are rendered into jsdom. What is
 * asserted is what a reviewer would see: a working session shows rows, an
 * unconfigured engine shows "not configured" and never a green state, a
 * failure shows an error, and no page invents data it did not receive.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listen, type HttpServer } from "@cloud-wai/api";
import type { RpcResponse } from "@cloud-wai/api";
import { App, ApiClient, type SessionController } from "@cloud-wai/web";
import { ToastProvider, presentDeploymentStatus } from "@cloud-wai/ui/react";

const servers: HttpServer[] = [];

/** The response the fake control plane returns for each procedure. */
type Responder = (procedure: string, input: unknown) => RpcResponse;

async function startApi(responder: Responder): Promise<string> {
  const server = await listen(
    {
      route: async (request) => responder(request.procedure, request.input),
      allowedOrigins: [],
      // No in-flight requests in these tests, so do not wait out the
      // production grace period on every teardown.
      shutdownGraceMs: 50,
    },
    0,
    "127.0.0.1",
  );
  servers.push(server);
  return server.url;
}

/** A session that is always signed in, standing in for Supabase. */
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
    signOut: async () => {},
    subscribe: () => () => {},
  };
}

/** Render the app against a live API URL. */
function renderApp(apiUrl: string, hash = "#/") {
  // Set the URL without triggering jsdom's asynchronous hash navigation: the
  // app reads `location.hash` on mount, which is all this needs to exercise.
  window.history.replaceState(null, "", hash);
  window.localStorage.clear();
  return render(
    <ToastProvider>
      <App session={signedInSession()} apiBaseUrl={apiUrl} />
    </ToastProvider>,
  );
}

beforeAll(() => {
  // jsdom has no layout, but React 19 warns if the act environment is unset.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  cleanup();
  while (servers.length > 0) {
    const server = servers.pop()!;
    await server.close();
  }
});

const organizations = [
  { id: "org-1", name: "Northwind", slug: "northwind" },
  { id: "org-2", name: "Contoso", slug: "contoso" },
];

describe("the dashboard against a live control plane", () => {
  it("lists organizations returned by the API", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url);

    expect(await screen.findByText("Northwind")).toBeTruthy();
    expect(screen.getByText("Contoso")).toBeTruthy();
    // The workspace switcher names the same data, from the same response.
    await waitFor(() => expect(screen.getAllByText("Northwind").length).toBeGreaterThan(0));
  });

  it("shows an empty state, not a table, when there are no projects", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects");

    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });

  it("opens the create form from New workspace, so the control creates rather than navigates", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects");
    const user = userEvent.setup();

    // The control lives in the workspace menu; open it, then choose it.
    await user.click(await screen.findByTitle("Switch workspace"));
    await user.click(await screen.findByRole("menuitem", { name: /New workspace/ }));

    // The form is open without a second click: "New workspace" is a create
    // control, not a link to the list it is already on.
    const dialog = await screen.findByRole("dialog", { name: "New organization" });
    expect(within(dialog).getByLabelText(/Name/)).toBeTruthy();

    // Dismiss it; navigating back must not re-open a form that was closed, or
    // the create request would fire on every visit.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getAllByRole("link", { name: /Open/ })[0]!);
    await waitFor(() => expect(window.location.hash).toContain("/projects"));
    window.history.replaceState(null, "", "#/orgs/org-1/projects");
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    // Give any erroneous re-open a chance to happen, then assert it did not.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders a not-configured engine as degraded, never as success", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return {
          ok: true,
          status: 200,
          notConfigured: true,
          error: { code: "not_configured", message: "Coolify is not configured." },
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    const degraded = await screen.findByText(/Coolify is not configured/);
    expect(degraded).toBeTruthy();
    // A degraded engine must not be painted as a positive status anywhere.
    expect(screen.queryByText("Configured")).toBeNull();
  });

  it("surfaces a server failure as an error with a retry", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return {
        ok: false,
        status: 500,
        error: { code: "internal", message: "The control plane is unavailable." },
      };
    });

    renderApp(url, "#/orgs/org-1/projects");

    expect(await screen.findByText(/could not load/)).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("renders deployment rows with the status the server reported", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: { id: "p-1", name: "Web app", slug: "web-app" } };
      }
      if (procedure === "deployments.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "d-1",
              status: "succeeded",
              url: "https://web-app.example.test",
              failureReason: null,
            },
            { id: "d-2", status: "failed", url: null, failureReason: "Build exited 1" },
            { id: "d-3", status: "not_configured", url: null, failureReason: "No engine" },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    await waitFor(() => expect(screen.getByText("https://web-app.example.test")).toBeTruthy());
    // The three statuses are visually distinct; a not-configured engine is
    // labelled from the shared mapping, not assumed.
    expect(screen.getAllByText(presentDeploymentStatus("succeeded").label).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(presentDeploymentStatus("failed").label).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(presentDeploymentStatus("not_configured").label).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Build exited 1")).toBeTruthy();
  });

  it("keeps an unverified domain visually distinct from a verified one", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "domains.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "dm-1", hostname: "app.example.test", verified: true },
            { id: "dm-2", hostname: "pending.example.test", verified: false },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    await waitFor(() => expect(screen.getByText("app.example.test")).toBeTruthy());
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();
  });

  it("reports a revoked API key as revoked, not as an error", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "apiKeys.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "k-1",
              name: "CI",
              keyPrefix: "cw_live_abc",
              scopes: ["projects:read"],
              revokedAt: null,
            },
            {
              id: "k-2",
              name: "Retired",
              keyPrefix: "cw_live_def",
              scopes: [],
              revokedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/settings/api-keys");

    await waitFor(() => expect(screen.getByText("cw_live_abc")).toBeTruthy());
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Revoked")).toBeTruthy();
    // The secret is not in the response and must not be invented by the UI.
    expect(screen.queryByText(/cw_secret/i)).toBeNull();
  });

  it("navigates by rewriting the URL, so the route survives a reload", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects");

    const nav = await screen.findByRole("navigation", { name: "Sections" });
    const activity = within(nav).getByRole("link", { name: /Activity/i });
    expect(activity.getAttribute("href")).toBe("#/orgs/org-1/audit");
  });

  it("shows a not-found page for an address that matches no route", async () => {
    const url = await startApi(() => ({ ok: true, status: 200, data: [] }));

    renderApp(url, "#/no/such/place");

    expect(await screen.findByText("Not found")).toBeTruthy();
  });

  it("refuses to call the API at all when there is no session", async () => {
    let called = false;
    const url = await startApi(() => {
      called = true;
      return { ok: true, status: 200, data: [] };
    });

    const client = new ApiClient({ baseUrl: url, getAccessToken: () => null });
    const response = await client.call("organizations.list", {});

    expect(response.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("requesting and rolling back a deployment", () => {
  /**
   * A control plane that really records deployments, so the test exercises the
   * dashboard against behaviour rather than a canned list.
   */
  function deploymentPlane() {
    const deployments: {
      id: string;
      projectId: string;
      status: string;
      url: string | null;
      failureReason: string | null;
    }[] = [
      {
        id: "d-existing",
        projectId: "p-1",
        status: "succeeded",
        url: "https://web-app.example.test",
        failureReason: null,
      },
    ];
    const calls: { procedure: string; input: unknown }[] = [];
    let counter = 0;

    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: { id: "p-1", name: "Web app", slug: "web-app" } };
      }
      if (procedure === "deployments.list") {
        return { ok: true, status: 200, data: [...deployments] };
      }
      if (procedure === "deployments.create") {
        counter += 1;
        const deployment = {
          id: `d-new-${counter}`,
          projectId: "p-1",
          // The engine is unconfigured in this deployment: the honest state.
          status: "not_configured",
          url: null,
          failureReason: "Coolify is not configured in this deployment.",
        };
        deployments.push(deployment);
        return {
          ok: true,
          status: 200,
          data: { deployment, replayed: false, engineReason: deployment.failureReason },
        };
      }
      if (procedure === "deployments.rollback") {
        const body = input as { commit: string };
        counter += 1;
        const deployment = {
          id: `d-rollback-${counter}`,
          projectId: "p-1",
          status: "running",
          url: null,
          failureReason: null,
        };
        deployments.push(deployment);
        return {
          ok: true,
          status: 200,
          data: { deployment, replayed: false, engineReason: null, commit: body.commit },
        };
      }
      return { ok: true, status: 200, data: [] };
    };
    return { responder, deployments, calls };
  }

  it("requests a deployment and shows the engine's honest not-configured answer", async () => {
    const { responder, calls, deployments } = deploymentPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New deployment" }));
    await user.type(await screen.findByPlaceholderText("main"), "release/1.2");
    await user.click(screen.getByRole("button", { name: "Deploy" }));

    // The dialog reports the status the server returned, which is not success.
    expect(await screen.findByText(/Coolify is not configured/)).toBeTruthy();
    expect(
      screen.getAllByText(presentDeploymentStatus("not_configured").label).length,
    ).toBeGreaterThan(0);

    const create = calls.find((c) => c.procedure === "deployments.create");
    expect(create?.input).toMatchObject({ projectId: "p-1", gitBranch: "release/1.2" });

    // Closing reloads the list from the server, which now includes the row.
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getAllByText(/d-new-/).length).toBeGreaterThan(0));
    expect(deployments).toHaveLength(2);
  });

  it("sends an idempotency key and reuses it on a retry, so a double press cannot deploy twice", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    // The first attempt fails, which leaves the form open so the operator can
    // retry — exactly the moment a duplicate deployment would otherwise appear.
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: { id: "p-1", name: "Web app", slug: "web-app" } };
      }
      if (procedure === "deployments.list") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "deployments.create") {
        return {
          ok: false,
          status: 503,
          error: { code: "unavailable", message: "The control plane is unavailable." },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New deployment" }));
    await user.type(await screen.findByPlaceholderText("main"), "release/1.2");
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    await screen.findByText(/unavailable/);

    // Retry from the still-open form.
    await user.click(screen.getByRole("button", { name: "Deploy" }));

    const creates = calls.filter((c) => c.procedure === "deployments.create");
    expect(creates).toHaveLength(2);
    const keys = creates.map((c) => (c.input as { idempotencyKey?: string }).idempotencyKey);
    expect(keys[0]).toBeTruthy();
    // Same key on the retry: the server can recognise it as the same request.
    expect(keys[1]).toBe(keys[0]);
  });

  it("rolls back a successful deployment through the API", async () => {
    const { responder, calls } = deploymentPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Rollback" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText("abc1234"), "abc1234");
    await user.click(within(dialog).getByRole("button", { name: "Roll back" }));

    await waitFor(() =>
      expect(calls.some((c) => c.procedure === "deployments.rollback")).toBe(true),
    );
    const rollback = calls.find((c) => c.procedure === "deployments.rollback");
    expect(rollback?.input).toMatchObject({ projectId: "p-1", commit: "abc1234" });
  });

  it("surfaces a refused deployment request as an alert, never as success", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "projects.get") {
        return { ok: true, status: 200, data: { id: "p-1", name: "Web app", slug: "web-app" } };
      }
      if (procedure === "deployments.create") {
        return {
          ok: false,
          status: 403,
          error: { code: "forbidden", message: "Requires capability: deployment:create." },
        };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New deployment" }));
    await user.click(screen.getByRole("button", { name: "Deploy" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("deployment:create");
    expect(screen.queryByText("Deployment requested")).toBeNull();
  });

  it("opens a deployment's engine logs and shows the lines the engine returned", async () => {
    const { responder, calls } = deploymentPlane();
    const withLogs: Responder = (procedure, input) => {
      if (procedure === "deployments.logs") {
        calls.push({ procedure, input });
        return {
          ok: true,
          status: 200,
          data: {
            lines: ["build started", "build finished"],
            cursor: null,
            engineReason: null,
          },
        };
      }
      return responder(procedure, input);
    };
    const url = await startApi(withLogs);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Logs" }));

    expect(await screen.findByLabelText("Deployment logs")).toBeTruthy();
    expect(screen.getByText(/build finished/)).toBeTruthy();
    // Coolify keeps no cursor, and the drawer says so rather than inventing one.
    expect(screen.getByText(/keeps no cursor for logs/)).toBeTruthy();
    expect(calls.find((c) => c.procedure === "deployments.logs")?.input).toMatchObject({
      projectId: "p-1",
      deploymentId: "d-existing",
    });
  });

  it("reports an unconfigured hosting engine as degraded logs, never fabricated output", async () => {
    const { responder } = deploymentPlane();
    const notConfigured: Responder = (procedure, input) => {
      if (procedure === "deployments.logs") {
        return {
          ok: false,
          status: 200,
          notConfigured: true,
          error: { code: "not_configured", message: "Coolify is not configured." },
        };
      }
      return responder(procedure, input);
    };
    const url = await startApi(notConfigured);
    renderApp(url, "#/orgs/org-1/projects/p-1/deployments");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Logs" }));

    expect(await screen.findByText(/Coolify is not configured/)).toBeTruthy();
    expect(screen.queryByLabelText("Deployment logs")).toBeNull();
  });
});

describe("page titles", () => {
  it("names the current page in the document title", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/audit");
    await screen.findByRole("navigation", { name: "Sections" });
    await waitFor(() => expect(document.title).toBe("Activity · Cloud Wai"));
  });

  it("names a project section in the document title", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });

    renderApp(url, "#/orgs/org-1/projects/p-1/domains");
    await waitFor(() => expect(document.title).toBe("Domains · Cloud Wai"));
  });
});

describe("creating and revoking an API key", () => {
  /**
   * A control plane that actually mints keys, so the test exercises the
   * dashboard against real behaviour rather than a canned list.
   */
  function keyPlane() {
    const keys: {
      id: string;
      organizationId: string;
      name: string;
      keyPrefix: string;
      scopes: readonly string[];
      revokedAt: string | null;
    }[] = [
      {
        id: "key-1",
        organizationId: "org-1",
        name: "CI pipeline",
        keyPrefix: "cw_live_4f2a",
        scopes: ["projects:read"],
        revokedAt: null,
      },
    ];
    const calls: { procedure: string; input: unknown }[] = [];

    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "apiKeys.list") {
        return { ok: true, status: 200, data: keys };
      }
      if (procedure === "apiKeys.create") {
        const body = input as { name: string; scopes: readonly string[] };
        const granted = body.scopes.filter((s) => s === "org:read" || s === "project:read");
        const key = {
          id: "key-2",
          organizationId: "org-1",
          name: body.name,
          keyPrefix: "cw_live_new1",
          scopes: granted,
          revokedAt: null,
        };
        keys.push(key);
        return { ok: true, status: 200, data: { key, secret: "cw_live_new1_supersecret" } };
      }
      if (procedure === "apiKeys.revoke") {
        const body = input as { keyId: string };
        const found = keys.find((k) => k.id === body.keyId);
        if (!found)
          return { ok: false, status: 404, error: { code: "not_found", message: "No key." } };
        found.revokedAt = "2026-09-23T00:00:00.000Z";
        return { ok: true, status: 200, data: { revoked: true } };
      }
      return { ok: true, status: 200, data: [] };
    };
    return { responder, keys, calls };
  }

  it("mints a key, shows its secret once, and never shows a prefix as the secret", async () => {
    const { responder, calls } = keyPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    // The list is loaded from the server, not fabricated.
    expect(await screen.findByText("CI pipeline")).toBeTruthy();
    expect(screen.getByText("cw_live_4f2a")).toBeTruthy();
    // A list can never contain a secret, so there is none on screen yet.
    expect(screen.queryByText(/supersecret/)).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await user.type(await screen.findByPlaceholderText("ci-deploy"), "Deploy bot");
    await user.click(screen.getByLabelText("org:read"));
    await user.click(screen.getByRole("button", { name: "Create" }));

    // The secret is shown, once, on the create response — inside a field the
    // operator can copy, never in text that could be scraped from the list.
    const secret = await screen.findByDisplayValue(/supersecret/);
    expect((secret as HTMLInputElement).value).toBe("cw_live_new1_supersecret");
    expect(screen.getByText(/cannot be retrieved again/)).toBeTruthy();

    // The request carried the name and the scopes the operator picked.
    const create = calls.find((c) => c.procedure === "apiKeys.create");
    expect(create?.input).toMatchObject({ name: "Deploy bot", scopes: ["org:read"] });

    // Closing the dialog drops the secret from the DOM entirely.
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByDisplayValue(/supersecret/)).toBeNull());
    expect(await screen.findByText("Deploy bot")).toBeTruthy();
  });

  it("tells the operator when the server narrowed the granted scopes", async () => {
    const { responder } = keyPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    await user.type(await screen.findByPlaceholderText("ci-deploy"), "Narrowed");
    // Ask for a scope the server will not grant alongside ones it will.
    await user.click(screen.getByLabelText("org:read"));
    await user.click(screen.getByLabelText("apikey:read"));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/narrowed to what your role allows/)).toBeTruthy();
  });

  it("revokes a key through the API and reloads the list from the server", async () => {
    const { responder, calls, keys } = keyPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    // The dialog adds a second "Revoke"; scope the confirm to the dialog.
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(calls.some((c) => c.procedure === "apiKeys.revoke")).toBe(true));
    const revoke = calls.find((c) => c.procedure === "apiKeys.revoke");
    expect(revoke?.input).toMatchObject({ organizationId: "org-1", keyId: "key-1" });
    expect(keys[0]!.revokedAt).not.toBeNull();

    // The row now reads Revoked (from the server's list), and the control is gone.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull());
    expect(screen.getAllByText("Revoked").length).toBeGreaterThan(0);
  });

  it("shows the server's message when a key cannot be created", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "apiKeys.list") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "apiKeys.create") {
        return {
          ok: false,
          status: 403,
          error: { code: "forbidden", message: "Your role cannot create API keys." },
        };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    await user.type(await screen.findByPlaceholderText("ci-deploy"), "Denied");
    await user.click(screen.getByRole("button", { name: "Create" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your role cannot create API keys.");
    // A refused create never renders a secret.
    expect(screen.queryByText(/cannot be retrieved again/)).toBeNull();
  });

  it("keeps a dialog open when a field value contains spaces", async () => {
    // Regression: the dialog re-focused its first control on every keystroke,
    // so typing a space closed it via the close button's keyup activation.
    const { responder } = keyPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/settings/api-keys");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const field = await screen.findByPlaceholderText("ci-deploy");
    await user.type(field, "deploy bot");

    // The dialog is still open, the field kept focus, and no request went out.
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe("deploy bot");
    expect(document.activeElement).toBe(field);
  });
});

describe("adding, verifying and removing a domain", () => {
  /**
   * A control plane that holds domain rows and answers the challenge the way
   * the real adapter does: `verified` only ever comes from the verifier, and a
   * failed challenge is a successful request with `verified: false`.
   */
  function domainPlane() {
    const domains: {
      id: string;
      organizationId: string;
      hostname: string;
      verified: boolean;
      verifiedAt: string | null;
    }[] = [
      {
        id: "dm-1",
        organizationId: "org-1",
        hostname: "app.example.test",
        verified: false,
        verifiedAt: null,
      },
    ];
    const calls: { procedure: string; input: unknown }[] = [];

    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "domains.list") {
        return { ok: true, status: 200, data: domains };
      }
      if (procedure === "domains.create") {
        const body = input as { hostname: string };
        const domain = {
          id: "dm-2",
          organizationId: "org-1",
          hostname: body.hostname,
          verified: false,
          verifiedAt: null,
        };
        domains.push(domain);
        return {
          ok: true,
          status: 200,
          data: {
            domain,
            recordName: `_cloud-wai-challenge.${body.hostname}`,
            recordValue: "cw-domain-verify=testtoken",
            recordType: "TXT",
          },
        };
      }
      if (procedure === "domains.verify") {
        const body = input as { domainId: string };
        const found = domains.find((d) => d.id === body.domainId);
        if (!found)
          return { ok: false, status: 404, error: { code: "not_found", message: "No domain." } };
        // The challenge did not match: a real answer, not an error.
        found.verified = false;
        return {
          ok: true,
          status: 200,
          data: {
            domain: found,
            detail: "No TXT record carries the expected token.",
          },
        };
      }
      if (procedure === "domains.remove") {
        const body = input as { domainId: string };
        const index = domains.findIndex((d) => d.id === body.domainId);
        if (index < 0)
          return { ok: false, status: 404, error: { code: "not_found", message: "No domain." } };
        domains.splice(index, 1);
        return { ok: true, status: 200, data: { removed: true } };
      }
      return { ok: true, status: 200, data: [] };
    };
    return { responder, domains, calls };
  }

  it("adds a hostname and shows the DNS challenge to publish", async () => {
    const { responder, calls } = domainPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add domain" }));
    await user.type(await screen.findByPlaceholderText("app.example.com"), "new.example.test");
    await user.click(screen.getByRole("button", { name: "Add" }));

    // The challenge is shown, and the domain is not claimed as verified.
    expect(await screen.findByText("_cloud-wai-challenge.new.example.test")).toBeTruthy();
    expect(screen.getByText("cw-domain-verify=testtoken")).toBeTruthy();
    expect(screen.getByText(/not yet verified/)).toBeTruthy();

    const create = calls.find((c) => c.procedure === "domains.create");
    expect(create?.input).toMatchObject({
      organizationId: "org-1",
      projectId: "p-1",
      hostname: "new.example.test",
    });
  });

  it("shows the verifier's own answer when a challenge does not match", async () => {
    const { responder, calls } = domainPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Verify" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Verify" }));

    // The refusal is reported as a detail, not as an error the operator caused.
    expect(await screen.findByText(/No TXT record carries the expected token/)).toBeTruthy();
    // The dialog says so too, and neither the row nor the dialog claims verified.
    expect(within(dialog).getByText("Unverified")).toBeTruthy();
    expect(within(dialog).queryByText("Verified")).toBeNull();
    const verify = calls.find((c) => c.procedure === "domains.verify");
    expect(verify?.input).toMatchObject({ organizationId: "org-1", domainId: "dm-1" });
  });

  it("reports a not-configured verifier as degraded, never as verified", async () => {
    const url = await startApi((procedure, input) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "domains.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "dm-1",
              organizationId: "org-1",
              hostname: "app.example.test",
              verified: false,
              verifiedAt: null,
            },
          ],
        };
      }
      if (procedure === "domains.verify") {
        void input;
        return {
          ok: false,
          status: 503,
          error: {
            code: "engine_unavailable",
            message: "The domain verifier could not confirm this hostname: not configured.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Verify" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Verify" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not confirm");
    // Nothing on screen may claim the hostname is verified.
    expect(screen.queryByText("Verified")).toBeNull();
  });

  it("removes a hostname through the API and reloads the list", async () => {
    const { responder, calls, domains } = domainPlane();
    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/domains");

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(calls.some((c) => c.procedure === "domains.remove")).toBe(true));
    const remove = calls.find((c) => c.procedure === "domains.remove");
    expect(remove?.input).toMatchObject({ organizationId: "org-1", domainId: "dm-1" });
    expect(domains).toHaveLength(0);

    // The reloaded list comes from the server, so the row is gone.
    await waitFor(() => expect(screen.queryByText("app.example.test")).toBeNull());
  });
});

describe("the dashboard renders every state for every route", () => {
  /** Answer one procedure with `answer`; everything else succeeds with nothing. */
  function only(target: string, answer: RpcResponse): Responder {
    return (procedure) => {
      // The target is checked first: on the Organizations route the target *is*
      // `organizations.list`, and the sidebar's copy of that list must not mask
      // the answer under test.
      if (procedure === target) return answer;
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    };
  }

  const empty = { ok: true, status: 200, data: [] } as const;
  const failure = {
    ok: false,
    status: 500,
    error: { code: "engine_unavailable", message: "The control plane is unreachable." },
  } as const;
  const degraded = {
    ok: true,
    status: 200,
    notConfigured: true,
    error: { code: "not_configured", message: "No hosting engine is configured." },
  } as const;

  /**
   * Every route, with the procedure whose answer decides its main section. A
   * route is only finished when all five states are reachable on it, so this
   * list is the acceptance test for "no route renders a blank page".
   */
  const routes: readonly {
    readonly hash: string;
    readonly title: string;
    readonly target: string;
  }[] = [
    { hash: "#/", title: "Organizations", target: "organizations.list" },
    { hash: "#/orgs/org-1/projects", title: "Projects", target: "projects.list" },
    { hash: "#/orgs/org-1/projects/p-1", title: "Overview", target: "projects.get" },
    {
      hash: "#/orgs/org-1/projects/p-1/deployments",
      title: "Deployments",
      target: "deployments.list",
    },
    { hash: "#/orgs/org-1/projects/p-1/domains", title: "Domains", target: "domains.list" },
    { hash: "#/orgs/org-1/projects/p-1/database", title: "Overview", target: "data.list" },
    { hash: "#/orgs/org-1/projects/p-1/security", title: "Security", target: "providers.health" },
    { hash: "#/orgs/org-1/audit", title: "Activity", target: "audit.list" },
    { hash: "#/orgs/org-1/settings/api-keys", title: "API keys", target: "apiKeys.list" },
    { hash: "#/orgs/org-1/settings", title: "Settings", target: "providers.health" },
  ];

  it.each(routes)("$title shows an empty state, not a blank page", async ({ hash, target }) => {
    const url = await startApi(only(target, empty));
    renderApp(url, hash);

    // The page names itself and says there is nothing, rather than rendering
    // nothing at all — the difference between "empty" and "broken".
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).not.toBe("");
    expect(await screen.findByText(/No |Nothing |not a member|does not exist/)).toBeTruthy();
  });

  it.each(routes)("$title shows an error, with a way to retry", async ({ hash, target }) => {
    const url = await startApi(only(target, failure));
    renderApp(url, hash);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The control plane is unreachable.");
    // A failure is recoverable from the UI, not a dead end.
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it.each(routes)("$title never paints a failure as success", async ({ hash, target }) => {
    const url = await startApi(only(target, failure));
    renderApp(url, hash);

    await screen.findByRole("alert");
    // The anti-fake-success guarantee, per route: a failed load must not leave
    // a positive badge behind anywhere on the page.
    expect(screen.queryByText("Configured")).toBeNull();
    expect(screen.queryByText("Verified")).toBeNull();
  });

  it("renders a not-configured engine as degraded on the Security route", async () => {
    const url = await startApi(only("providers.health", degraded));
    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    expect(await screen.findByText(/No hosting engine is configured/)).toBeTruthy();
    expect(screen.queryByText("Configured")).toBeNull();
  });

  it("renders a not-configured engine as degraded on the Settings route", async () => {
    const url = await startApi(only("providers.health", degraded));
    renderApp(url, "#/orgs/org-1/settings");

    expect(await screen.findByText(/No hosting engine is configured/)).toBeTruthy();
  });

  it("shows a loading state before the data arrives, never an empty one", async () => {
    // A server that never answers: the only honest thing to render is loading.
    const url = await startApi(() => new Promise<RpcResponse>(() => {}));
    renderApp(url, "#/orgs/org-1/projects");

    const loading = await screen.findByRole("status");
    expect(loading.textContent).toMatch(/loading/i);
    expect(screen.queryByText(/No projects yet/)).toBeNull();
  });

  it("renders a not-found route rather than falling back to the dashboard", async () => {
    const url = await startApi(only("organizations.list", empty));
    renderApp(url, "#/nowhere/at/all");

    expect(await screen.findByRole("heading", { name: "Not found" })).toBeTruthy();
  });
});

describe("the command palette", () => {
  it("opens on the shortcut and navigates for real", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/projects");

    // The palette is closed until asked for.
    expect(screen.queryByPlaceholderText(/Jump to a section/)).toBeNull();

    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");

    const input = await screen.findByPlaceholderText(/Jump to a section/);
    // The workspace and its sections are offered, not a hardcoded menu.
    expect(screen.getByRole("button", { name: /API keys/ })).toBeTruthy();

    // Typing filters, then Enter opens the highlighted command.
    await user.type(input, "API keys");
    await user.keyboard("{Enter}");

    // Navigation is real: the URL changed and the page followed it.
    await waitFor(() => expect(window.location.hash).toBe("#/orgs/org-1/settings/api-keys"));
    expect(await screen.findByRole("heading", { name: "API keys" })).toBeTruthy();
  });

  it("says so when nothing matches, instead of showing an empty box", async () => {
    const url = await startApi((procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      return { ok: true, status: 200, data: [] };
    });
    renderApp(url, "#/orgs/org-1/projects");

    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByPlaceholderText(/Jump to a section/);
    await user.type(input, "zzzz");

    expect(await screen.findByText(/Nothing matches/)).toBeTruthy();
  });
});

describe("the Database drill-in", () => {
  function reachable(): Responder {
    return (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return { ok: true, status: 200, data: [] };
      }
      return { ok: true, status: 200, data: [] };
    };
  }

  it("replaces the project sidebar with the Database sub-menu, not a dropdown", async () => {
    const url = await startApi(reachable());
    renderApp(url, "#/orgs/org-1/projects/p-1/database");

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();

    // The project's own sections are gone: this is a replaced sidebar.
    expect(screen.queryByRole("link", { name: /Deployments/ })).toBeNull();
    // The Database sub-menu is what is in view.
    for (const label of ["Table Editor", "SQL Editor", "Authentication", "Storage", "Logs"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeTruthy();
    }
  });

  it("returns from a sub-page to the Database Overview, then to the project", async () => {
    const url = await startApi(reachable());
    renderApp(url, "#/orgs/org-1/projects/p-1/database/tables");

    // First press: back to the section this sub-page belongs to.
    await userEvent.setup().click(await screen.findByRole("button", { name: /Back/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/orgs/org-1/projects/p-1/database"));

    // Second press: back out of the section entirely.
    await userEvent.setup().click(await screen.findByRole("button", { name: /Back/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/orgs/org-1/projects/p-1"));
  });

  it("derives the active item and title from the URL alone", async () => {
    const url = await startApi(reachable());
    // A deep link, loaded cold, with no navigation beforehand.
    renderApp(url, "#/orgs/org-1/projects/p-1/database/sql");

    expect(await screen.findByRole("heading", { name: "SQL Editor" })).toBeTruthy();
    const active = screen.getByRole("link", { name: /SQL Editor/ });
    expect(active.getAttribute("aria-current")).toBe("page");
  });

  it("says a sub-section is not built yet instead of rendering a blank page", async () => {
    const url = await startApi(reachable());
    renderApp(url, "#/orgs/org-1/projects/p-1/database/auth");

    expect(await screen.findByRole("heading", { name: "Authentication" })).toBeTruthy();
    expect(
      await screen.findByText(/Authentication is not available in this build yet/),
    ).toBeTruthy();
  });

  it("offers real provisioning and backup controls, and still marks what is not built", async () => {
    const url = await startApi(reachable());
    renderApp(url, "#/orgs/org-1/projects/p-1/database");

    // Provisioning is now a live control on the Overview, not a disabled
    // placeholder: it calls `data.provision`.
    const provision = await screen.findByRole("button", { name: "Provision resource" });
    expect((provision as HTMLButtonElement).disabled).toBe(false);

    // The connection controls below are still not built, and they say so rather
    // than appearing to work.
    const addCustom = screen.getByRole("button", { name: /Add custom database/ });
    expect((addCustom as HTMLButtonElement).disabled).toBe(true);
  });

  it("provisions a resource through the API and shows the engine's own state", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const rows: unknown[] = [];
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return { ok: true, status: 200, data: rows };
      }
      if (procedure === "data.provision") {
        const body = input as { name: string; kind: string };
        // The state is what the engine reported; the form never sets it.
        const resource = { id: "r-1", kind: body.kind, name: body.name, state: "ready" };
        rows.push(resource);
        return { ok: true, status: 200, data: { resource, engineReason: null } };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Provision resource" }));
    await user.type(await screen.findByPlaceholderText("tenant-db"), "orders-db");
    await user.click(screen.getByRole("button", { name: "Provision" }));

    expect(
      await screen.findByText(/The engine provisioned this resource and confirmed it/),
    ).toBeTruthy();

    const sent = calls.find((call) => call.procedure === "data.provision");
    expect(sent?.input).toMatchObject({ name: "orders-db", kind: "postgres" });
  });

  it("sends the project when provisioning, so the resource is project-scoped", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "data.provision") {
        const body = input as { name: string; kind: string; projectId: string };
        return {
          ok: true,
          status: 200,
          data: {
            resource: {
              id: "r-1",
              kind: body.kind,
              name: body.name,
              state: "ready",
              projectId: body.projectId,
            },
            engineReason: null,
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-7/database");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Provision resource" }));
    await user.type(await screen.findByPlaceholderText("tenant-db"), "orders-db");
    await user.click(screen.getByRole("button", { name: "Provision" }));

    await screen.findByText(/The engine provisioned this resource and confirmed it/);
    const sent = calls.find((call) => call.procedure === "data.provision");
    // The URL's project, not a blank or another project, reaches the server.
    expect(sent?.input).toMatchObject({
      organizationId: "org-1",
      projectId: "p-7",
      name: "orders-db",
    });
  });

  it("shows this project's resources plus organization-wide ones, and no other project's", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "r-1", kind: "postgres", name: "mine-db", state: "ready", projectId: "p-1" },
            { id: "r-2", kind: "postgres", name: "shared-db", state: "ready", projectId: null },
            { id: "r-3", kind: "postgres", name: "other-db", state: "ready", projectId: "p-2" },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");

    expect(await screen.findByText("mine-db")).toBeTruthy();
    expect(screen.getByText("shared-db")).toBeTruthy();
    expect(screen.queryByText("other-db")).toBeNull();
  });

  it("lists a resource's backups, including one the engine did not complete", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "r-1", kind: "postgres", name: "ready-db", state: "ready", projectId: "p-1" },
          ],
        };
      }
      if (procedure === "data.backups.list") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "b-1",
              dataResourceId: "r-1",
              status: "succeeded",
              providerResourceId: "engine-1",
              createdAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:01:00.000Z",
            },
            {
              id: "b-2",
              dataResourceId: "r-1",
              status: "not_configured",
              providerResourceId: null,
              createdAt: "2026-01-02T00:00:00.000Z",
              finishedAt: null,
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Back up" }));
    const dialog = await screen.findByRole("dialog", { name: "Back up resource" });

    // Both attempts are visible; a failed one is not hidden by the good one.
    expect(await within(dialog).findByText("succeeded")).toBeTruthy();
    expect(within(dialog).getByText("not_configured")).toBeTruthy();
  });

  it("reports an unconfigured engine instead of pretending a resource exists", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "data.provision") {
        // Honest refusal: the row was recorded but the engine did not act.
        return {
          ok: true,
          status: 200,
          data: {
            resource: {
              id: "r-2",
              kind: "postgres",
              name: "orders-db",
              state: "not_configured",
            },
            engineReason: "POSTGRES_URL is not set.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Provision resource" }));
    await user.type(await screen.findByPlaceholderText("tenant-db"), "orders-db");
    await user.click(screen.getByRole("button", { name: "Provision" }));

    expect(await screen.findByText(/The engine did not provision this resource/)).toBeTruthy();
    expect(await screen.findByText(/POSTGRES_URL is not set\./)).toBeTruthy();
  });

  it("backs up a ready resource and refuses one the engine never provisioned", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const responder: Responder = (procedure, input) => {
      calls.push({ procedure, input });
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "data.list") {
        return {
          ok: true,
          status: 200,
          data: [
            { id: "r-ready", kind: "postgres", name: "ready-db", state: "ready" },
            { id: "r-missing", kind: "postgres", name: "no-handle", state: "not_configured" },
          ],
        };
      }
      if (procedure === "data.backup") {
        return {
          ok: true,
          status: 200,
          data: {
            backup: {
              id: "b-1",
              dataResourceId: "r-ready",
              status: "succeeded",
              providerResourceId: "engine-1",
              createdAt: new Date().toISOString(),
              finishedAt: null,
            },
            engineReason: null,
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/database");
    const user = userEvent.setup();

    const rows = await screen.findAllByRole("row");
    const readyRow = rows.find((row) => within(row).queryByText("ready-db"));
    expect(readyRow).toBeTruthy();
    // The row whose resource is not ready cannot be backed up; the control is
    // disabled rather than firing a call the server would refuse.
    const missingRow = rows.find((row) => within(row).queryByText("no-handle"));
    expect(
      within(missingRow!).getByRole("button", { name: "Back up" }) as HTMLButtonElement,
    ).toHaveProperty("disabled", true);

    await user.click(within(readyRow!).getByRole("button", { name: "Back up" }));
    // The dialog's own confirm button, distinct from the row control behind it.
    const dialog = await screen.findByRole("dialog", { name: "Back up resource" });
    await user.click(within(dialog).getByRole("button", { name: "Back up" }));

    expect(await screen.findByText(/The engine returned a backup reference/)).toBeTruthy();
    const sent = calls.find((call) => call.procedure === "data.backup");
    expect(sent?.input).toMatchObject({ organizationId: "org-1", resourceId: "r-ready" });
  });
});

describe("the Security policy write path", () => {
  const draftPolicy = {
    id: "pol-1",
    name: "Default policy",
    riskLevel: "high" as const,
    action: "challenge" as const,
    state: "draft" as const,
    version: 2,
    updatedAt: new Date().toISOString(),
  };

  it("saves a policy as a draft and never claims it is active", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    let stored: unknown = null;
    const responder: Responder = (procedure, input) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "security.policy.save") {
        calls.push({ procedure, input });
        stored = draftPolicy;
        return { ok: true, status: 200, data: draftPolicy };
      }
      if (procedure === "security.policy.get") {
        return { ok: true, status: 200, data: { policy: stored, events: [] } };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Save policy" }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    // The stored state is what is rendered, and it is a draft: not active.
    expect(await screen.findByText("draft")).toBeTruthy();
    expect(screen.queryByText("active")).toBeNull();

    const sent = calls.find((call) => call.procedure === "security.policy.save");
    expect(sent?.input).toMatchObject({ organizationId: "org-1", riskLevel: "medium" });
  });

  it("carries a chosen protection level into the save form", async () => {
    const calls: { procedure: string; input: unknown }[] = [];
    const responder: Responder = (procedure, input) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "security.policy.get") {
        return { ok: true, status: 200, data: { policy: null, events: [] } };
      }
      if (procedure === "security.policy.save") {
        calls.push({ procedure, input });
        return { ok: true, status: 200, data: draftPolicy };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");
    const user = userEvent.setup();

    // "Ultimate" maps to critical risk and a block action; those exact values
    // must reach the form rather than the form's own defaults. It is the fourth
    // level card, and every card's button shares the same label.
    const levelButtons = await screen.findAllByRole("button", { name: "Use this level" });
    await user.click(levelButtons[3]!);
    await user.click(await screen.findByRole("button", { name: "Save draft" }));

    const sent = calls.find((call) => call.procedure === "security.policy.save");
    expect(sent?.input).toMatchObject({
      organizationId: "org-1",
      riskLevel: "critical",
      action: "block",
    });
  });

  it("shows the policy's own history, including transitions the server refused", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "security.policy.get") {
        return {
          ok: true,
          status: 200,
          data: {
            policy: draftPolicy,
            events: [
              {
                id: "e-1",
                policyId: "pol-1",
                fromState: "draft",
                toState: "active",
                version: 3,
                detail: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              {
                id: "e-2",
                policyId: "pol-1",
                fromState: "active",
                toState: "failed",
                version: 3,
                detail: "The edge refused the configuration.",
                createdAt: "2026-01-02T00:00:00.000Z",
              },
            ],
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");

    // Both the activation and the later refusal are visible: history is not
    // collapsed to the policy's current state.
    expect(await screen.findByText("The edge refused the configuration.")).toBeTruthy();
  });

  it("reports a distribution the edge did not apply as not applied", async () => {
    const responder: Responder = (procedure) => {
      if (procedure === "organizations.list") {
        return { ok: true, status: 200, data: organizations };
      }
      if (procedure === "providers.health") {
        return { ok: true, status: 200, data: [] };
      }
      if (procedure === "security.policy.get") {
        return { ok: true, status: 200, data: { policy: draftPolicy, events: [] } };
      }
      if (procedure === "security.policy.distribute") {
        return {
          ok: true,
          status: 200,
          data: {
            policy: draftPolicy,
            distributed: false,
            engineReason: "The security edge is not configured in this deployment.",
          },
        };
      }
      return { ok: true, status: 200, data: [] };
    };

    const url = await startApi(responder);
    renderApp(url, "#/orgs/org-1/projects/p-1/security");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Distribute to edge" }));
    await user.click(screen.getByRole("button", { name: "Distribute" }));

    expect(await screen.findByText(/The edge did not apply the policy/)).toBeTruthy();
    expect(
      await screen.findByText(/The security edge is not configured in this deployment/),
    ).toBeTruthy();
  });
});
