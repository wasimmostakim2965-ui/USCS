import { Github, Gitlab, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { isSupabaseAuthConfigured, signInWithProvider, type SupabaseProvider } from "@/lib/supabase";

const providers: Array<{ id: SupabaseProvider; label: string; icon: "google" | typeof Github }> = [
  { id: "google", label: "Continue with Google", icon: "google" },
  { id: "github", label: "Continue with GitHub", icon: Github },
  { id: "gitlab", label: "Continue with GitLab", icon: Gitlab },
];

function GoogleMark() {
  return (
    <svg className="google-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.35 12.27c0-.79-.07-1.55-.2-2.27H12v4.3h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.14c1.84-1.7 2.91-4.2 2.91-7.42Z" />
      <path fill="#34A853" d="M12 21.75c2.62 0 4.82-.87 6.43-2.36l-3.14-2.45c-.87.58-1.98.93-3.29.93-2.53 0-4.67-1.71-5.44-4.01H3.32v2.53A9.72 9.72 0 0 0 12 21.75Z" />
      <path fill="#FBBC05" d="M6.56 13.86A5.84 5.84 0 0 1 6.25 12c0-.64.11-1.27.31-1.86V7.61H3.32A9.75 9.75 0 0 0 2.25 12c0 1.57.38 3.05 1.07 4.39l3.24-2.53Z" />
      <path fill="#EA4335" d="M12 6.13c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.81 3.18 14.62 2.25 12 2.25a9.72 9.72 0 0 0-8.68 5.36l3.24 2.53c.77-2.3 2.91-4.01 5.44-4.01Z" />
    </svg>
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
  const isSignup = initialMode === "signup";

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
      <button className="auth-mobile-close" onClick={onClose} aria-label="Close authentication">
        <X size={18} />
      </button>

      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-logo">
          <span className="brand-mark auth-logo-mark"><span /></span>
          <span className="auth-logo-wordmark">USCS</span>
        </div>

        <div className="auth-copy">
          <h1 id="auth-title">{isSignup ? "Create your account" : "Sign in"}</h1>
          <p>{isSignup ? "Create your USCS account using a provider you already trust." : "Sign in to your USCS account."}</p>
        </div>

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
                  {Icon ? <Icon size={20} strokeWidth={2} /> : <GoogleMark />}
                </span>
                <strong>{pending === id ? "Opening secure sign-in…" : label}</strong>
              </button>
            );
          })}
        </div>

        <div className="auth-divider" aria-hidden="true">
          <span />
          <b>or</b>
          <span />
        </div>

        {!isSupabaseAuthConfigured && (
          <p className="auth-config-warning">
            Authentication configuration is required for this deployment.
          </p>
        )}

        <p className="auth-legal">
          {isSignup
            ? "By continuing, you agree to create a USCS account."
            : "Use the provider you originally used to create your USCS account."}
        </p>
      </section>

      <button className="auth-back-link" onClick={onClose}>Back to site</button>
    </main>
  );
}
