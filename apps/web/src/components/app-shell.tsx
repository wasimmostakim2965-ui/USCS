/**
 * The application shell.
 *
 * Top bar, sidebar and command palette. The sidebar is generated from the
 * navigation model and nothing else, so a section cannot exist in the UI
 * without a route, and a route cannot exist without an entry here.
 *
 * Every control does something, or the section says in prose what is not built
 * yet rather than rendering a button that does nothing.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Button, ErrorBoundary, Icon, Modal, TextInput, type Toast } from "@cloud-wai/ui/react";
import { useApp } from "../react/context.js";
import { useCommandShortcut, useDismissable, useMediaQuery } from "../react/hooks.js";
import { toPath, type Route } from "../routes.js";
import {
  backTargetFor,
  navForRoute,
  navGroups,
  titleForRoute,
  type NavItem,
} from "../navigation.js";

export interface WorkspaceOption {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * The sidebar's remembered visibility, or `null` when the user has never chosen.
 *
 * A null lets the caller pick the responsive default (open on a wide screen,
 * closed on a narrow one); a stored value means the user's own choice wins.
 * Reading localStorage can throw (private mode, a blocked origin), so a failure
 * is the same as "no preference" rather than a crash.
 */
const SIDEBAR_PREFERENCE_KEY = "cloudwai.sidebar";

function readSidebarPreference(): boolean | null {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY);
    if (raw === "open") return true;
    if (raw === "closed") return false;
    return null;
  } catch {
    return null;
  }
}

function writeSidebarPreference(open: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, open ? "open" : "closed");
  } catch {
    // A blocked storage API only costs the remembered preference.
  }
}

function NavLink({
  item,
  active,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly active: boolean;
  readonly onNavigate: (route: Route) => void;
}) {
  return (
    <a
      className={`nav__item${active ? " nav__item--active" : ""}`}
      href={`#${toPath(item.route)}`}
      aria-current={active ? "page" : undefined}
      title={item.description}
      onClick={(event) => {
        // Left-clicks route in-app so focus and scroll state stay under our
        // control; modified clicks keep normal browser behaviour (new tab).
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onNavigate(item.route);
      }}
    >
      <span className="nav__glyph" aria-hidden="true">
        <Icon name={item.icon} size={18} />
      </span>
      <span className="truncate">{item.label}</span>
    </a>
  );
}

function Breadcrumb({
  route,
  organizationName,
  projectName,
  onNavigate,
}: {
  readonly route: Route;
  readonly organizationName: string;
  readonly projectName: string | null;
  readonly onNavigate: (route: Route) => void;
}) {
  const organizationId = "organizationId" in route ? route.organizationId : null;
  const projectId = "projectId" in route ? route.projectId : null;
  const section = titleForRoute(route);

  const crumbs: { readonly label: string; readonly route: Route | null }[] = [];
  if (organizationId) {
    crumbs.push({
      label: organizationName,
      route: { name: "projects", organizationId },
    });
  }
  if (organizationId && projectId) {
    crumbs.push({
      label: projectName ?? "Project",
      route: { name: "project", organizationId, projectId },
    });
  }
  // The Database section is a level of its own: a sub-page shows
  // ... / Database / Tables, and the "Database" crumb is a real link back to the
  // section rather than a dead label. On the Overview itself the crumb would
  // repeat the page title, so it is left out.
  if (
    route.name === "database" &&
    route.section &&
    route.section !== "overview" &&
    organizationId &&
    projectId
  ) {
    crumbs.push({
      label: "Database",
      route: { name: "database", organizationId, projectId },
    });
  }
  if (!(route.name === "projects" && crumbs.length === 1)) {
    crumbs.push({ label: section, route: null });
  }

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {crumbs.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`} style={{ display: "flex", gap: "var(--space-2)" }}>
          {index > 0 ? (
            <span className="breadcrumb__sep" aria-hidden="true">
              /
            </span>
          ) : null}
          {crumb.route ? (
            <a
              href={`#${toPath(crumb.route)}`}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                onNavigate(crumb.route!);
              }}
            >
              {crumb.label}
            </a>
          ) : (
            <span aria-current="page">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export interface AppShellProps {
  readonly organizations: readonly WorkspaceOption[];
  readonly activeOrganizationId: string | null;
  readonly activeProjectId: string | null;
  readonly projectName: string | null;
  readonly loadingWorkspaces: boolean;
  readonly onCreateOrganization: () => void;
  readonly onSelectOrganization: (organizationId: string) => void;
  /** Current colour scheme, for the topbar control's icon and label. */
  readonly theme: "dark" | "light";
  readonly onToggleTheme: () => void;
  readonly children: ReactNode;
}

export function AppShell({
  organizations,
  activeOrganizationId,
  activeProjectId,
  projectName,
  loadingWorkspaces,
  onCreateOrganization,
  onSelectOrganization,
  theme,
  onToggleTheme,
  children,
}: AppShellProps) {
  const { router, user, signOut, misconfigured } = useApp();
  const [profileOpen, setProfileOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  // The compact bar is only rendered when the sidebar is genuinely unavailable,
  // so a wide screen never has two navigations in its accessibility tree.
  const compactNav = useMediaQuery("(max-width: 960px)");
  // Below 400px the top bar cannot hold every control; the theme toggle steps
  // into the account menu there rather than shove the account menu off-screen.
  const narrowBar = useMediaQuery("(max-width: 400px)");
  // On a wide screen the sidebar is always visible, so the toggle starts open
  // and the button collapses it out of the layout (see `shell--nav-collapsed`).
  // On a narrow screen the sidebar is an off-canvas drawer, so the toggle starts
  // closed. The preference is remembered once the user chooses one.
  const [sidebarOpen, setSidebarOpen] = useState(() => readSidebarPreference() ?? !compactNav);

  const profile = useDismissable(profileOpen, () => setProfileOpen(false));
  const workspace = useDismissable(workspaceOpen, () => setWorkspaceOpen(false));

  useCommandShortcut(() => {
    setPaletteOpen(true);
    setQuery("");
    setPaletteIndex(0);
  });

  const activeOrganization = organizations.find((o) => o.id === activeOrganizationId) ?? null;
  const organizationName = activeOrganization?.name ?? "Workspace";

  // With no workspace selected there is no organization to scope a route to, so
  // the navigation model cannot answer. The sidebar still renders — a toggle
  // that opens nothing is the bug this replaces — with the one honest item for
  // that state: the chooser itself. A route built from an empty organizationId
  // would be a dead link (`/orgs//projects`), which is why this is a fallback
  // rather than `navForRoute` with `""`.
  const nav = useMemo(() => {
    if (!activeOrganizationId) {
      return {
        items: [
          {
            id: "organizations",
            label: "Organizations",
            icon: "projects" as const,
            description: "Choose or create a workspace.",
            route: { name: "organizations" } as Route,
          },
        ],
        activeId: "organizations" as string | null,
        projectId: null,
        level: "workspace" as const,
      };
    }
    return navForRoute(router.route, {
      organizationId: activeOrganizationId,
      ...(projectName ? { projectName } : {}),
    });
  }, [router.route, activeOrganizationId, projectName]);

  const back = activeOrganizationId ? backTargetFor(router.route) : null;

  const commands = useMemo(() => {
    const items: {
      readonly label: string;
      readonly hint: string;
      /** Either a route to jump to, or an action that also opens a form. */
      readonly route: Route;
      readonly action?: "create-organization";
    }[] = [];
    for (const item of nav.items) {
      items.push({ label: item.label, hint: item.description, route: item.route });
    }
    for (const organization of organizations) {
      items.push({
        label: organization.name,
        hint: "Switch workspace",
        route: { name: "projects", organizationId: organization.id },
      });
    }
    items.push(
      { label: "All organizations", hint: "Choose a workspace", route: { name: "organizations" } },
      {
        label: "New organization",
        hint: "Create a workspace",
        route: { name: "organizations" },
        action: "create-organization",
      },
    );
    return items;
  }, [nav.items, organizations]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (term === "") return commands.slice(0, 12);
    return commands
      .filter(
        (command) =>
          command.label.toLowerCase().includes(term) || command.hint.toLowerCase().includes(term),
      )
      .slice(0, 12);
  }, [commands, query]);

  // Navigating closes the off-canvas drawer so the destination is visible. On a
  // wide screen the sidebar is part of the layout, so following a link must not
  // hide it (that would make the second Back press unreachable).
  const closeDrawer = () => {
    if (compactNav) setSidebarOpen(false);
  };

  const go = (route: Route) => {
    router.navigate(route);
    setPaletteOpen(false);
    closeDrawer();
  };

  const runCommand = (command: {
    readonly route: Route;
    readonly action?: "create-organization";
  }) => {
    if (command.action === "create-organization") onCreateOrganization();
    else router.navigate(command.route);
    setPaletteOpen(false);
    closeDrawer();
  };

  const initials = (user?.displayName ?? user?.email ?? "?").slice(0, 1).toUpperCase();

  const toggleSidebar = () => {
    setSidebarOpen((open) => {
      writeSidebarPreference(!open);
      return !open;
    });
  };

  const sidebarVisible = sidebarOpen;

  return (
    <div className={`shell${!sidebarVisible ? " shell--nav-collapsed" : ""}`}>
      <header className="topbar">
        {/* Vercel keeps a back arrow in the top bar, not only in the sidebar, so
            a drill-in is one tap from anywhere. Here it appears exactly where the
            sidebar is out of reach — a narrow screen — and the sidebar keeps its
            own Back on a wide one, so the two never both show. */}
        {back && compactNav ? (
          <Button variant="ghost" size="sm" ariaLabel="Back" title="Back" onClick={() => go(back)}>
            <Icon name="back" size={18} />
          </Button>
        ) : null}
        {/* The menu lives in the top bar at every width, and on a narrow screen
            it is the only way to the section list — the drawer opens from here.
            Wide screens toggle the sidebar in and out of the layout; narrow
            screens open it over the page. */}
        <Button
          variant="ghost"
          size="sm"
          ariaLabel={sidebarVisible ? "Hide navigation" : "Show navigation"}
          title={sidebarVisible ? "Hide navigation" : "Show navigation"}
          onClick={toggleSidebar}
        >
          <Icon name="menu" size={18} />
        </Button>

        <a
          className="topbar__brand"
          href="#/orgs"
          onClick={(event) => {
            event.preventDefault();
            router.navigate({ name: "organizations" });
          }}
        >
          <span className="topbar__mark">Cloud Wai</span>
          <span className="topbar__tag">control plane</span>
        </a>

        <div className="menu menu--start" ref={workspace.ref}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWorkspaceOpen((open) => !open)}
            title="Switch workspace"
          >
            <span className="truncate topbar__workspace-name">
              {loadingWorkspaces ? "Loading…" : organizationName}
            </span>
            <Icon name="chevronDown" size={16} />
          </Button>
          {workspaceOpen ? (
            <div className="menu__panel" role="menu">
              <div className="menu__label">Workspaces</div>
              {organizations.length === 0 && !loadingWorkspaces ? (
                <div className="menu__item faint" style={{ cursor: "default" }}>
                  No workspaces yet
                </div>
              ) : null}
              {organizations.map((organization) => (
                <button
                  key={organization.id}
                  type="button"
                  role="menuitem"
                  className={`menu__item${
                    organization.id === activeOrganizationId ? " menu__item--active" : ""
                  }`}
                  onClick={() => {
                    onSelectOrganization(organization.id);
                    setWorkspaceOpen(false);
                  }}
                >
                  <span className="truncate">{organization.name}</span>
                  <span className="faint small" style={{ marginLeft: "auto" }}>
                    {organization.slug}
                  </span>
                </button>
              ))}
              <div className="menu__sep" />
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  setWorkspaceOpen(false);
                  onCreateOrganization();
                }}
              >
                + New workspace
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  setWorkspaceOpen(false);
                  router.navigate({ name: "organizations" });
                }}
              >
                All workspaces
              </button>
            </div>
          ) : null}
        </div>

        {projectName ? (
          <>
            <span className="faint" aria-hidden="true">
              /
            </span>
            <span className="row" style={{ gap: "var(--space-2)" }}>
              <span className="truncate topbar__project-name">{projectName}</span>
            </span>
          </>
        ) : null}

        <span className="topbar__spacer" />

        <button
          type="button"
          className="btn btn--ghost btn--sm topbar__search"
          onClick={() => setPaletteOpen(true)}
          title="Command palette"
        >
          <Icon name="search" size={16} />
          <span className="topbar__search-label">Search</span>
          <span className="kbd">⌘K</span>
        </button>

        {/* The theme toggle is a top-bar control until the bar genuinely cannot
            hold it: below 400px its 43px was the difference between the account
            menu being on screen and being pushed off the right edge. There it
            moves into the account menu instead — one control at a time, never
            two, and never one that cannot be tapped. */}
        {narrowBar ? null : (
          <Button
            variant="ghost"
            size="sm"
            ariaLabel={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={onToggleTheme}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
          </Button>
        )}

        <div className="menu" ref={profile.ref}>
          <button
            type="button"
            className="menu__item"
            style={{ width: "auto", padding: "var(--space-1)" }}
            aria-haspopup="menu"
            aria-expanded={profileOpen}
            onClick={() => setProfileOpen((open) => !open)}
            title={user?.email ?? "Account"}
          >
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
          </button>
          {profileOpen ? (
            <div className="menu__panel" role="menu">
              <div className="menu__label">Signed in as</div>
              <div className="menu__item" style={{ cursor: "default" }}>
                <span className="truncate">{user?.email ?? "unknown"}</span>
              </div>
              <div className="menu__sep" />
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  setProfileOpen(false);
                  if (activeOrganizationId) {
                    router.navigate({ name: "settings", organizationId: activeOrganizationId });
                  } else {
                    router.navigate({ name: "organizations" });
                  }
                }}
              >
                Organization settings
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  setProfileOpen(false);
                  if (activeOrganizationId) {
                    router.navigate({ name: "apiKeys", organizationId: activeOrganizationId });
                  } else {
                    router.navigate({ name: "organizations" });
                  }
                }}
              >
                API keys
              </button>
              {narrowBar ? (
                <button
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  onClick={() => {
                    setProfileOpen(false);
                    onToggleTheme();
                  }}
                >
                  {theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
                </button>
              ) : null}
              <div className="menu__sep" />
              <button type="button" role="menuitem" className="menu__item" onClick={signOut}>
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {sidebarVisible ? (
        <aside className={`sidebar${compactNav && sidebarOpen ? " sidebar--open" : ""}`}>
          <nav className="nav" aria-label="Sections">
            {/* The reference's sidebar opens with a Find control, and so does
                this one: the same command palette the top bar opens, in the
                place the eye starts. */}
            <button
              type="button"
              className="nav__item nav__find"
              onClick={() => setPaletteOpen(true)}
              title="Find a section or workspace"
            >
              <span className="nav__glyph" aria-hidden="true">
                <Icon name="search" size={18} />
              </span>
              <span className="truncate">Find</span>
            </button>
            {back ? (
              <button type="button" className="nav__item nav__back" onClick={() => go(back)}>
                <span className="nav__glyph" aria-hidden="true">
                  <Icon name="back" size={18} />
                </span>
                <span className="truncate">Back</span>
              </button>
            ) : null}
            {navGroups(nav.level, nav.items).map((group, index) => (
              <div className="nav__section" key={`${group.label}-${index}`}>
                {group.label ? <div className="nav__group">{group.label}</div> : null}
                {group.items.map((item) => (
                  <NavLink
                    key={item.id}
                    item={item}
                    active={item.id === nav.activeId}
                    onNavigate={go}
                  />
                ))}
              </div>
            ))}
          </nav>
        </aside>
      ) : null}

      {/* On a narrow screen the sidebar is a drawer over the page. Without a
          backdrop the only way to dismiss it is to follow a link, so a tap
          anywhere else closes it. Wide screens have no drawer, so no backdrop. */}
      {compactNav && sidebarOpen ? (
        <button
          type="button"
          className="drawer-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <main className="main" id="main">
        {misconfigured ? (
          <div className="banner banner--danger" role="status">
            <strong>Supabase is not configured.</strong>
            <span>
              Sign-in and data are unavailable. Set <code>VITE_SUPABASE_URL</code> and{" "}
              <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> to enable this dashboard.
            </span>
          </div>
        ) : null}
        {activeOrganizationId ? (
          <Breadcrumb
            route={router.route}
            organizationName={organizationName}
            projectName={projectName}
            onNavigate={go}
          />
        ) : null}
        {/* One page's render error must not take the shell with it. The
            boundary sits inside the chrome and outside the page, so the
            sidebar and the way back survive a crash. */}
        <ErrorBoundary key={toPath(router.route)}>{children}</ErrorBoundary>
      </main>

      <Modal
        title="Command palette"
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        footer={
          <span className="faint small">
            <span className="kbd">↑</span> <span className="kbd">↓</span> to move ·{" "}
            <span className="kbd">Enter</span> to open · <span className="kbd">Esc</span> to close
          </span>
        }
      >
        <div
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setPaletteIndex((index) => Math.min(index + 1, filtered.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setPaletteIndex((index) => Math.max(index - 1, 0));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const command = filtered[paletteIndex];
              if (command) runCommand(command);
            }
          }}
        >
          <TextInput
            value={query}
            onChange={(value) => {
              setQuery(value);
              setPaletteIndex(0);
            }}
            placeholder="Jump to a section or workspace…"
            autoFocus
          />
          <div className="palette__list" style={{ marginTop: "var(--space-4)" }}>
            {filtered.length === 0 ? (
              <div className="palette__empty">Nothing matches “{query}”.</div>
            ) : (
              filtered.map((command, index) => (
                <button
                  key={`${command.label}-${index}`}
                  type="button"
                  className={`palette__item${index === paletteIndex ? " palette__item--active" : ""}`}
                  onMouseEnter={() => setPaletteIndex(index)}
                  onClick={() => runCommand(command)}
                >
                  {command.label}
                  <small>{command.hint}</small>
                </button>
              ))
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

export type { Toast };
