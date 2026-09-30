/**
 * The error boundary, proved by throwing through it.
 *
 * A render error in one page used to unmount the whole tree: a white screen
 * with no sidebar and no way back. These tests assert the opposite — the shell
 * survives, the failure is named, and a retry is offered.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { listen, type HttpServer } from "@cloud-wai/api";
import type { RpcResponse } from "@cloud-wai/api";
import { App, type SessionController } from "@cloud-wai/web";
import { ErrorBoundary, ToastProvider } from "@cloud-wai/ui/react";

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

function Boom(): never {
  throw new Error("the log viewer exploded");
}

describe("the error boundary", () => {
  it("shows a named apology instead of a blank page", () => {
    // React logs the caught error to console.error; the boundary handling it is
    // the point, so the noise is silenced rather than asserted on.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "This page stopped" })).toBeTruthy();
    // The message names the fault, so a bug report is specific.
    expect(screen.getByText("the log viewer exploded")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    spy.mockRestore();
  });

  it("recovers on retry once the fault has cleared", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    function Sometimes() {
      if (broken) throw new Error("transient");
      return <p>recovered content</p>;
    }

    render(
      <ErrorBoundary>
        <Sometimes />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("heading", { name: "This page stopped" })).toBeTruthy();

    broken = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("recovered content")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This page stopped" })).toBeNull();
    spy.mockRestore();
  });

  it("reports the error to the sink rather than swallowing it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe("the log viewer exploded");
    spy.mockRestore();
  });
});

describe("a malformed answer from the control plane", () => {
  /** A row shaped like the real one but with `scopes` missing, as a bug would send it. */
  async function startMalformed(): Promise<string> {
    const server = await listen(
      {
        route: async (request) => {
          if (request.procedure === "organizations.list") {
            return {
              ok: true,
              status: 200,
              data: [{ id: "org-1", name: "Northwind", slug: "northwind" }],
            } as RpcResponse;
          }
          if (request.procedure === "apiKeys.list") {
            return {
              ok: true,
              status: 200,
              data: [{ id: "k-1", name: "CI", keyPrefix: "cw_abc", createdAt: "2026-09-01" }],
            } as RpcResponse;
          }
          return { ok: true, status: 200, data: [] } as RpcResponse;
        },
        allowedOrigins: [],
        shutdownGraceMs: 50,
      },
      0,
      "127.0.0.1",
    );
    servers.push(server);
    return server.url;
  }

  it("keeps the shell and names the fault instead of a blank screen", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = await startMalformed();
    window.history.replaceState(null, "", "#/orgs/org-1/settings/api-keys");
    render(
      <ToastProvider>
        <App session={signedInSession()} apiBaseUrl={url} />
      </ToastProvider>,
    );

    // The page cannot render the missing field, so the boundary takes over —
    // and the sidebar, which is outside it, is still there to leave by.
    expect(await screen.findByRole("heading", { name: "This page stopped" })).toBeTruthy();
    expect(document.querySelector(".sidebar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    spy.mockRestore();
  });
});
