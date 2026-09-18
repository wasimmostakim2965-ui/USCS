import { useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Lock, Mail, ShieldCheck, Smartphone } from 'lucide-react';
import Brand from '../components/Brand';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { passwordIssues } from '../lib/security';

type Mode = 'signin' | 'signup' | 'verify' | 'forgot';

const countries = [
  'Bangladesh',
  'United States',
  'United Kingdom',
  'United Arab Emirates',
  'Canada',
  'Australia',
  'Germany',
  'India',
  'Singapore',
  'Other',
];

export default function Auth({
  initialMode,
  onBack,
  onSignedIn,
}: {
  initialMode: Mode;
  onBack: () => void;
  onSignedIn: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [country, setCountry] = useState('Bangladesh');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const clear = () => {
    setError('');
    setNotice('');
  };

  const guard = () => {
    if (!supabaseConfigured) {
      setError(
        'This deployment is not connected to the auth backend yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then redeploy.',
      );
      return false;
    }
    return true;
  };

  const signUp = async () => {
    clear();
    if (!guard()) return;
    const issues = passwordIssues(password);
    if (issues.length) return setError(`Your password needs ${issues.join(', ')}.`);
    if (password !== confirm) return setError('The passwords do not match.');
    try {
      setBusy(true);
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          emailRedirectTo: window.location.origin,
          data: { country },
        },
      });
      if (signUpError) throw signUpError;
      if (data.session) return onSignedIn();
      setMode('verify');
    } catch (e) {
      setError((e as Error).message || 'We could not create your account.');
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    clear();
    if (!guard()) return;
    try {
      setBusy(true);
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (signInError) throw signInError;
      onSignedIn();
    } catch (e) {
      setError((e as Error).message || 'We could not sign you in.');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    clear();
    if (!guard()) return;
    try {
      setBusy(true);
      const { error: resendError } = await supabase.auth.resend({
        type: 'signup',
        email: email.trim().toLowerCase(),
        options: { emailRedirectTo: window.location.origin },
      });
      if (resendError) throw resendError;
      setNotice('A new confirmation link is on its way.');
    } catch (e) {
      setError((e as Error).message || 'We could not resend the confirmation email.');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    clear();
    if (!guard()) return;
    try {
      setBusy(true);
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        { redirectTo: window.location.origin },
      );
      if (resetError) throw resetError;
      setNotice('If that email is registered, a reset link has been sent.');
    } catch (e) {
      setError((e as Error).message || 'We could not start the password reset.');
    } finally {
      setBusy(false);
    }
  };

  const heading = {
    signin: 'Sign in to Paywai',
    signup: 'Create your Paywai account',
    verify: 'Confirm your email',
    forgot: 'Reset your password',
  }[mode];

  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <button
          className="btn btn-quiet"
          onClick={onBack}
          style={{ color: '#a9bdd2', alignSelf: 'flex-start', padding: 0 }}
        >
          <ArrowLeft size={14} /> Back to paywai.com
        </button>
        <Brand onDark />
        <h2 className="headline">
          One account for global payments, balances and cards.
        </h2>
        <p className="sub">
          Open a personal or business account, complete the identity checks required by financial
          regulation, and start moving money.
        </p>
        <div className="assurance">
          <div>
            <ShieldCheck size={17} />
            <span>
              <b>Verified identity</b>
              <small>Document and identity review before money can move.</small>
            </span>
          </div>
          <div>
            <Lock size={17} />
            <span>
              <b>Protected sign-in</b>
              <small>Two-factor authentication and a separate transaction password.</small>
            </span>
          </div>
          <div>
            <Smartphone size={17} />
            <span>
              <b>Alerts that matter</b>
              <small>Every account and security change is recorded for you.</small>
            </span>
          </div>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-topbar">
          <Brand />
          <button className="btn btn-quiet" onClick={onBack}>
            Back to website
          </button>
        </div>

        <div className={'auth-card' + (mode === 'verify' ? ' narrow' : '')}>
          <div className="auth-head">
            <h1>{heading}</h1>
            <p>
              {mode === 'signin' &&
                'Enter the email and password you used to open your Paywai account.'}
              {mode === 'signup' &&
                'We will send a confirmation link to your email to confirm it belongs to you.'}
              {mode === 'verify' &&
                `We sent a confirmation link to ${email}. Open it to activate your account.`}
              {mode === 'forgot' &&
                'Enter your account email and we will send a secure link to choose a new password.'}
            </p>
          </div>

          {error && <div className="alert alert-danger">{error}</div>}
          {notice && (
            <div className="alert alert-success">
              <CheckCircle2 size={16} /> {notice}
            </div>
          )}

          {mode === 'verify' && (
            <>
              <div className="alert alert-info">
                <Mail size={16} />
                <span>
                  Not seeing it? Check your spam folder. The link expires after a short time for
                  security.
                </span>
              </div>
              <button className="btn btn-ghost btn-block" onClick={resend} disabled={busy}>
                {busy ? 'Sending…' : 'Resend confirmation email'}
              </button>
              <button
                className="btn btn-quiet btn-block"
                style={{ marginTop: 10 }}
                onClick={() => {
                  clear();
                  setMode('signup');
                }}
              >
                Use a different email
              </button>
            </>
          )}

          {mode === 'signup' && (
            <>
              <label className="field">
                <span>Country or region of residence</span>
                <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
                  {countries.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <small className="hint">
                  Available products and payment rails depend on your country of residence.
                </small>
              </label>
              <label className="field">
                <span>Email address</span>
                <input
                  className="input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Create a password"
                />
                <small className="hint">
                  At least 8 characters with an uppercase letter, a lowercase letter and a number.
                </small>
              </label>
              <label className="field">
                <span>Confirm password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Repeat your password"
                />
              </label>
              <button className="btn btn-primary btn-block btn-lg" onClick={signUp} disabled={busy}>
                {busy ? 'Creating your account…' : 'Create account'} <ArrowRight size={16} />
              </button>
              <p className="legal" style={{ margin: '16px 0 0', border: 0, padding: 0 }}>
                By creating an account you agree to Paywai's terms and acknowledge our privacy
                notice. Identity verification is required before payment features are enabled.
              </p>
            </>
          )}

          {mode === 'signin' && (
            <>
              <label className="field">
                <span>Email address</span>
                <input
                  className="input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                />
              </label>
              <button
                className="btn btn-quiet"
                style={{ marginBottom: 14 }}
                onClick={() => {
                  clear();
                  setMode('forgot');
                }}
              >
                Forgot your password?
              </button>
              <button className="btn btn-primary btn-block btn-lg" onClick={signIn} disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'} <ArrowRight size={16} />
              </button>
            </>
          )}

          {mode === 'forgot' && (
            <>
              <label className="field">
                <span>Email address</span>
                <input
                  className="input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <button className="btn btn-primary btn-block btn-lg" onClick={reset} disabled={busy}>
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <button
                className="btn btn-quiet btn-block"
                style={{ marginTop: 10 }}
                onClick={() => {
                  clear();
                  setMode('signin');
                }}
              >
                Back to sign in
              </button>
            </>
          )}

          {(mode === 'signin' || mode === 'signup' || mode === 'forgot') && (
            <>
              <div className="divider">or</div>
              <button
                className="btn btn-ghost btn-block"
                onClick={() => {
                  clear();
                  setMode(mode === 'signup' ? 'signin' : 'signup');
                }}
              >
                {mode === 'signup'
                  ? 'Already have an account? Sign in'
                  : 'New to Paywai? Create an account'}
              </button>
            </>
          )}
        </div>

        <p className="auth-foot">
          <Lock size={12} /> Paywai never asks for your bank password, and never stores your card
          PIN.
        </p>
      </main>
    </div>
  );
}