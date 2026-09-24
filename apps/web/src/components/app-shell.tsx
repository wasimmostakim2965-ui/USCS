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
import { Button, Icon, Modal, TextInput, type Toast } from "@cloud-wai/ui/react";
import { useApp } from "../react/context.js";
import { useCommandShortcut, useDismissable } from "../react/hooks.js";
import { toPath, type Route } from "../routes.js";
import { backTargetFor, navForRoute, titleForRoute, type NavItem } from "../navigation.js";

export interface WorkspaceOption {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);

  const profile = useDismissable(profileOpen, () => setProfileOpen(false));
  const workspace = useDismissable(workspaceOpen, () => setWorkspaceOpen(false));

  useCommandShortcut(() => {
    setPaletteOpen(true);
    setQuery("");
    setPaletteIndex(0);
  });

  const activeOrganization = organizations.find((o) => o.id === activeOrganizationId) ?? null;
  const organizationName = activeOrganization?.name ?? "Workspace";

  const nav = useMemo(
    () =>
      navForRoute(router.route, {
        organizationId: activeOrganizationId ?? "",
        ...(projectName ? { projectName } : {}),
      }),
    [router.route, activeOrganizationId, projectName],
  );

  const back = backTargetFor(router.route);
  const groupLabel =
    nav.level === "database" ? "Database" : nav.level === "project" ? "Project" : organizationName;

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

  const go = (route: Route) => {
    router.navigate(route);
    setPaletteOpen(false);
    setSidebarOpen(false);
  };

  const runCommand = (command: {
    readonly route: Route;
    readonly action?: "create-organization";
  }) => {
    if (command.action === "create-organization") onCreateOrganization();
    else router.navigate(command.route);
    setPaletteOpen(false);
    setSidebarOpen(false);
  };

  const initials = (user?.displayName ?? user?.email ?? "?").slice(0, 1).toUpperCase();

  return (
    <div className={`shell${activeOrganizationId ? "" : " shell--no-sidebar"}`}>
      <header className="topbar">
        <Button
          variant="ghost"
          size="sm"
          ariaLabel="Toggle navigation"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <Icon name="menu" size={18} />
        </Button>

        <a
          className="topbar__brand"
          href="#/"
          onClick={(event) => {
            event.preventDefault();
            router.navigateTo("/");
          }}
        >
          <span className="topbar__mark">Cloud Wai</span>
          <span className="topbar__tag">control plane</span>
        </a>

        <div className="menu" ref={workspace.ref}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWorkspaceOpen((open) => !open)}
            title="Switch workspace"
          >
            <span className="truncate" style={{ maxWidth: "200px" }}>
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
              <span className="truncate" style={{ maxWidth: "180px", fontWeight: 600 }}>
                {projectName}
              </span>
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

        <Button
          variant="ghost"
          size="sm"
          ariaLabel={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={onToggleTheme}
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} size={17} />
        </Button>

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
              <div className="menu__sep" />
              <button type="button" role="menuitem" className="menu__item" onClick={signOut}>
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {activeOrganizationId ? (
        <aside className={`sidebar${sidebarOpen ? " sidebar--open" : ""}`}>
          <nav className="nav" aria-label="Sections">
            {back ? (
              <button type="button" className="nav__item nav__back" onClick={() => go(back)}>
                <span className="nav__glyph" aria-hidden="true">
                  <Icon name="back" size={18} />
                </span>
                <span className="truncate">Back</span>
              </button>
            ) : null}
            <div className="nav__group">{groupLabel}</div>
            {nav.items.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                active={item.id === nav.activeId}
                onNavigate={go}
              />
            ))}
          </nav>
        </aside>
      ) : null}

      <main className="main" id="main">
        {misconfigured ? (
          <div className="banner banner--danger" role="status">
            <strong>Supabase is not configured.</strong>
            <span>
              Sign-in and data are unavailable. Set <code>VITE_SUPABASE_URL</code> and{" "}
              <code>VITE_SUPABASE_ANON_KEY</code> to enable this dashboard.
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
        {children}
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
