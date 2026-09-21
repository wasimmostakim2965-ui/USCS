import { Chrome, Github, Gitlab, LockKeyhole, X, ArrowLeft, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { isSupabaseAuthConfigured, signInWithProvider, type SupabaseProvider } from "@/lib/supabase";

const providers: Array<{ id: SupabaseProvider; label: string; note: string; icon: typeof Github }> = [
  { id: "google", label: "Continue with Google", note: "Personal or Workspace account", icon: Chrome },
  { id: "github", label: "Continue with GitHub", note: "Developer identity", icon: Github },
  { id: "gitlab", label: "Continue with GitLab", note: "GitLab.com account", icon: Gitlab },
];

export default function AuthDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [pending, setPending] = useState<SupabaseProvider | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
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
      toast.error("Authentication is unavailable", { description: "This deployment is missing its browser-safe Supabase configuration." });
      return;
    }
    setPending(provider);
    const { error } = await signInWithProvider(provider);
    if (error) {
      setPending(null);
      toast.error("Unable to start secure sign-in", { description: "Please try again or choose another provider." });
    }
  };

  return <main className="auth-screen">
    <div className="auth-screen-grid" aria-hidden="true" />
    <section className="auth-panel" aria-labelledby="auth-title">
      <div className="auth-panel-topline"><span className="auth-brand"><span className="auth-brand-mark">U</span><span><strong>USCS</strong><small>Unified cloud platform</small></span></span><button className="auth-back" onClick={onClose}><ArrowLeft size={15} /> Back to site</button></div>
      <div className="auth-panel-content">
        <div className="auth-eyebrow"><span className="auth-status-dot" /> Secure workspace access</div>
        <h1 id="auth-title">{mode === "signin" ? "Welcome back." : "Start your workspace."}</h1>
        <p className="auth-lede">{mode === "signin" ? "Sign in with your existing provider identity and return to your control plane." : "Create a secure USCS workspace with the identity you already trust."}</p>
        <div className="auth-mode-toggle" role="tablist" aria-label="Authentication mode">
          <button className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")} role="tab" aria-selected={mode === "signin"}>Sign in</button>
          <button className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")} role="tab" aria-selected={mode === "signup"}>Create account</button>
        </div>
        <div className="auth-provider-list">
          {providers.map(({ id, label, note, icon: Icon }) => <button className="auth-provider-button" key={id} disabled={Boolean(pending)} aria-busy={pending === id} onClick={() => continueWith(id)}>
            <span className={`auth-provider-icon auth-provider-${id}`}><Icon size={18} strokeWidth={2} /></span>
            <span><strong>{pending === id ? "Opening secure sign-in…" : label}</strong><small>{note}</small></span>
            <span className="auth-provider-arrow">→</span>
          </button>)}
        </div>
        {!isSupabaseAuthConfigured && <div className="auth-config-warning"><LockKeyhole size={16} /><span><strong>Deployment configuration required</strong><small>Add the browser-safe Supabase URL and publishable key to the Vercel deployment environment.</small></span></div>}
        <div className="auth-trust-row"><ShieldCheck size={15} /><span>OAuth is handled by Supabase. USCS never sees or stores your provider password.</span></div>
        <p className="auth-legal">By continuing, you agree to use an authorized identity for this workspace. Existing identities sign in; new identities receive a profile and personal workspace automatically.</p>
      </div>
      <div className="auth-panel-footer"><span>USCS control plane</span><span>Secure by default · Evidence over empty scores</span></div>
    </section>
    <aside className="auth-aside" aria-label="USCS platform summary">
      <div className="auth-aside-copy"><span className="auth-aside-kicker">One calm surface</span><h2>Everything your product needs to run.</h2><p>Build, deploy, protect, and operate your applications without stitching together a dozen dashboards.</p></div>
      <div className="auth-aside-list"><div><span>01</span><strong>Real identity</strong><small>Google, GitHub, and GitLab through Supabase Auth.</small></div><div><span>02</span><strong>Tenant boundaries</strong><small>Profiles and workspaces are protected by Postgres RLS.</small></div><div><span>03</span><strong>Operational clarity</strong><small>No simulated metrics. No hidden infrastructure state.</small></div></div>
      <div className="auth-aside-signature"><span className="auth-signature-mark">U</span><span>Built for people who ship.</span></div>
    </aside>
    <button className="auth-mobile-close" onClick={onClose} aria-label="Close authentication"><X size={18} /></button>
  </main>;
}
