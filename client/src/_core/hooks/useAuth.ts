import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getBrowserAuthUser, getSupabaseSession, supabase, subscribeToSupabaseAuth } from "@/lib/supabase";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};
  const utils = trpc.useUtils();
  const [browserUser, setBrowserUser] = useState<Awaited<ReturnType<typeof getBrowserAuthUser>>>(null);
  const [browserLoading, setBrowserLoading] = useState(true);

  // The browser Supabase session is the source of truth for this client.
  // Do not call the legacy server auth endpoint until a Supabase user exists:
  // otherwise an anonymous page load produces UNAUTHORIZED and can trigger a
  // legacy login redirect before the user has a chance to use Supabase OAuth.
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

    // Subscribe before resolving the stored session so an OAuth callback cannot
    // be missed during the initial page load.
    const { data } = subscribeToSupabaseAuth((_event, session) => {
      if (!mounted) return;
      if (!session) {
        setBrowserUser(null);
        setBrowserLoading(false);
      } else {
        void getBrowserAuthUser().then(user => {
          if (!mounted) return;
          setBrowserUser(user);
          setBrowserLoading(false);
        });
      }
      void utils.auth.me.invalidate();
    });

    void getSupabaseSession().then(({ data: { session } }) => {
      if (!mounted) return;
      if (!session) {
        setBrowserUser(null);
        setBrowserLoading(false);
        return;
      }
      void getBrowserAuthUser().then(user => {
        if (!mounted) return;
        setBrowserUser(user);
        setBrowserLoading(false);
      });
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, [utils]);

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
