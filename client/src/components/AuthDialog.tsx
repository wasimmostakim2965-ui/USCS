import { Chrome, Github, Gitlab, LockKeyhole, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { isSupabaseAuthConfigured, signInWithProvider, type SupabaseProvider } from "@/lib/supabase";

const providers: Array<{ id: SupabaseProvider; label: string; note: string; icon: typeof Github }> = [
  { id: "google", label: "Continue with Google", note: "Google Workspace or personal account", icon: Chrome },
  { id: "github", label: "Continue with GitHub", note: "Developer identity and repositories", icon: Github },
  { id: "gitlab", label: "Continue with GitLab", note: "GitLab.com account", icon: Gitlab },
];

export default function AuthDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [pending, setPending] = useState<SupabaseProvider | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const continueWith = async (provider: SupabaseProvider) => {
    setPending(provider);
    const { error } = await signInWithProvider(provider);
    if (error) {
      setPending(null);
      toast.error("Unable to start authentication", { description: error.message });
    }
  };

  return <div className="auth-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
      <button className="auth-dialog-close" onClick={onClose} aria-label="Close authentication dialog"><X size={18} /></button>
      <div className="auth-dialog-mark"><span>U</span></div>
      <div className="auth-dialog-eyebrow">USCS identity</div>
      <h2 id="auth-dialog-title">{mode === "signin" ? "Welcome back" : "Create your workspace"}</h2>
      <p className="auth-dialog-copy">Use your existing provider identity. USCS never asks for or stores your provider password.</p>
      <div className="auth-mode-toggle" role="tablist" aria-label="Authentication mode">
        <button className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")} role="tab" aria-selected={mode === "signin"}>Sign in</button>
        <button className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")} role="tab" aria-selected={mode === "signup"}>Create account</button>
      </div>
      <div className="auth-provider-list">
        {providers.map(({ id, label, note, icon: Icon }) => <button className="auth-provider-button" key={id} disabled={Boolean(pending)} aria-busy={pending === id} onClick={() => continueWith(id)}>
          <span className={`auth-provider-icon auth-provider-${id}`}><Icon size={17} /></span>
          <span><strong>{pending === id ? "Opening secure sign-in…" : label}</strong><small>{note}</small></span>
          <span className="auth-provider-arrow">→</span>
        </button>)}
      </div>
      {!isSupabaseAuthConfigured && <div className="auth-config-warning"><LockKeyhole size={15} /><span>Authentication is not configured for this deployment yet. Add the browser-safe Supabase URL and publishable key before publishing.</span></div>}
      <p className="auth-dialog-footnote">By continuing, you will be redirected to Supabase Auth and then returned to the approved USCS application URL.</p>
    </section>
  </div>;
}
