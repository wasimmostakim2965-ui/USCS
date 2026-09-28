import { useState } from "react";
import { Button, Icon, type IconName } from "@cloud-wai/ui/react";
import type { OAuthProvider, SessionController } from "../session.js";

const providers: readonly { id: OAuthProvider; label: string; icon: IconName }[] = [
  { id: "github", label: "Continue with GitHub", icon: "git" },
  { id: "gitlab", label: "Continue with GitLab", icon: "git" },
  { id: "google", label: "Continue with Google", icon: "domains" },
];

export function LoginPage({
  session,
  misconfigured,
}: {
  readonly session: SessionController;
  readonly misconfigured: boolean;
}) {
  const [pending, setPending] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const continueWith = async (provider: OAuthProvider) => {
    setPending(provider);
    setError(null);
    try {
      await session.signInWithProvider(provider);
    } catch (caught) {
      setPending(null);
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    }
  };

  return (
    <main className="login" aria-labelledby="login-title">
      <section className="login__panel">
        <div className="login__mark">Cloud Wai</div>
        <p className="login__tag">The control plane for modern applications.</p>
        <div className="login__copy">
          <h1 id="login-title">Sign in to Cloud Wai</h1>
          <p>Use the identity provider connected to your team.</p>
        </div>
        <div className="login__providers" aria-label="Sign in providers">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              variant={provider.id === "github" ? "primary" : "default"}
              disabled={Boolean(pending) || misconfigured}
              busy={pending === provider.id}
              onClick={() => void continueWith(provider.id)}
            >
              <Icon name={provider.icon} size={17} />
              {pending === provider.id ? "Opening secure sign-in…" : provider.label}
            </Button>
          ))}
        </div>
        {misconfigured ? (
          <div className="banner banner--danger" role="status">
            <strong>Authentication is not configured.</strong>
            <span>
              Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> for this
              deployment.
            </span>
          </div>
        ) : null}
        {error ? (
          <div className="banner banner--danger" role="alert">
            {error}
          </div>
        ) : null}
        <p className="login__legal">
          By continuing, you agree to use Cloud Wai under your organization’s access policy.
        </p>
      </section>
    </main>
  );
}
