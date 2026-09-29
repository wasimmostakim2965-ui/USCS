import { useState } from "react";
import { Button, Icon, type IconName } from "@cloud-wai/ui/react";
import type { OAuthProvider, SessionController } from "../session.js";

/** One sign-in provider: its id, its label and the provider's own logo. */
interface ProviderChoice {
  readonly id: OAuthProvider;
  readonly label: string;
  readonly icon: IconName;
}

// The provider's real brand mark, not a generic glyph, and the same label the
// provider's own docs use ("Sign in with …"). Brand marks live in the icon set.
const providerChoices: readonly ProviderChoice[] = [
  { id: "github", label: "Sign in with GitHub", icon: "github" },
  { id: "gitlab", label: "Sign in with GitLab", icon: "gitlab" },
  { id: "google", label: "Sign in with Google", icon: "google" },
];

export function LoginPage({
  session,
  misconfigured,
  oauthProviders = null,
}: {
  readonly session: SessionController;
  readonly misconfigured: boolean;
  /**
   * The providers the identity provider has enabled, or `null` when it could
   * not be asked. A button is shown only for an enabled provider, so a click
   * never lands on a provider that is switched off — the reason a sign-in that
   * "does nothing" happens. `null` and `[]` both mean "offer none".
   */
  readonly oauthProviders?: readonly OAuthProvider[] | null;
}) {
  const [pending, setPending] = useState<OAuthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  const available = providerChoices.filter(
    (choice) => oauthProviders?.includes(choice.id) === true,
  );

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
        {available.length > 0 ? (
          <div className="login__providers" aria-label="Sign in providers">
            {available.map((provider) => (
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
        ) : null}
        {misconfigured ? (
          <div className="banner banner--danger" role="status">
            <strong>Authentication is not configured.</strong>
            <span>
              Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> for
              this deployment.
            </span>
          </div>
        ) : available.length === 0 ? (
          <div className="banner" role="status">
            <strong>No sign-in provider is enabled.</strong>
            <span>
              This deployment has no OAuth provider switched on, so there is nothing to sign in with
              yet. An operator enables a provider (GitHub, GitLab or Google) in the identity
              provider&apos;s settings; until then this page will not offer a button that cannot
              work.
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
