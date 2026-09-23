/**
 * The signed-out view.
 *
 * A signed-out user sees this, not a blank page or a dashboard of empty panels.
 * It uses Supabase email/password auth, which is the only browser identity
 * source; there is no separate Cloud Wai password.
 */
import { useState } from "react";
import { Button, Field, TextInput } from "@cloud-wai/ui/react";
import type { SessionController } from "../session.js";

type Mode = "signin" | "signup";

export function LoginPage({
  session,
  misconfigured,
}: {
  readonly session: SessionController;
  readonly misconfigured: boolean;
}) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signin") {
        await session.signInWithPassword(email, password);
      } else {
        const result = await session.signUpWithPassword(email, password);
        if (result.needsConfirmation) {
          setNotice("Check your email to confirm the account, then sign in.");
          setMode("signin");
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__panel">
        <div className="login__mark">Cloud Wai</div>
        <p className="login__tag">
          Multi-tenant control plane for self-operated hosting and data services.
        </p>

        {misconfigured ? (
          <div className="banner banner--danger" role="status">
            <strong>Supabase is not configured.</strong>
            <span>
              Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to enable
              sign-in.
            </span>
          </div>
        ) : null}

        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label="Email">
            {(id) => (
              <TextInput
                id={id}
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="you@company.com"
                autoFocus
              />
            )}
          </Field>
          <Field
            label="Password"
            {...(mode === "signup" ? { hint: "At least 8 characters." } : {})}
            {...(error ? { error } : {})}
          >
            {(id) => (
              <TextInput
                id={id}
                type="password"
                value={password}
                onChange={setPassword}
                error={Boolean(error)}
                onEnter={() => void submit()}
              />
            )}
          </Field>

          {notice ? (
            <div className="banner" role="status">
              {notice}
            </div>
          ) : null}

          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!email || !password || misconfigured}
          >
            {mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <div className="row" style={{ marginTop: "var(--space-4)" }}>
          <span className="faint small">
            {mode === "signin" ? "No account yet?" : "Already have an account?"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
            }}
          >
            {mode === "signin" ? "Create one" : "Sign in"}
          </Button>
        </div>
      </div>
    </div>
  );
}
