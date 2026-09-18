import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { supabase } from './lib/supabase';
import {
  ensureLedgerAccount,
  formatMinor,
  loadKyc,
  loadLedger,
  loadProfile,
  loadSecurity,
  loadTransactions,
  recordAudit,
  saveSecurity,
  STATUS_COPY,
  type KycApplication,
  type LedgerAccount,
  type Profile,
  type SecuritySettings,
  type Transaction,
} from './lib/account';
import { hashPassword } from './lib/security';
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  Lock,
  Menu,
  Send,
  ShieldCheck,
  Smartphone,
  Wallet,
  CheckCircle2,
} from 'lucide-react';

const DASHBOARD_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const makeDashboardSecret = () => { const bytes = crypto.getRandomValues(new Uint8Array(20)); let out='',buf=0,bits=0; for (const b of bytes) { buf=(buf<<8)|b; bits+=8; while(bits>=5){bits-=5;out+=DASHBOARD_B32[(buf>>bits)&31]} } if(bits) out+=DASHBOARD_B32[(buf<<(5-bits))&31]; return out; };
const decodeDashboardBase32 = (value:string) => { const clean=value.replace(/=+$/,'').toUpperCase(); let buf=0,bits=0; const out:number[]=[]; for(const c of clean){const n=DASHBOARD_B32.indexOf(c);if(n<0)throw new Error('Invalid authenticator secret');buf=(buf<<5)|n;bits+=5;if(bits>=8){bits-=8;out.push((buf>>bits)&255)}} return new Uint8Array(out); };
const dashboardHotp = async (secret:string,counter:number) => { const key=await crypto.subtle.importKey('raw',decodeDashboardBase32(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']); const data=new ArrayBuffer(8),view=new DataView(data);view.setUint32(0,Math.floor(counter/0x100000000));view.setUint32(4,counter>>>0);const d=new Uint8Array(await crypto.subtle.sign('HMAC',key,data));const o=d[d.length-1]&15;const n=((d[o]&127)<<24)|((d[o+1]&255)<<16)|((d[o+2]&255)<<8)|(d[o+3]&255);return String(n%1000000).padStart(6,'0'); };
const verifyDashboardTotp = async (secret:string,code:string) => { if(!/^\d{6}$/.test(code)) return false; const counter=Math.floor(Date.now()/30000); for(const delta of [-1,0,1]) if(await dashboardHotp(secret,counter+delta)===code)return true; return false; };
const TABS = [
  'Overview',
  'Money',
  'Payments',
  'Cards',
  'Recipients',
  'Activity',
  'Compliance',
  'Settings',
];

export default function Dashboard({ onBack, demoMode = false }: { onBack: () => void; demoMode?: boolean }) {
  const [tab, setTab] = useState('Overview');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [kyc, setKyc] = useState<KycApplication | null>(null);
  const [ledger, setLedger] = useState<LedgerAccount[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [security, setSecurity] = useState<SecuritySettings | null>(null);

  useEffect(() => {
    if (demoMode) { setEmail('TEST'); setLoading(false); setProfile({id:'demo',email:'TEST',account_type:'personal',country:'TEST',full_name:'TEST',phone:'TEST',phone_verified:true,business_name:null,business_type:null,business_category:null,onboarding_status:'verified',created_at:'',updated_at:''}); setKyc({id:'demo',user_id:'demo',status:'verified',legal_name:'TEST',date_of_birth:'2000-01-01',nationality:'TEST',occupation:'TEST',address_line1:'TEST',address_line2:null,city:'TEST',region:'TEST',postal_code:'TEST',tax_residence:'TEST',document_type:'TEST',document_number:'TEST',document_country:'TEST',submitted_at:null}); setLedger([{id:'demo-usd',currency:'USD',available_minor:2468000,pending_minor:0,status:'active'}]); setTransactions([{id:'demo-1',currency:'USD',amount_minor:425000,direction:'in',status:'settled',rail:'TEST',reference:'TEST',created_at:''},{id:'demo-2',currency:'USD',amount_minor:98000,direction:'out',status:'settled',rail:'TEST',reference:'TEST',created_at:''}]); setSecurity({transaction_password_hash:null,transaction_password_salt:null,transaction_password_iterations:null,mfa_secret:null,mfa_enabled:true}); return; }
    void (async () => {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user;
      if (!user) {
        setLoading(false);
        return;
      }
      setUserId(user.id);
      setEmail(user.email ?? '');
      try {
        const [p, k, l, t, s] = await Promise.all([
          loadProfile(user.id),
          loadKyc(user.id),
          loadLedger(user.id),
          loadTransactions(user.id),
          loadSecurity(user.id),
        ]);
        setProfile(p);
        setKyc(k);
        setLedger(l);
        setTransactions(t);
        setSecurity(s);
        if (!l.length) {
          const created = await ensureLedgerAccount(user.id, 'USD');
          setLedger([created]);
        }
      } catch {
        /* the workspace renders its empty state if a read fails */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const signOut = async () => {
    if (userId) await recordAudit(userId, 'auth.signed_out', 'session');
    await supabase.auth.signOut();
    onBack();
  };

  const selectTab = (next: string) => {
    setTab(next);
    setOpen(false);
  };

  const totalAvailable = ledger.reduce((sum, account) => sum + account.available_minor, 0);
  const totalPending = ledger.reduce((sum, account) => sum + account.pending_minor, 0);
  const displayName = profile?.full_name || email.split('@')[0] || 'Your account';
  const statusCopy = profile ? STATUS_COPY[profile.onboarding_status] : 'Loading your account…';
  const emailConfirmed = Boolean(profile?.email) || Boolean(email);

  return (
    <div className="dash">
      {open && (
        <button className="dash-menu-backdrop" aria-label="Close menu" onClick={() => setOpen(false)} />
      )}
      <aside className={open ? 'open' : ''}>
        <button className="logo" onClick={onBack}>
          <span>P</span>PAYWAI
        </button>
        <div className="workspace-user">
          <b>{displayName}</b>
          <small>{profile?.account_type === 'business' ? 'Business account' : 'Personal account'}</small>
        </div>
        {TABS.map((t) => (
          <button className={tab === t ? 'selected' : ''} onClick={() => selectTab(t)} key={t}>
            {t}
          </button>
        ))}
        <button className="signout" onClick={signOut}>
          <ArrowLeft size={13} /> Sign out
        </button>
      </aside>
      <main>
        <header>
          <button
            className="mobile-menu-button"
            aria-label="Open dashboard menu"
            onClick={() => setOpen(true)}
          >
            <Menu />
          </button>
          <span>
            {displayName} / {tab}
          </span>
          <span className="env">● {profile?.onboarding_status.toUpperCase() ?? 'LOADING'}</span>
        </header>
        <div className="dash-content">
          {security && !security.mfa_enabled && (
            <div className="limit">
              <b>Set up your authenticator app</b>
              <span>Your account does not have authenticator verification enabled yet. <button className="dash-security-link" onClick={() => selectTab('Settings')}>Set it up in Security Settings</button></span>
            </div>
          )}

          <h1>{tab}</h1>
          <p className="dash-sub">
            {tab === 'Overview'
              ? 'Here is the financial position that matters right now.'
              : `Manage your ${tab.toLowerCase()} workspace.`}
          </p>

          {tab === 'Overview' ? (
            loading ? (
              <section className="module">
                <h2>Loading your account…</h2>
                <p>Fetching your balances, verification status and security settings.</p>
              </section>
            ) : (
              <>
                <div className="quick">
                  <button onClick={() => selectTab('Money')}>
                    <Wallet />
                    <b>Add funds</b>
                    <small>Bank or wallet</small>
                  </button>
                  <button onClick={() => selectTab('Payments')}>
                    <Send />
                    <b>Send</b>
                    <small>Move money</small>
                  </button>
                  <button onClick={() => selectTab('Payments')}>
                    <ArrowRight />
                    <b>Receive</b>
                    <small>Get paid</small>
                  </button>
                </div>
                <div className="cards">
                  <section className="treasury">
                    <small>TOTAL AVAILABLE BALANCE</small>
                    <strong>{formatMinor(totalAvailable)}</strong>
                    <p>
                      {ledger.length
                        ? `${ledger.length} currency ${ledger.length === 1 ? 'balance' : 'balances'}`
                        : 'No currency balances yet.'}
                    </p>
                    <div className="empty">
                      Activity will appear here after the first settled transaction. No funding rail
                      is connected yet.
                    </div>
                    <footer>
                      Available <b>{formatMinor(totalAvailable)}</b>
                      <span>
                        Pending <b>{formatMinor(totalPending)}</b>
                      </span>
                    </footer>
                  </section>
                  <section className="side">
                    {ledger.length ? (
                      ledger.slice(0, 2).map((account) => (
                        <div key={account.id}>
                          <small>{account.currency} BALANCE</small>
                          <strong>{formatMinor(account.available_minor, account.currency)}</strong>
                          <p>{account.status === 'unfunded' ? 'Ready to fund' : account.status}</p>
                        </div>
                      ))
                    ) : (
                      <div>
                        <small>AVAILABLE TO MOVE</small>
                        <strong>$0.00</strong>
                        <p>No funding rail connected</p>
                      </div>
                    )}
                  </section>
                </div>
                <div className="bottom">
                  <section>
                    <h2>Recent activity</h2>
                    {transactions.length ? (
                      transactions.map((tx) => (
                        <p key={tx.id}>
                          {tx.direction === 'in' ? 'Received' : 'Sent'} {formatMinor(tx.amount_minor, tx.currency)} ·{' '}
                          {tx.status}
                        </p>
                      ))
                    ) : (
                      <p>
                        No activity yet. Settled transactions and security events will appear here.
                      </p>
                    )}
                  </section>
                  <section>
                    <h2>Verification status</h2>
                    <p>Identity — {kyc?.status ?? 'not started'}</p>
                    <p>Account type — {profile?.account_type ?? 'unknown'}</p>
                    <p>Email confirmed — {emailConfirmed ? 'Yes' : 'Pending'}</p>
                    <p>Country — {profile?.country ?? 'Not set'}</p>
                  </section>
                </div>
              </>
            )
          ) : tab === 'Settings' ? (
            <SecurityPanel userId={userId} security={security} onSaved={setSecurity} />
          ) : (
            <section className="module">
              <h2>{tab}</h2>
              <p>
                This workspace is ready for real integrations. No fabricated balances, transactions
                or performance figures are shown.
              </p>
              <div className="module-grid">
                <div>
                  <Wallet />
                  <b>Ready</b>
                  <small>Connect a supported rail</small>
                </div>
                <div>
                  <ShieldCheck />
                  <b>Policy-aware</b>
                  <small>Review controls before action</small>
                </div>
                <div>
                  <Globe2 />
                  <b>Global rails</b>
                  <small>Multiple currencies and routes</small>
                </div>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

function SecurityPanel({
  userId,
  security,
  onSaved,
}: {
  userId: string | null;
  security: SecuritySettings | null;
  onSaved: (next: SecuritySettings) => void;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [mfaSetupSecret, setMfaSetupSecret] = useState('');
  const [mfaSetupQr, setMfaSetupQr] = useState('');
  const [mfaSetupCode, setMfaSetupCode] = useState('');

  const setMfa = async () => {
    if (!userId) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const secret = mfaSetupSecret || makeDashboardSecret();
      if (!mfaSetupSecret) {
        const uri = `otpauth://totp/${encodeURIComponent(`Paywai:${email}`)}?secret=${secret}&issuer=Paywai&algorithm=SHA1&digits=6&period=30`;
        const qr = await QRCode.toDataURL(uri, { width: 220, margin: 1 });
        setMfaSetupSecret(secret);
        setMfaSetupQr(qr);
        return;
      }
      if (!(await verifyDashboardTotp(secret, mfaSetupCode))) throw new Error('That authenticator code is incorrect or expired.');
      const next: SecuritySettings = {
        ...(security ?? {
          transaction_password_hash: null,
          transaction_password_salt: null,
          transaction_password_iterations: null,
          mfa_secret: null,
          mfa_enabled: false,
        }),
        mfa_secret: secret,
        mfa_enabled: true,
      };
      await saveSecurity(userId, next);
      await recordAudit(userId, 'security.mfa_enabled', 'security_settings');
      onSaved(next);
      setMfaSetupSecret('');
      setMfaSetupQr('');
      setMfaSetupCode('');
      setMessage('Authenticator app enabled successfully.');
    } catch (e) {
      setError((e as Error).message || 'Could not enable the authenticator app.');
    } finally {
      setBusy(false);
    }
  };

  const setTransactionPassword = async () => {
    if (!userId) return;
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const saltHex = Array.from(salt, (b) => b.toString(16).padStart(2, '0')).join('');
      const hash = await hashPassword(password, saltHex);
      const next: SecuritySettings = {
        ...(security ?? {
          transaction_password_hash: null,
          transaction_password_salt: null,
          transaction_password_iterations: null,
          mfa_secret: null,
          mfa_enabled: false,
        }),
        transaction_password_hash: hash,
        transaction_password_salt: saltHex,
        transaction_password_iterations: 210000,
      };
      await saveSecurity(userId, next);
      await recordAudit(userId, 'security.transaction_password_set', 'security_settings');
      onSaved(next);
      setPassword('');
      setConfirm('');
      setMessage('Transaction password saved. It will be required for sensitive transfers.');
    } catch (e) {
      setError((e as Error).message || 'Could not save the transaction password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="module">
        <h2>Authenticator app</h2>
        <p>Use Google Authenticator or another compatible app for an additional sign-in verification step.</p>
        {security?.mfa_enabled ? (
          <div className="success-note"><CheckCircle2 size={15} /> Authenticator verification is enabled on this account.</div>
        ) : mfaSetupQr ? (
          <>
            <div className="mfa-setup">
              <img className="mfa-qr" src={mfaSetupQr} alt="Authenticator setup QR code" />
              <div className="mfa-secret"><span>Manual setup key</span><strong>{mfaSetupSecret}</strong></div>
              <label>6-digit authenticator code<input className="otp-input" inputMode="numeric" maxLength={6} value={mfaSetupCode} onChange={e=>setMfaSetupCode(e.target.value.replace(/\D/g,''))} placeholder="000000" /></label>
            </div>
            {error && <div className="error-note">{error}</div>}
            <div className="onboarding-actions">
              <button className="secondary" onClick={()=>{setMfaSetupSecret('');setMfaSetupQr('');setMfaSetupCode('');setError('')}} disabled={busy}>Cancel</button>
              <button className="primary" onClick={setMfa} disabled={busy}>{busy?'Verifying…':'Enable authenticator'} <CheckCircle2 size={15}/></button>
            </div>
          </>
        ) : (
          <div className="onboarding-actions">
            <span />
            <button className="primary" onClick={setMfa} disabled={busy}>Set up authenticator</button>
          </div>
        )}
      </section>

      <section className="module">
        <h2>Transaction password</h2>
        <p>
          A separate password used to authorise sensitive transfers. It is never your login
          password, and Paywai only stores a one-way hash of it.
        </p>
        {security?.transaction_password_hash && (
          <div className="success-note">
            <ShieldCheck size={15} /> A transaction password is already set. Enter a new one below to
            replace it.
          </div>
        )}
        <div className="form-grid" style={{ marginTop: 18 }}>
          <label>
            New transaction password
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </label>
          <label>
            Confirm transaction password
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat the password"
            />
          </label>
        </div>
        <div className="onboarding-actions">
          <span />
          <button className="primary" onClick={setTransactionPassword} disabled={busy}>
            {busy ? 'Saving…' : security?.transaction_password_hash ? 'Replace password' : 'Set password'}
          </button>
        </div>
        {message && <div className="success-note">{message}</div>}
        {error && <div className="error-note">{error}</div>}
      </section>

      <section className="module">
        <h2>Two-factor authentication</h2>
        <p>
          Add an authenticator app so a stolen password alone cannot access your account. This is
          optional, and you can set it up whenever you are ready.
        </p>
        <div className="module-grid">
          <div>
            <Smartphone />
            <b>{security?.mfa_enabled ? 'Enabled' : 'Not enabled'}</b>
            <small>{security?.mfa_enabled ? 'Your account is protected' : 'Recommended for payouts'}</small>
          </div>
          <div>
            <Lock />
            <b>Transaction password</b>
            <small>{security?.transaction_password_hash ? 'Set' : 'Not set'}</small>
          </div>
          <div>
            <ShieldCheck />
            <b>Audited</b>
            <small>Security changes are recorded</small>
          </div>
        </div>
      </section>
    </>
  );
}
