import { useAuth } from "@/_core/hooks/useAuth";
import AppShell from "@/components/AppShell";

export default function DashboardHome() {
  const auth = useAuth({ redirectOnUnauthenticated: true, redirectPath: "/" });
  if (auth.loading) return <div className="auth-loading" aria-label="Loading" />;
  if (!auth.isAuthenticated) return <div className="auth-loading" aria-label="Redirecting" />;
  return <AppShell user={auth.user ? { id: auth.user.id, name: auth.user.name, email: auth.user.email, role: auth.user.role } : null} logout={auth.logout} />;
}
