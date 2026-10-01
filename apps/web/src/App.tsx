/**
 * The application root.
 *
 * Responsibilities, in order:
 *   1. hold the session and re-render on sign-in/sign-out;
 *   2. build the single `ApiClient`, with the token supplied by the session;
 *   3. pick the page for the current route;
 *   4. remember the selected workspace so a refresh keeps the sidebar.
 *
 * The workspace choice is cosmetic: the server resolves scope from the session
 * on every request and ignores the id in the URL for authorization. Storing it
 * in `localStorage` only saves the user from re-picking it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ToastProvider } from "@cloud-wai/ui/react";
import { ApiClient, type OrganizationSummary, type SessionController } from "./index.js";
import type { OAuthProvider } from "./session.js";
import { AppProvider } from "./react/context.js";
import {
  useDocumentTitle,
  usePersistentState,
  useRouter,
  useSection,
  useTheme,
} from "./react/hooks.js";
import { loadOrganizations } from "./view-model.js";
import { AppShell, type WorkspaceOption } from "./components/app-shell.js";
import { titleForRoute } from "./navigation.js";
import { LoginPage } from "./pages/login.js";
import { LandingPage } from "./pages/landing.js";
import { DatabasePage } from "./pages/database.js";
import { ProjectSetupPage } from "./pages/setup.js";
import { SectionPage } from "./pages/section-page.js";
import { PROJECT_SECTIONS_SPEC, WORKSPACE_SECTIONS_SPEC } from "./sections.js";
import { APP_VERSION } from "./version.js";
import {
  ActivityPage,
  ApiKeysPage,
  BillingPage,
  DeploymentsPage,
  DocsPage,
  DomainsPage,
  EnvVarsPage,
  GitPage,
  MembersPage,
  NotFoundPage,
  ObservabilityPage,
  OrganizationDeploymentsPage,
  OrganizationsPage,
  ProjectAnalyticsPage,
  ProjectLogsPage,
  ProjectOverviewPage,
  ProjectSettingsPage,
  ProjectsPage,
  SecurityPage,
  SettingsPage,
} from "./pages/pages.js";

export interface AppProps {
  readonly session: SessionController;
  /** Base URL of the Cloud Wai API. */
  readonly apiBaseUrl: string;
  /** True when Supabase is not configured, so the UI can say so. */
  readonly misconfigured?: boolean;
  /**
   * The OAuth providers the identity provider actually has enabled, read from
   * `auth/v1/settings`. `null` means the deployment could not be asked (or the
   * read failed); an empty list means none are enabled. The sign-in form shows
   * a button only for a provider it can honestly offer.
   */
  readonly oauthProviders?: readonly OAuthProvider[] | null;
  /** Explicit PKCE callback failure, if the one-time exchange failed. */
  readonly oauthError?: string | null;
}

export function App({
  session,
  apiBaseUrl,
  misconfigured = false,
  oauthProviders = null,
  oauthError = null,
}: AppProps) {
  const [current, setCurrent] = useState(() => session.current());
  const [workspaceId, setWorkspaceId] = usePersistentState("cloud-wai.workspace", "");
  const router = useRouter();
  const [theme, toggleTheme] = useTheme();
  // Bumped when a "New workspace" / "New organization" affordance is used, so
  // the Organizations page opens its create form rather than just being shown.
  // Reset to 0 once the page has acted on it, so a remount does not re-open it.
  const [createRequest, setCreateRequest] = useState(0);

  useEffect(() => session.subscribe(setCurrent), [session]);

  // Signing out must not leave the previous user's workspace selected.
  useEffect(() => {
    if (!current) setWorkspaceId("");
  }, [current, setWorkspaceId]);

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: apiBaseUrl,
        getAccessToken: () => session.getAccessToken(),
      }),
    [apiBaseUrl, session],
  );

  const signOut = useCallback(() => {
    void session.signOut();
  }, [session]);

  // The workspace list drives the switcher and every sidebar.
  const workspaces = useSection(() => loadOrganizations(client), [client], "Organizations");

  const organizations: readonly WorkspaceOption[] =
    workspaces.section.state.kind === "ready"
      ? workspaces.section.state.items.map((item: OrganizationSummary) => ({
          id: item.id,
          name: item.name,
          slug: item.slug,
        }))
      : [];

  const requestCreateOrganization = useCallback(() => {
    setCreateRequest((value) => value + 1);
    router.navigate({ name: "organizations" });
  }, [router]);

  const acknowledgeCreateRequest = useCallback(() => setCreateRequest(0), []);

  // Derive the active workspace from the URL first, then the remembered one,
  // then the first workspace the account has. That third fallback is what makes
  // a fresh sign-in land inside a real workspace instead of on a chooser whose
  // sidebar carries a single item: with an organization in hand the whole
  // workspace menu (Projects, Activity, Observability, Billing, API keys, Docs,
  // Settings) renders, exactly as it does after an explicit selection. With no
  // organizations the fallback stays null and the chooser is the honest answer.
  const routeOrganizationId = "organizationId" in router.route ? router.route.organizationId : null;
  const activeOrganizationId = routeOrganizationId ?? (workspaceId || organizations[0]?.id || null);
  const firstOrganizationId = organizations[0]?.id ?? null;
  // Vercel rewrites `/auth/callback` to the SPA entrypoint, so a PKCE return can
  // arrive as `/?code=...#/` and parse as the landing route. Keep that return
  // distinct from an ordinary visit to `/`, otherwise a successful sign-in
  // appears to have done nothing.
  const isOAuthReturn =
    router.route.name === "auth_callback" ||
    (typeof window !== "undefined" &&
      (new URLSearchParams(window.location.search).has("code") ||
        new URLSearchParams(window.location.search).has("error")));

  // Where "open the dashboard" lands: the account's first workspace front page
  // when it has one, otherwise the chooser. One answer for the landing CTA and
  // the sign-in callback, so a click never stops on a one-item sidebar.
  const dashboardEntry = useCallback(
    () =>
      firstOrganizationId
        ? router.navigate({ name: "projects", organizationId: firstOrganizationId })
        : router.navigate({ name: "organizations" }),
    [router, firstOrganizationId],
  );

  // Follows a section sub-tab: rewrite the URL to the sub-item's route, so the
  // tab, the sidebar's sub-menu and the address bar stay one answer. A section
  // route keeps its scope (workspace vs project) from the current URL.
  const navigateSub = useCallback(
    (sub: string) => {
      const route = router.route;
      if (route.name === "workspaceSection") {
        router.navigate({
          name: "workspaceSection",
          organizationId: route.organizationId,
          section: route.section,
          sub,
        });
      } else if (route.name === "projectSection") {
        router.navigate({
          name: "projectSection",
          organizationId: route.organizationId,
          projectId: route.projectId,
          section: route.section,
          sub,
        });
      }
    },
    [router],
  );

  // Remember whatever the URL (or the fallback) settled on, so the sidebar is
  // stable on a later visit without the URL carrying an organization id.
  useEffect(() => {
    if (activeOrganizationId && activeOrganizationId !== workspaceId) {
      setWorkspaceId(activeOrganizationId);
    }
  }, [activeOrganizationId, workspaceId, setWorkspaceId]);

  useEffect(() => {
    if (current && isOAuthReturn && workspaces.section.state.kind === "ready") {
      // The Vercel-shaped landing: a fresh sign-in lands on the workspace front
      // page, not on a chooser that would otherwise show a one-item sidebar.
      // That is what makes "open the dashboard" one click instead of two.
      if (firstOrganizationId) {
        router.navigate({ name: "projects", organizationId: firstOrganizationId });
      } else {
        router.navigate({ name: "organizations" });
      }

      // Remove the one-time PKCE code/error from the address bar after the
      // session has been adopted. Keep the hash route that the SPA just chose.
      window.history.replaceState(null, "", `/${window.location.hash}`);
    }
  }, [current, isOAuthReturn, router, firstOrganizationId, workspaces.section.state.kind]);

  const projectId = "projectId" in router.route ? router.route.projectId : null;

  // Temporary no-login bypass: the session signs itself in, but the landing
  // route still renders the marketing page (with the pricing section), so the
  // root stays a real product surface rather than a hard redirect. The demo
  // account is signed in underneath, so the landing CTA opens the dashboard in
  // one click and a deep link is not blocked behind the sign-in form.

  useDocumentTitle(router.route.name === "not_found" ? "Not found" : titleForRoute(router.route));

  // The top bar and breadcrumb need the project's name; the page itself loads
  // the project for its own content, so this is chrome only.
  const projectName = useProjectName(client, projectId);

  const appValue = useMemo(
    () => ({
      client,
      session,
      router,
      user: current ? { email: current.email, displayName: current.displayName } : null,
      misconfigured,
      signOut,
    }),
    [client, session, router, current, misconfigured, signOut],
  );

  if (isOAuthReturn && !current) {
    return (
      <main className="login" aria-live="polite">
        <section className="login__panel">
          <div className="login__mark">Cloud Wai</div>
          <p className="login__tag">{oauthError ?? "Completing secure sign-in…"}</p>
          {oauthError ? (
            <a className="btn btn--default" href="/">
              Back to sign in
            </a>
          ) : null}
        </section>
      </main>
    );
  }

  if (!current) {
    // Temporary no-login bypass: while the demo controller is signing in, the
    // visitor sees a minimal loading state rather than the landing page or a
    // sign-in form. It resolves to the dashboard once the session exists.
    if (session.autoEnter) {
      return (
        <main style={{ padding: "4rem", textAlign: "center" }}>
          <p role="status">Connecting to Cloud Wai…</p>
        </main>
      );
    }
    // A signed-out visitor gets the landing page at `/`, and the sign-in form at
    // every other route they tried to reach — so a deep link is still one step
    // from signing in rather than a dead end or a blank shell.
    if (router.route.name === "landing") {
      return (
        <LandingPage signedIn={false} version={APP_VERSION} onEnterDashboard={dashboardEntry} />
      );
    }
    return (
      <ToastProvider>
        <LoginPage
          session={session}
          misconfigured={misconfigured}
          oauthProviders={oauthProviders}
        />
      </ToastProvider>
    );
  }

  if (router.route.name === "landing") {
    // Signed in, the landing page is still the marketing page; its action goes
    // to the dashboard rather than through the sign-in form again. Under the
    // temporary no-login bypass the session is already signed in, so the CTA
    // opens the dashboard in one click.
    return <LandingPage signedIn version={APP_VERSION} onEnterDashboard={dashboardEntry} />;
  }

  const page = (() => {
    const route = router.route;
    switch (route.name) {
      case "organizations":
        return (
          <OrganizationsPage
            createRequest={createRequest}
            onCreateRequestHandled={acknowledgeCreateRequest}
          />
        );
      case "organization":
        // The organization summary is a Workspace-level concern; the useful
        // view is its projects, and the sidebar already shows the identity.
        return <ProjectsPage organizationId={route.organizationId} />;
      case "projects":
        return <ProjectsPage organizationId={route.organizationId} />;
      case "project":
        return (
          <ProjectOverviewPage organizationId={route.organizationId} projectId={route.projectId} />
        );
      case "deployments":
        return (
          <DeploymentsPage organizationId={route.organizationId} projectId={route.projectId} />
        );
      case "domains":
        return <DomainsPage organizationId={route.organizationId} projectId={route.projectId} />;
      case "database":
        return (
          <DatabasePage
            organizationId={route.organizationId}
            projectId={route.projectId}
            section={route.section ?? "overview"}
          />
        );
      case "security":
        return <SecurityPage organizationId={route.organizationId} />;
      case "setup":
        return (
          <ProjectSetupPage organizationId={route.organizationId} projectId={route.projectId} />
        );
      case "git":
        return <GitPage organizationId={route.organizationId} projectId={route.projectId} />;
      case "env":
        return <EnvVarsPage organizationId={route.organizationId} projectId={route.projectId} />;
      case "projectLogs":
        return (
          <ProjectLogsPage organizationId={route.organizationId} projectId={route.projectId} />
        );
      case "projectAnalytics":
        return (
          <ProjectAnalyticsPage organizationId={route.organizationId} projectId={route.projectId} />
        );
      case "projectSettings":
        return (
          <ProjectSettingsPage organizationId={route.organizationId} projectId={route.projectId} />
        );
      case "audit":
        return <ActivityPage organizationId={route.organizationId} />;
      case "observability":
        return <ObservabilityPage organizationId={route.organizationId} />;
      case "orgDeployments":
        return <OrganizationDeploymentsPage organizationId={route.organizationId} />;
      case "members":
        return <MembersPage organizationId={route.organizationId} />;
      case "billing":
        return <BillingPage organizationId={route.organizationId} />;
      case "apiKeys":
        return <ApiKeysPage organizationId={route.organizationId} />;
      case "docs":
        return <DocsPage />;
      case "settings":
        return <SettingsPage organizationId={route.organizationId} />;
      case "workspaceSection":
        // Firewall is the reference's name for the section this deployment
        // backs with the real security engine, so it renders that page — with
        // the reference's own heading and sub-menu — rather than an empty shell.
        if (route.section === "firewall") {
          return (
            <SecurityPage
              organizationId={route.organizationId}
              title="Firewall"
              sub={route.sub}
              onSelectTab={navigateSub}
            />
          );
        }
        return (
          <SectionPage
            spec={WORKSPACE_SECTIONS_SPEC[route.section]!}
            section={route.section}
            scope="Applies to every project in this organization."
            organizationId={route.organizationId}
            {...(route.sub ? { sub: route.sub } : {})}
            onSelectTab={navigateSub}
          />
        );
      case "projectSection":
        if (route.section === "firewall") {
          return (
            <SecurityPage
              organizationId={route.organizationId}
              title="Firewall"
              sub={route.sub}
              onSelectTab={navigateSub}
            />
          );
        }
        return (
          <SectionPage
            spec={PROJECT_SECTIONS_SPEC[route.section]!}
            section={route.section}
            scope="Applies to this project."
            organizationId={route.organizationId}
            {...(route.sub ? { sub: route.sub } : {})}
            onSelectTab={navigateSub}
          />
        );
      case "not_found":
        return <NotFoundPage path={route.path} />;
    }
  })();

  return (
    <ToastProvider>
      <AppProvider value={appValue}>
        <AppShell
          organizations={organizations}
          activeOrganizationId={activeOrganizationId}
          activeProjectId={projectId}
          projectName={projectName}
          loadingWorkspaces={workspaces.section.state.kind === "loading"}
          onCreateOrganization={requestCreateOrganization}
          onSelectOrganization={(organizationId) => {
            router.navigate({ name: "projects", organizationId });
          }}
          theme={theme}
          onToggleTheme={toggleTheme}
        >
          {page}
        </AppShell>
      </AppProvider>
    </ToastProvider>
  );
}

/**
 * Resolve the project name once per project id.
 *
 * Kept here rather than in the shell so the shell stays presentational.
 */
export function useProjectName(client: ApiClient, projectId: string | null): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) {
      setName(null);
      return;
    }
    let cancelled = false;
    void client.call<{ name: string }>("projects.get", { projectId }).then((response) => {
      if (cancelled) return;
      setName(response.ok && response.data ? response.data.name : null);
    });
    return () => {
      cancelled = true;
    };
  }, [client, projectId]);
  return name;
}
