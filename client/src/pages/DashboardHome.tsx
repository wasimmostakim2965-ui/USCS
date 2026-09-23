import { useAuth } from "@/_core/hooks/useAuth";
import ControlPlaneShell from "@/control-plane/ControlPlaneShell";

export default function DashboardHome() {
  const auth = useAuth({ redirectOnUnauthenticated: true, redirectPath: "/" });
  if (auth.loading) return <div className="auth-loading" aria-label="Loading" />;
  if (!auth.isAuthenticated) return <div className="auth-loading" aria-label="Redirecting" />;
  return <ControlPlaneShell user={auth.user ? { name: auth.user.name, email: auth.user.email } : null} logout={auth.logout} />;
}
