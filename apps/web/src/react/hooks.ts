/**
 * React hooks for the dashboard.
 *
 * The router here is deliberately tiny and URL-driven: the route is parsed from
 * `location`, and navigating writes to `location`. There is no in-memory
 * "current page" state that could disagree with the address bar, which is what
 * makes refresh and deep links work.
 *
 * `parseRoute`/`toPath` from `routes.ts` are the source of truth, so this file
 * cannot invent a URL shape the rest of the app does not understand.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Section } from "@cloud-wai/ui";
import { loading } from "@cloud-wai/ui";
import { parseRoute, toPath, type Route } from "../routes.js";

/** Read the current path from the hash, falling back to a real pathname. */
function readLocation(): string {
  if (typeof window === "undefined") return "/";
  const hash = window.location.hash;
  if (hash.startsWith("#/")) return hash.slice(1);
  // No hash yet: honour a real path if the host serves one (a server-rendered
  // deep link), otherwise start at the root.
  const path = window.location.pathname;
  return path === "" ? "/" : path;
}

export interface Router {
  readonly route: Route;
  readonly path: string;
  navigate: (route: Route) => void;
  /** Navigate by URL string, for links read from an event. */
  navigateTo: (path: string) => void;
}

export function useRouter(): Router {
  const [path, setPath] = useState<string>(() => readLocation());

  useEffect(() => {
    const sync = () => setPath(readLocation());
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    // Normalise the address bar so a reload lands on the same view even when
    // the initial load had no hash.
    if (!window.location.hash) {
      window.history.replaceState(null, "", `#${readLocation()}`);
    }
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  const navigateTo = useCallback((next: string) => {
    window.location.hash = next.startsWith("#") ? next : `#${next}`;
    setPath(next);
  }, []);

  const navigate = useCallback(
    (route: Route) => {
      navigateTo(toPath(route));
    },
    [navigateTo],
  );

  const route = useMemo(() => parseRoute(path), [path]);

  return { route, path, navigate, navigateTo };
}

/**
 * Run a loader and hold its `Section`.
 *
 * The initial state is `loading`, not a default that could be mistaken for
 * data. A stale response is dropped: a slow request for a project the user has
 * already navigated away from must not overwrite the current view.
 */
export function useSection<T>(
  loader: () => Promise<Section<T>>,
  deps: readonly unknown[],
  title: string,
): { readonly section: Section<T>; readonly reload: () => void } {
  const [section, setSection] = useState<Section<T>>(() => loading<T>(title));
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    let cancelled = false;
    void loader()
      .then((next) => {
        if (!cancelled && id === requestId.current) setSection(next);
      })
      .catch((error: unknown) => {
        if (cancelled || id !== requestId.current) return;
        setSection({
          title,
          state: {
            kind: "error",
            message: error instanceof Error ? error.message : "The request failed.",
          },
        });
      });
    return () => {
      cancelled = true;
    };
    // The caller owns the dependency list, exactly as with useEffect.
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { section, reload };
}

/**
 * Run a keyset-paged loader and accumulate its pages.
 *
 * The first page is `loading` until it arrives; "load more" fetches the page
 * after the last row's cursor and *appends* it, so the list grows instead of
 * being replaced by a later window. It never claims completeness: the caller
 * renders `hasMore` and offers the action only while a full page came back,
 * because a store clamps the page size — a short page is the only honest signal
 * that there is nothing older.
 *
 * A reload (a mutation, a project change) resets to the first page, so the
 * accumulated pages cannot mix a previous project's rows with the current one.
 */
export function usePagedSection<T extends { readonly createdAt: string }>(
  loader: (before?: string) => Promise<Section<T>>,
  deps: readonly unknown[],
  title: string,
  pageSize: number,
): {
  readonly section: Section<T>;
  readonly reload: () => void;
  readonly loadMore: () => void;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
} {
  const [section, setSection] = useState<Section<T>>(() => loading<T>(title));
  const [nonce, setNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const requestId = useRef(0);
  const items = useRef<readonly T[]>([]);

  useEffect(() => {
    const id = ++requestId.current;
    let cancelled = false;
    items.current = [];
    setHasMore(false);
    void loader()
      .then((next) => {
        if (cancelled || id !== requestId.current) return;
        const loaded = next.state.kind === "ready" ? next.state.items : [];
        items.current = loaded;
        setHasMore(next.state.kind === "ready" && loaded.length >= pageSize);
        setSection(next);
      })
      .catch((error: unknown) => {
        if (cancelled || id !== requestId.current) return;
        setSection({
          title,
          state: {
            kind: "error",
            message: error instanceof Error ? error.message : "The request failed.",
          },
        });
      });
    return () => {
      cancelled = true;
    };
    // The caller owns the dependency list, exactly as with useEffect.
  }, [...deps, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    const oldest = items.current[items.current.length - 1];
    if (!oldest || loadingMore) return;
    const id = requestId.current;
    setLoadingMore(true);
    void loader(oldest.createdAt)
      .then((next) => {
        // Dropped if a reload happened while this page was in flight.
        if (id !== requestId.current) return;
        const page = next.state.kind === "ready" ? next.state.items : [];
        const seen = new Set(items.current.map((item) => item.createdAt));
        const fresh = page.filter((item) => !seen.has(item.createdAt));
        items.current = [...items.current, ...fresh];
        // A full page means there may be more; the last short page ends it.
        setHasMore(page.length >= pageSize);
        setSection({
          title,
          state: { kind: "ready", items: items.current },
        });
      })
      .catch(() => {
        // A failed "load more" leaves the loaded pages intact; the action can be
        // tried again. It must not clear what is already on screen.
      })
      .finally(() => setLoadingMore(false));
  }, [loader, loadingMore, title, pageSize]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { section, reload, loadMore, loadingMore, hasMore };
}

/** Persist a small value, tolerating a browser with storage disabled. */
export function usePersistentState(
  key: string,
  fallback: string,
): readonly [string, (value: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (next: string) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Storage disabled: the value still applies for this session.
      }
    },
    [key],
  );

  return [value, set] as const;
}

export type ThemeName = "dark" | "light";

/** The colour scheme, applied to `<html data-theme>` and persisted per browser. */
export function useTheme(): readonly [ThemeName, () => void] {
  const [theme, setTheme] = usePersistentState("cloud-wai.theme", "light");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return [theme as ThemeName, toggle] as const;
}

/** Set the document title. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title === "" ? "Cloud Wai" : `${title} · Cloud Wai`;
  }, [title]);
}

/**
 * Close a popover when the user clicks away or presses Escape.
 *
 * Used by the profile menu and the workspace switcher, so both behave the same
 * way and neither leaves a panel stuck open over the page.
 */
export function useDismissable(
  open: boolean,
  close: () => void,
): { readonly ref: React.RefObject<HTMLDivElement | null> } {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return { ref };
}

/** The global command palette shortcut, Ctrl/Cmd+K. */
export function useCommandShortcut(open: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
}

/**
 * Whether a media query currently matches.
 *
 * Used to *render* a viewport-specific control rather than only hiding it with
 * CSS: a control hidden by `display: none` is still in the accessibility tree
 * of an engine that does not apply the sheet, which would expose two copies of
 * the navigation. Engines without `matchMedia` (and the test environment) get
 * `false`, i.e. the wide layout.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
