import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseSession, supabase, subscribeToSupabaseAuth } from "@/lib/supabase";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

type BrowserAuthUser = {
  id: string;
  name: string | null;
  email: string | null;
  loginMethod: string;
  role: "user";
};

function browserUserFromSession(session: Session | null): BrowserAuthUser | null {
  const user = session?.user;
  if (!user) return null;

  const metadata = user.user_metadata ?? {};
  const fallbackName = typeof metadata.full_name === "string"
    ? metadata.full_name
    : typeof metadata.name === "string"
      ? metadata.name
      : user.email?.split("@")[0] ?? null;

  return {
    id: user.id,
    name: fallbackName,
    email: user.email ?? null,
    loginMethod: user.app_metadata?.provider ?? "supabase",
    role: "user",
  };
}

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};
  const utils = trpc.useUtils();
  const [browserUser, setBrowserUser] = useState<BrowserAuthUser | null>(null);
  const [browserLoading, setBrowserLoading] = useState(true);

  // The browser Supabase session is the source of truth for this client.
  // Server-side authorization is still verified separately by the tRPC auth
  // endpoint using the Supabase access token.
  const meQuery = trpc.auth.me.useQuery(undefined, {
    enabled: Boolean(browserUser),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      utils.auth.me.setData(undefined, null);
    },
  });

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch (error: unknown) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        return;
      }
      throw error;
    } finally {
      await supabase?.auth.signOut();
      setBrowserUser(null);
      try {
        sessionStorage.removeItem("manus-cookie");
      } catch {}
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    }
  }, [logoutMutation, utils]);

  useEffect(() => {
    let mounted = true;

    // IMPORTANT: keep this callback synchronous. Supabase currently documents
    // a deadlock risk when async Supabase calls (for example getUser/getSession
    // or table queries) are made from inside onAuthStateChange.
    // The session already contains the user needed to update the UI. The
    // server verifies the access token separately through tRPC.
    const { data } = subscribeToSupabaseAuth((_event, session) => {
      if (!mounted) return;
      setBrowserUser(browserUserFromSession(session));
      setBrowserLoading(false);
    });

    // Resolve the initial/persisted session outside the auth-state callback.
    void getSupabaseSession().then(({ data: { session } }) => {
      if (!mounted) return;
      setBrowserUser(browserUserFromSession(session));
      setBrowserLoading(false);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  // Invalidate the server-auth query only after the Supabase callback has
  // returned. This avoids starting another Supabase-backed request while the
  // auth state lock is held.
  useEffect(() => {
    if (!browserUser) return;
    void utils.auth.me.invalidate();
  }, [browserUser?.id, utils]);

  const state = useMemo(() => {
    const user = meQuery.data ?? browserUser;
    return {
      user,
      loading: (meQuery.isLoading && !browserUser) || browserLoading || logoutMutation.isPending,
      error: meQuery.error ?? logoutMutation.error ?? null,
      isAuthenticated: Boolean(user),
    };
  }, [
    meQuery.data,
    browserUser,
    browserLoading,
    meQuery.error,
    meQuery.isLoading,
    logoutMutation.error,
    logoutMutation.isPending,
  ]);

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || browserLoading || logoutMutation.isPending) return;
    if (state.user) return;
    if (typeof window === "undefined") return;
    if (redirectPath && window.location.pathname === redirectPath) return;

    if (redirectPath) {
      window.location.href = redirectPath;
    } else {
      startLogin();
    }
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    logoutMutation.isPending,
    meQuery.isLoading,
    browserLoading,
    state.user,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
