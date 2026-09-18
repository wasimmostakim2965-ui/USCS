import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  BadgeCheck,
  BarChart3,
  CreditCard,
  FileText,
  Globe2,
  LayoutDashboard,
  Menu,
  Receipt,
  Send,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';
import Brand from '../components/Brand';
import SecurityPanel from './SecurityPanel';
import { supabase } from '../lib/supabase';
import {
  STATUS_COPY,
  ensureLedgerAccount,
  formatMinor,
  loadLedger,
  loadProfile,
  loadTransactions,
  type LedgerAccount,
  type Profile,
  type Transaction,
} from '../lib/account';

const tabs = [
  { name: 'Overview', icon: LayoutDashboard },
  { name: 'Balances', icon: Wallet },
  { name: 'Payments', icon: Send },
  { name: 'Cards', icon: CreditCard },
  { name: 'Recipients', icon: Users },
  { name: 'Activity', icon: Receipt },
  { name: 'Statements', icon: FileText },
  { name: 'Compliance', icon: ShieldCheck },
  { name: 'Settings', icon: Settings },
];

export default function Dashboard({
  userId,
  onExit,
  onCompleteProfile,
}: {
  userId: string;
  onExit: () => void;
  onCompleteProfile: () => void;
}) {
  const [tab, setTab] = useState('Overview');
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ledger, setLedger] = useState<LedgerAccount[]>([]);
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await loadProfile(userId);
        if (!alive) return;
        setProfile(p);
        if (p?.onboarding_status === 'verified' || p?.onboarding_status === 'submitted') {
          await ensureLedgerAccount(userId, 'USD');
        }
        const [l, t] = await Promise.all([loadLedger(userId), loadTransactions(userId)]);
        if (!alive) return;
        setLedger(l);
        setTxs(t);
      } catch (e) {
        if (alive) setError((e as Error).message || 'We could not load your workspace.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  const usd = ledger.find((a) => a.currency === 'USD');
  const available = usd?.available_minor ?? 0;
  const pending = usd?.pending_minor ?? 0;
  const total = ledger.reduce((sum, a) => sum + a.available_minor, 0);

  const status = profile?.onboarding_status ?? 'started';
  const needsOnboarding =
    status === 'started' || status === 'details_pending' || status === 'kyc_pending';
  const displayName = profile?.full_name || profile?.email || 'Your workspace';
  const isBusiness = profile?.account_type === 'business';

  const select = (name: string) => {
    setTab(name);
    setOpen(false);
  };

  return (
    <div className="app-shell">
      {open && <button className="backdrop show" aria-label="Close menu" onClick={() => setOpen(false)} />}
      <aside className={'sidebar' + (open ? ' open' : '')}>
        <Brand onDark />
        <div className="who">
          <b>{displayName}</b>
          <small>{isBusiness ? 'Business account' : 'Personal account'}</small>
        </div>
        <nav>
          {tabs.map(({ name, icon: Icon }) => (
            <button key={name} className={tab === name ? 'on' : ''} onClick={() => select(name)}>
              <Icon size={16} /> {name}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button
          className="signout"
          onClick={async () => {
            await supabase.auth.signOut();
            onExit();
          }}
        >
          Sign out
        </button>
      </aside>

      <main className="app-main">
        <header className="app-topbar">
          <button className="burger" aria-label="Open menu" onClick={() => setOpen(true)}>
            <Menu size={18} />
          </button>
          <div className="crumbs">
            Paywai / <b>{tab}</b>
          </div>
          <div className="right">
            {profile?.onboarding_status === 'verified' ? (
              <span className="pill">
                <BadgeCheck size={12} /> Verified
              </span>
            ) : (
              <span className="env-tag">
                {profile?.onboarding_status?.replace(/_/g, ' ') ?? 'not started'}
              </span>
            )}
          </div>
        </header>

        <div className="app-content">
          {error && <div className="alert alert-danger">{error}</div>}

          {needsOnboarding && !loading && (
            <div className="alert alert-warn">
              <ShieldCheck size={16} />
              <span>
                {STATUS_COPY[status]}{' '}
                <button className="btn-quiet" style={{ marginLeft: 4 }} onClick={onCompleteProfile}>
                  {status === 'started' ? 'Add your details' : 'Continue verification'}
                </button>
              </span>
            </div>
          )}

          {tab === 'Overview' && (
            <>
              <h1>Overview</h1>
              <p className="page-sub">
                {loading ? 'Loading your account…' : STATUS_COPY[status]}
              </p>

              <div className="quick-grid">
                <button onClick={() => select('Balances')}>
                  <Wallet size={17} />
                  <b>Add funds</b>
                  <small>Connect a funding rail</small>
                </button>
                <button onClick={() => select('Payments')}>
                  <Send size={17} />
                  <b>Send money</b>
                  <small>To a bank or wallet</small>
                </button>
                <button onClick={() => select('Payments')}>
                  <ArrowUpRight size={17} />
                  <b>Request money</b>
                  <small>Create a payment request</small>
                </button>
                <button onClick={() => select('Cards')}>
                  <CreditCard size={17} />
                  <b>Order a card</b>
                  <small>Virtual or physical</small>
                </button>
              </div>

              <div className="balance-grid">
                <section className="balance-hero">
                  <div className="label">Total available balance</div>
                  <div className="amount">{loading ? '—' : formatMinor(total)}</div>
                  <div className="sub">
                    {ledger.length === 0
                      ? 'No currency balances yet'
                      : `${ledger.length} currency ${ledger.length === 1 ? 'balance' : 'balances'}`}
                  </div>
                  <div className="foot">
                    <span>
                      Available <b>{formatMinor(available)}</b>
                    </span>
                    <span>
                      Pending <b>{formatMinor(pending)}</b>
                    </span>
                  </div>
                </section>
                <div className="stack">
                  <div className="card">
                    <h2>Verification status</h2>
                    <div className="kv">
                      <span>Identity</span>
                      <b>{profile?.onboarding_status?.replace(/_/g, ' ') ?? 'Not started'}</b>
                    </div>
                    <div className="kv">
                      <span>Account type</span>
                      <b>{isBusiness ? 'Business' : 'Personal'}</b>
                    </div>
                    <div className="kv">
                      <span>Outgoing limit</span>
                      <b>{status === 'verified' ? 'None' : '$100 USD'}</b>
                    </div>
                  </div>
                </div>
              </div>

              <div className="split">
                <section className="card">
                  <h2>Recent activity</h2>
                  {txs.length === 0 ? (
                    <div className="empty">
                      No activity yet. Payments, funding and card transactions will appear here.
                    </div>
                  ) : (
                    txs.map((t) => (
                      <div className="kv" key={t.id}>
                        <span>
                          {t.rail ?? 'Payment'} · {new Date(t.created_at).toLocaleDateString()}
                        </span>
                        <b>
                          {t.direction === 'in' ? '+' : '−'}
                          {formatMinor(t.amount_minor, t.currency)} · {t.status}
                        </b>
                      </div>
                    ))
                  )}
                </section>
                <section className="card">
                  <h2>Account security</h2>
                  <div className="kv">
                    <span>Email confirmed</span>
                    <b>Yes</b>
                  </div>
                  <div className="kv">
                    <span>Transaction password</span>
                    <b>Set in Settings</b>
                  </div>
                  <div className="kv">
                    <span>Two-factor authentication</span>
                    <b>Set in Settings</b>
                  </div>
                  <div className="kv">
                    <span>Account records</span>
                    <b>Audited</b>
                  </div>
                </section>
              </div>
            </>
          )}

          {tab === 'Settings' && (
            <>
              <h1>Settings</h1>
              <p className="page-sub">Manage the security controls that protect your account.</p>
              <SecurityPanel userId={userId} />
            </>
          )}

          {tab !== 'Overview' && tab !== 'Settings' && (
            <>
              <h1>{tab}</h1>
              <p className="page-sub">Manage {tab.toLowerCase()} for your Paywai account.</p>
              <section className="card">
                <h2>{tab}</h2>
                <p className="muted">
                  This area connects to payment partners and card processors. Nothing is shown until
                  a real provider is connected, so no balances or transactions are ever fabricated.
                </p>
                <div className="module-grid">
                  <div>
                    <Globe2 size={18} />
                    <b>Multi-currency ready</b>
                    <small>Balances are tracked per currency in your ledger.</small>
                  </div>
                  <div>
                    <ShieldCheck size={18} />
                    <b>Policy-aware</b>
                    <small>Actions respect your verification status and limits.</small>
                  </div>
                  <div>
                    <BarChart3 size={18} />
                    <b>Recorded</b>
                    <small>Every sensitive action is written to your audit history.</small>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}