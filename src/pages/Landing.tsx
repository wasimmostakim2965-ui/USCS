import { useState } from 'react';
import {
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Building2,
  Check,
  CreditCard,
  Globe2,
  Lock,
  Mail,
  Menu,
  Send,
  ShieldCheck,
  Smartphone,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import Brand from '../components/Brand';

type Props = {
  onSignIn: () => void;
  onGetStarted: () => void;
  onPlatform: () => void;
};

const features = [
  {
    icon: Send,
    title: 'Send and receive globally',
    text: 'Move money to people, businesses and platforms with clear fees and tracking from start to finish.',
  },
  {
    icon: Wallet,
    title: 'Hold balances in your currency',
    text: 'Keep balances in the currencies you earn in and see everything together in one place.',
  },
  {
    icon: CreditCard,
    title: 'Spend with card controls',
    text: 'Issue cards for you or your team and set limits, freezes and controls per card.',
  },
  {
    icon: Users,
    title: 'Pay teams and suppliers',
    text: 'Schedule payouts, keep records tidy and give finance the visibility it needs.',
  },
  {
    icon: Globe2,
    title: 'Built for cross-border work',
    text: 'Get paid by international clients and platforms without waiting weeks for settlement.',
  },
  {
    icon: BarChart3,
    title: 'Understand your cashflow',
    text: 'Track activity, export statements and reconcile movement without chasing spreadsheets.',
  },
];

const onboarding = [
  {
    title: 'Create your account',
    text: 'Sign up with your email, confirm it, and tell us whether you are opening a personal or business account.',
  },
  {
    title: 'Verify your identity',
    text: 'Add your legal details and document information exactly as they appear on your ID, as required by financial regulation.',
  },
  {
    title: 'Start moving money',
    text: 'Once review is complete, connect a funding method and use your account for payments, cards and balances.',
  },
];

export default function Landing({ onSignIn, onGetStarted, onPlatform }: Props) {
  const [menu, setMenu] = useState(false);

  return (
    <div>
      <header className="site-header">
        <div className="wrap bar">
          <Brand />
          <nav className="site-nav">
            <a href="#products">Products</a>
            <a href="#how">How it works</a>
            <a href="#security">Security</a>
            <a href="#business">Business</a>
          </nav>
          <div className="site-actions">
            <button className="btn btn-ghost hide-sm" onClick={onSignIn}>
              Sign in
            </button>
            <button className="btn btn-primary" onClick={onGetStarted}>
              Create account <ArrowRight size={15} />
            </button>
          </div>
          <button
            className="menu-toggle"
            aria-label={menu ? 'Close navigation' : 'Open navigation'}
            onClick={() => setMenu(!menu)}
          >
            {menu ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        <div className={'mobile-nav' + (menu ? ' show' : '')}>
          <a href="#products" onClick={() => setMenu(false)}>
            Products
          </a>
          <a href="#how" onClick={() => setMenu(false)}>
            How it works
          </a>
          <a href="#security" onClick={() => setMenu(false)}>
            Security
          </a>
          <a href="#business" onClick={() => setMenu(false)}>
            Business
          </a>
          <button onClick={() => { setMenu(false); onSignIn(); }}>Sign in</button>
        </div>
      </header>

      <section className="hero">
        <div className="wrap inner">
          <div>
            <div className="eyebrow">Payments, balances and cards in one account</div>
            <h1>
              Move money across borders. <em>Keep full control.</em>
            </h1>
            <p className="lede">
              Paywai brings the way you get paid, hold funds and spend together in a single secure
              account — so you can work with clients, platforms and teams anywhere.
            </p>
            <div className="hero-cta">
              <button className="btn btn-primary btn-lg" onClick={onGetStarted}>
                Create your account <ArrowRight size={16} />
              </button>
              <button className="btn btn-ghost btn-lg" onClick={onPlatform}>
                See how it works
              </button>
            </div>
            <div className="trust-row">
              <span>
                <Check size={15} /> No hidden fees
              </span>
              <span>
                <Check size={15} /> Identity protected at every step
              </span>
              <span>
                <Check size={15} /> Support for cross-border payouts
              </span>
            </div>
          </div>

          <div className="hero-art" aria-hidden="true">
            <div className="hero-card">
              <div className="label">Available balance</div>
              <div className="amount">$24,680.00</div>
              <div className="row">
                <span>USD account</span>
                <span>Ready to send</span>
              </div>
            </div>
            <div className="hero-panel">
              <div className="head">
                <span>Recent activity</span>
                <span className="pill">
                  <BadgeCheck size={12} /> Verified
                </span>
              </div>
              <div className="line">
                <span className="avatar">A</span>
                <span>
                  <b>Atlas Studio</b>
                  <small>Payment received</small>
                </span>
                <span className="amt">+$4,250.00</span>
              </div>
              <div className="line">
                <span className="avatar">N</span>
                <span>
                  <b>Northwind Ltd</b>
                  <small>Payout sent</small>
                </span>
                <span className="amt" style={{ color: 'var(--ink-700)' }}>
                  −$1,120.00
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="products">
        <div className="wrap">
          <div className="section-head">
            <div className="eyebrow">One account. Every money movement.</div>
            <h2>Everything you need to get paid and pay others</h2>
            <p>
              Whether you invoice overseas clients, pay a distributed team or simply want one clear
              view of your money, Paywai is built for the whole flow.
            </p>
          </div>
          <div className="grid-3">
            {features.map(({ icon: Icon, title, text }) => (
              <article className="feature" key={title}>
                <div className="ico">
                  <Icon size={20} />
                </div>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section alt" id="how">
        <div className="wrap">
          <div className="section-head">
            <div className="eyebrow">How it works</div>
            <h2>Open an account in three clear steps</h2>
            <p>
              Financial accounts require identity checks. We do them once, upfront, so your account
              is ready for real payments.
            </p>
          </div>
          <div className="steps">
            {onboarding.map((item, index) => (
              <article className="step" key={item.title}>
                <div className="num">STEP {String(index + 1).padStart(2, '0')}</div>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="dark-band" id="security">
        <div className="wrap">
          <div className="eyebrow" style={{ color: '#6fb3f5' }}>
            Security and compliance
          </div>
          <h2>Your money and identity, protected by design</h2>
          <p>
            A payments account only works if you can trust it. Paywai is built around verification,
            monitoring and controls rather than bolted-on security.
          </p>
          <div className="cols">
            <div>
              <Lock size={20} color="#6fb3f5" />
              <b>Verified identity</b>
              <p>Every account completes identity and document checks before money can move.</p>
            </div>
            <div>
              <ShieldCheck size={20} color="#6fb3f5" />
              <b>Protected sign-in</b>
              <p>Two-factor authentication and a separate transaction password guard payouts.</p>
            </div>
            <div>
              <Smartphone size={20} color="#6fb3f5" />
              <b>Notifications you can act on</b>
              <p>Security events and account changes are recorded and surfaced to you.</p>
            </div>
            <div>
              <Mail size={20} color="#6fb3f5" />
              <b>Verified email and phone</b>
              <p>We confirm the contact details tied to your account before it goes live.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="business">
        <div className="wrap">
          <div className="section-head">
            <div className="eyebrow">For individuals and businesses</div>
            <h2>One platform, two ways to use it</h2>
          </div>
          <div className="grid-3">
            <article className="feature">
              <div className="ico">
                <Wallet size={20} />
              </div>
              <h3>Personal accounts</h3>
              <p>
                Receive money from platforms and clients, hold it safely and spend with a card that
                you control.
              </p>
            </article>
            <article className="feature">
              <div className="ico">
                <Building2 size={20} />
              </div>
              <h3>Business accounts</h3>
              <p>
                Pay suppliers and staff, issue cards for your team and keep financial records
                organised.
              </p>
            </article>
            <article className="feature">
              <div className="ico">
                <Globe2 size={20} />
              </div>
              <h3>Cross-border payouts</h3>
              <p>
                Get paid in the currency you work in and send funds onward without unnecessary
                delays.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="cta-band">
        <div className="wrap">
          <h2>Ready to open your Paywai account?</h2>
          <p>Create your account, verify your identity and start moving money with confidence.</p>
          <button className="btn btn-primary btn-lg" onClick={onGetStarted}>
            Create your account <ArrowRight size={16} />
          </button>
        </div>
      </section>

      <footer className="site-footer">
        <div className="wrap">
          <div className="row">
            <Brand />
            <p>Global payments, balances and cards in one account.</p>
          </div>
          <p className="legal">
            Paywai is a product prototype. Availability of payment rails, cards and country coverage
            depends on licensed partners, provider agreements and applicable regulation. Nothing on
            this page is an offer of financial services. © {new Date().getFullYear()} Paywai.
          </p>
        </div>
      </footer>
    </div>
  );
}