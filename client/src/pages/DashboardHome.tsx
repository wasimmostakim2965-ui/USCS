import { useAuth } from "@/../_core/hooks/useAuth";
import VercelControlPlane from "@/components/VercelControlPlane";

export default function DashboardHome() {
  const auth = useAuth({ redirectOnUnauthenticated: true, redirectPath: "/" });
  if (auth.loading) return <div className="auth-loading" aria-label="Loading" />;
  if (!auth.isAuthenticated) return <div className="auth-loading" aria-label="Redirecting" />;
  return <VercelControlPlane user={auth.user ? { name: auth.user.name } : null} logout={auth.logout} />;
}
