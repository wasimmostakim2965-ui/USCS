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
import { APP_VERSION } from "./version.js";
import {
  ActivityPage,
  ApiKeysPage,
  BillingPage,
  DeploymentsPage,
  DomainsPage,
  GitPage,
  NotFoundPage,
  ObservabilityPage,
  OrganizationsPage,
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
}

export function App({ session, apiBaseUrl, misconfigured = false }: AppProps) {
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

  // Derive the active workspace from the URL first, then the remembered one.
  const routeOrganizationId = "organizationId" in router.route ? router.route.organizationId : null;
  const activeOrganizationId = routeOrganizationId ?? (workspaceId || null);

  // Remember whatever the URL says, so the sidebar is stable on a later visit.
  useEffect(() => {
    if (routeOrganizationId && routeOrganizationId !== workspaceId) {
      setWorkspaceId(routeOrganizationId);
    }
  }, [routeOrganizationId, workspaceId, setWorkspaceId]);

  const projectId = "projectId" in router.route ? router.route.projectId : null;

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

  if (!current) {
    // A signed-out visitor gets the landing page at `/`, and the sign-in form at
    // every other route they tried to reach — so a deep link is still one step
    // from signing in rather than a dead end or a blank shell.
    if (router.route.name === "landing") {
      return (
        <LandingPage
          signedIn={false}
          version={APP_VERSION}
          onEnterDashboard={() => router.navigate({ name: "organizations" })}
        />
      );
    }
    return (
      <ToastProvider>
        <LoginPage session={session} misconfigured={misconfigured} />
      </ToastProvider>
    );
  }

  if (router.route.name === "landing") {
    // Signed in, the landing page is the marketing page; its action goes to the
    // dashboard rather than through the sign-in form again.
    return (
      <LandingPage
        signedIn
        version={APP_VERSION}
        onEnterDashboard={() => router.navigate({ name: "organizations" })}
      />
    );
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
      case "git":
        return <GitPage organizationId={route.organizationId} projectId={route.projectId} />;
      case "projectSettings":
        return (
          <ProjectSettingsPage organizationId={route.organizationId} projectId={route.projectId} />
        );
      case "audit":
        return <ActivityPage organizationId={route.organizationId} />;
      case "observability":
        return <ObservabilityPage organizationId={route.organizationId} />;
      case "billing":
        return <BillingPage organizationId={route.organizationId} />;
      case "apiKeys":
        return <ApiKeysPage organizationId={route.organizationId} />;
      case "settings":
        return <SettingsPage organizationId={route.organizationId} />;
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
