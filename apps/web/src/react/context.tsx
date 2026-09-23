/**
 * The dashboard's application context.
 *
 * Everything a page needs to reach the API is provided here: the `ApiClient`,
 * the current session and the router. A page never constructs a URL, never
 * reads an environment variable and never holds a token — it receives a client
 * that is already scoped to the Cloud Wai API.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ApiClient } from "../api-client.js";
import type { SessionController } from "../session.js";
import type { Router } from "./hooks.js";

export interface AppContextValue {
  readonly client: ApiClient;
  readonly session: SessionController;
  readonly router: Router;
  /** The signed-in user, for the profile menu. */
  readonly user: { readonly email: string | null; readonly displayName: string | null } | null;
  /** True when Supabase is not configured; the UI says so instead of blanking. */
  readonly misconfigured: boolean;
  signOut: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  value,
  children,
}: {
  readonly value: AppContextValue;
  readonly children: ReactNode;
}) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside an AppProvider.");
  return value;
}
