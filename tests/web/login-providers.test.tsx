/**
 * Sign-in provider honesty.
 *
 * The sign-in form must offer a button only for a provider the identity
 * provider has actually enabled, and carry the provider's own brand mark. A
 * provider that is switched off (the reason a click "does nothing"), an
 * unreadable settings response, and a failed read must all yield no button —
 * never a dead control or a guessed provider list.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  App,
  enabledProvidersFromSettings,
  listEnabledProviders,
  OAuthProviderIds,
  type SessionController,
} from "@cloud-wai/web";
import { ICONS } from "@cloud-wai/ui";
import { ToastProvider } from "@cloud-wai/ui/react";

function settingsWith(enabled: readonly string[]) {
  const external: Record<string, boolean> = {};
  for (const id of [
    "apple",
    "azure",
    "bitbucket",
    "discord",
    "facebook",
    "github",
    "gitlab",
    "google",
  ]) {
    external[id] = enabled.includes(id);
  }
  return { external, mailer_autoconfirm: false };
}

const noopSession: SessionController = {
  configured: true,
  current: () => null,
  getAccessToken: () => null,
  signInWithProvider: async () => {},
  applySession: async () => {},
  signOut: async () => {},
  subscribe: () => () => {},
};

/** Render the app on a route that shows the sign-in form (any non-landing route). */
function renderSignIn(oauthProviders: readonly ("github" | "gitlab" | "google")[] | null) {
  window.history.replaceState(null, "", "#/orgs");
  render(
    <ToastProvider>
      <App session={noopSession} apiBaseUrl="http://127.0.0.1:1" oauthProviders={oauthProviders} />
    </ToastProvider>,
  );
}

afterEach(cleanup);

describe("reading enabled OAuth providers from settings", () => {
  it("returns only the providers this form can offer, in a stable order", () => {
    expect(enabledProvidersFromSettings(settingsWith(["google", "github", "gitlab"]))).toEqual([
      "github",
      "gitlab",
      "google",
    ]);
  });

  it("drops a provider the form cannot offer, even when it is enabled", () => {
    expect(enabledProvidersFromSettings(settingsWith(["apple", "github"]))).toEqual(["github"]);
  });

  it("returns an empty list when no provider is enabled", () => {
    expect(enabledProvidersFromSettings(settingsWith([]))).toEqual([]);
  });

  it("returns null — could not be asked — for a missing or malformed body", () => {
    expect(enabledProvidersFromSettings(undefined)).toBeNull();
    expect(enabledProvidersFromSettings(null)).toBeNull();
    expect(enabledProvidersFromSettings({})).toBeNull();
    expect(enabledProvidersFromSettings({ external: "yes" })).toBeNull();
  });
});

describe("asking the identity provider for its enabled providers", () => {
  it("reads auth/v1/settings with the anon key and maps the body", async () => {
    let seenUrl = "";
    let seenKey: string | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenKey = (init?.headers as Record<string, string> | undefined)?.apikey;
      return new Response(JSON.stringify(settingsWith(["gitlab"])), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await listEnabledProviders(
      { url: "https://id.example/", anonKey: "anon-key" },
      fetchImpl,
    );

    expect(seenUrl).toBe("https://id.example/auth/v1/settings");
    expect(seenKey).toBe("anon-key");
    expect(result).toEqual(["gitlab"]);
  });

  it("resolves to null on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(
      await listEnabledProviders({ url: "https://id.example", anonKey: "k" }, fetchImpl),
    ).toBeNull();
  });

  it("resolves to null when the network throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(
      await listEnabledProviders({ url: "https://id.example", anonKey: "k" }, fetchImpl),
    ).toBeNull();
  });
});

describe("the sign-in form renders the real provider logos, and only live ones", () => {
  it("renders a button, with the provider's own brand mark, for each enabled provider", () => {
    renderSignIn(OAuthProviderIds);
    expect(screen.getByRole("button", { name: /Sign in with GitHub/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sign in with GitLab/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sign in with Google/ })).toBeTruthy();
  });

  it("every provider the form can offer has a filled brand mark in the icon set", () => {
    for (const id of OAuthProviderIds) {
      expect(ICONS[id], `${id} mark missing`).toBeTruthy();
      expect(ICONS[id]!.fill, `${id} should be a filled brand mark`).toBe(true);
    }
  });

  it("offers no button, and says why, when no provider is enabled", () => {
    renderSignIn([]);
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
    expect(screen.getByText(/No sign-in provider is enabled/)).toBeTruthy();
  });

  it("offers no button when the provider list could not be read", () => {
    renderSignIn(null);
    expect(screen.queryByRole("button", { name: /Sign in with/ })).toBeNull();
  });
});
