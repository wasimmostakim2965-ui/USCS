import { Github, Gitlab, LockKeyhole, X, ArrowLeft, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { isSupabaseAuthConfigured, signInWithProvider, type SupabaseProvider } from "@/lib/supabase";

const providers: Array<{ id: SupabaseProvider; label: string; note: string; icon: "google" | typeof Github }> = [
  { id: "google", label: "Continue with Google", note: "Google account", icon: "google" },
  { id: "github", label: "Continue with GitHub", note: "GitHub account", icon: Github },
  { id: "gitlab", label: "Continue with GitLab", note: "GitLab.com account", icon: Gitlab },
];

function GoogleMark() {
  return (
    <span className="google-g-mark" aria-hidden="true">G</span>
  );
}

export default function AuthDialog({
  open,
  onClose,
  initialMode = "signin",
}: {
  open: boolean;
  onClose: () => void;
  initialMode?: "signin" | "signup";
}) {
  const [pending, setPending] = useState<SupabaseProvider | null>(null);

  useEffect(() => {
    if (!open) return;
    setPending(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    document.body.classList.add("auth-open");
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("auth-open");
    };
  }, [open, onClose]);

  if (!open) return null;

  const isSignup = initialMode === "signup";

  const continueWith = async (provider: SupabaseProvider) => {
    if (!isSupabaseAuthConfigured) {
      toast.error("Authentication is unavailable", {
        description: "This deployment is missing its browser-safe Supabase configuration.",
      });
      return;
    }

    setPending(provider);
    const { error } = await signInWithProvider(provider);
    if (error) {
      setPending(null);
      toast.error("Unable to start secure sign-in", {
        description: error.message || "Please try again or choose another provider.",
      });
    }
  };

  return (
    <main className="auth-screen">
      <div className="auth-screen-grid" aria-hidden="true" />

      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-panel-topline">
          <span className="auth-brand">
            <span className="auth-brand-mark">U</span>
            <span>
              <strong>USCS</strong>
              <small>Unified cloud platform</small>
            </span>
          </span>

          <button className="auth-back" onClick={onClose}>
            <ArrowLeft size={15} /> Back to site
          </button>
        </div>

        <div className="auth-panel-content">
          <div className="auth-eyebrow">
            <span className="auth-status-dot" /> Secure workspace access
          </div>

          <h1 id="auth-title">
            {isSignup ? "Create your workspace." : "Welcome back."}
          </h1>

          <p className="auth-lede">
            {isSignup
              ? "Create your USCS workspace using an identity you already trust."
              : "Sign in with your existing provider identity and return to your control plane."}
          </p>

          <div className="auth-provider-list" aria-label={isSignup ? "Create account with a provider" : "Sign in with a provider"}>
            {providers.map(({ id, label, icon }) => {
              const Icon = icon === "google" ? null : icon;
              return (
                <button
                  className="auth-provider-button"
                  key={id}
                  disabled={Boolean(pending)}
                  aria-busy={pending === id}
                  onClick={() => continueWith(id)}
                >
                  <span className={`auth-provider-icon auth-provider-${id}`}>
                    {Icon ? <Icon size={19} strokeWidth={2} /> : <GoogleMark />}
                  </span>
                  <strong>{pending === id ? "Opening secure sign-in…" : label}</strong>
                </button>
              );
            })}
          </div>

          {!isSupabaseAuthConfigured && (
            <div className="auth-config-warning">
              <LockKeyhole size={16} />
              <span>
                <strong>Deployment configuration required</strong>
                <small>Add the browser-safe Supabase URL and publishable key to the Vercel deployment environment.</small>
              </span>
            </div>
          )}

          <div className="auth-trust-row">
            <ShieldCheck size={15} />
            <span>OAuth is handled by Supabase. USCS never sees or stores your provider password.</span>
          </div>

          <p className="auth-legal">
            {isSignup
              ? "By continuing, you agree to create a USCS workspace. Your provider identity is used only to authenticate your account."
              : "Use the provider you originally used to create your USCS account. You will return to your workspace after authentication."}
          </p>
        </div>

        <div className="auth-panel-footer">
          <span>USCS control plane</span>
          <span>Secure by default · Evidence over empty scores</span>
        </div>
      </section>

      <aside className="auth-aside" aria-label="USCS platform summary">
        <div className="auth-aside-copy">
          <span className="auth-aside-kicker">One calm surface</span>
          <h2>Everything your product needs to run.</h2>
          <p>Build, deploy, protect, and operate your applications without stitching together a dozen dashboards.</p>
        </div>

        <div className="auth-aside-list">
          <div><span>01</span><strong>Real identity</strong><small>Google, GitHub, and GitLab through Supabase Auth.</small></div>
          <div><span>02</span><strong>Tenant boundaries</strong><small>Profiles and workspaces are protected by Postgres RLS.</small></div>
          <div><span>03</span><strong>Operational clarity</strong><small>No simulated metrics. No hidden infrastructure state.</small></div>
        </div>

        <div className="auth-aside-signature">
          <span className="auth-signature-mark">U</span>
          <span>Built for people who ship.</span>
        </div>
      </aside>

      <button className="auth-mobile-close" onClick={onClose} aria-label="Close authentication">
        <X size={18} />
      </button>
    </main>
  );
}
