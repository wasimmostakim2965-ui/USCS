import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { CheckCircle2, Copy, Lock, ShieldCheck, Smartphone } from 'lucide-react';
import {
  buildOtpAuthUri,
  hashPassword,
  passwordIssues,
  randomBase32,
  randomHex,
  verifyTotp,
} from '../lib/security';
import { loadSecurity, recordAudit, saveSecurity } from '../lib/account';

export default function SecurityPanel({ userId }: { userId: string }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [hasTxPassword, setHasTxPassword] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(false);

  const [txPassword, setTxPassword] = useState('');
  const [txConfirm, setTxConfirm] = useState('');

  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await loadSecurity(userId);
        if (!alive) return;
        setHasTxPassword(Boolean(s?.transaction_password_hash));
        setMfaEnabled(Boolean(s?.mfa_enabled));
      } catch (e) {
        if (alive) setError((e as Error).message || 'We could not load your security settings.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  const setTransactionPassword = async () => {
    setError('');
    setNotice('');
    const issues = passwordIssues(txPassword);
    if (issues.length) return setError(`Your transaction password needs ${issues.join(', ')}.`);
    if (txPassword !== txConfirm) return setError('The passwords do not match.');
    try {
      setBusy(true);
      const salt = randomHex(16);
      const iterations = 210000;
      const hash = await hashPassword(txPassword, salt, iterations);
      await saveSecurity(userId, {
        transaction_password_hash: hash,
        transaction_password_salt: salt,
        transaction_password_iterations: iterations,
      });
      await recordAudit(userId, 'security.transaction_password_set', 'security_settings');
      setHasTxPassword(true);
      setTxPassword('');
      setTxConfirm('');
      setNotice('Transaction password saved. You will be asked for it before sensitive transfers.');
    } catch (e) {
      setError((e as Error).message || 'We could not save your transaction password.');
    } finally {
      setBusy(false);
    }
  };

  const beginMfa = async () => {
    setError('');
    setNotice('');
    try {
      setBusy(true);
      const value = randomBase32(20);
      setSecret(value);
      setQr(await QRCode.toDataURL(buildOtpAuthUri(value, userId), { width: 200, margin: 1 }));
    } catch (e) {
      setError((e as Error).message || 'We could not prepare authenticator setup.');
    } finally {
      setBusy(false);
    }
  };

  const confirmMfa = async () => {
    setError('');
    setNotice('');
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code from your authenticator app.');
    try {
      setBusy(true);
      if (!(await verifyTotp(secret, code))) {
        setBusy(false);
        return setError('That code is not valid. Check your device clock and try the newest code.');
      }
      await saveSecurity(userId, { mfa_secret: secret, mfa_enabled: true });
      await recordAudit(userId, 'security.mfa_enabled', 'security_settings');
      setMfaEnabled(true);
      setCode('');
      setQr('');
      setSecret('');
      setNotice('Two-factor authentication is now enabled for your account.');
    } catch (e) {
      setError((e as Error).message || 'We could not enable two-factor authentication.');
    } finally {
      setBusy(false);
    }
  };

  const disableMfa = async () => {
    setError('');
    setNotice('');
    try {
      setBusy(true);
      await saveSecurity(userId, { mfa_secret: null, mfa_enabled: false });
      await recordAudit(userId, 'security.mfa_disabled', 'security_settings');
      setMfaEnabled(false);
      setNotice('Two-factor authentication has been turned off.');
    } catch (e) {
      setError((e as Error).message || 'We could not update two-factor authentication.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="muted">Loading security settings…</p>;

  return (
    <>
      {error && <div className="alert alert-danger">{error}</div>}
      {notice && (
        <div className="alert alert-success">
          <CheckCircle2 size={16} /> {notice}
        </div>
      )}

      <div className="split">
        <section className="card">
          <h2>
            <Lock size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Transaction password
          </h2>
          <p className="muted" style={{ marginBottom: 18 }}>
            A separate password used only to authorise sensitive money movements. It is never your
            sign-in password, and it is stored as a salted PBKDF2 hash — never in plain text.
          </p>
          {hasTxPassword && (
            <div className="alert alert-info">
              <ShieldCheck size={16} /> A transaction password is already set. Saving a new one
              replaces it.
            </div>
          )}
          <label className="field">
            <span>New transaction password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={txPassword}
              onChange={(e) => setTxPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </label>
          <label className="field">
            <span>Confirm transaction password</span>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={txConfirm}
              onChange={(e) => setTxConfirm(e.target.value)}
              placeholder="Repeat the password"
            />
          </label>
          <button className="btn btn-primary" onClick={setTransactionPassword} disabled={busy}>
            {busy ? 'Saving…' : hasTxPassword ? 'Replace password' : 'Set password'}
          </button>
        </section>

        <section className="card">
          <h2>
            <Smartphone size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Two-factor authentication
          </h2>
          <p className="muted" style={{ marginBottom: 18 }}>
            Protect sign-in and payouts with a time-based code from an authenticator app such as
            Google Authenticator, Authy or 1Password.
          </p>

          {mfaEnabled && !qr && (
            <>
              <div className="alert alert-success">
                <CheckCircle2 size={16} /> Two-factor authentication is enabled.
              </div>
              <button className="btn btn-ghost" onClick={disableMfa} disabled={busy}>
                Turn off two-factor authentication
              </button>
            </>
          )}

          {!mfaEnabled && !qr && (
            <button className="btn btn-primary" onClick={beginMfa} disabled={busy}>
              {busy ? 'Preparing…' : 'Set up authenticator'}
            </button>
          )}

          {qr && (
            <>
              <img className="qr" src={qr} alt="Authenticator setup QR code" />
              <div className="secret-box">
                <span>Manual setup key</span>
                <strong>{secret}</strong>
              </div>
              <button
                className="btn btn-quiet"
                style={{ marginBottom: 14 }}
                onClick={() => navigator.clipboard?.writeText(secret)}
              >
                <Copy size={14} /> Copy setup key
              </button>
              <label className="field">
                <span>Enter the 6-digit code</span>
                <input
                  className="input otp"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                />
              </label>
              <button
                className="btn btn-primary btn-block"
                onClick={confirmMfa}
                disabled={busy || code.length !== 6}
              >
                {busy ? 'Verifying…' : 'Verify and enable'}
              </button>
            </>
          )}
        </section>
      </div>
    </>
  );
}