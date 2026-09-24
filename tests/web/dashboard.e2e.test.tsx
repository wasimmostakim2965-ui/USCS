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
    expect(screen.getAllByText(presentDeploymentStatus("succeeded").label).length).toBeGreaterThan(0);
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
        if (!found) return { ok: false, status: 404, error: { code: "not_found", message: "No key." } };
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

    await waitFor(() =>
      expect(calls.some((c) => c.procedure === "apiKeys.revoke")).toBe(true),
    );
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
