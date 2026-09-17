import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Globe2, Lock, Menu, Send,
  ShieldCheck, Wallet, X, CreditCard, BarChart3, Users, Sparkles, Mail, Smartphone,
} from 'lucide-react';

type Page = 'home' | 'dashboard' | 'auth' | 'platform';
type Audience = 'business' | 'personal';

const products = [
  { icon: Send, title: 'Receive payments', text: 'Get paid by clients, customers and platforms with one global account built for momentum.', tag: 'GET PAID' },
  { icon: Users, title: 'Pay teams and suppliers', text: 'Send payments to the people you work with—quickly, clearly and with the right controls.', tag: 'SEND PAYMENTS' },
  { icon: Wallet, title: 'Manage cashflow', text: 'See balances, currencies and activity together, so every decision starts with context.', tag: 'STAY IN CONTROL' },
  { icon: CreditCard, title: 'Spend with confidence', text: 'Give your team the freedom to move and the guardrails your business needs to grow.', tag: 'SPEND SMARTER' },
];

const audiences = {
  business: { eyebrow: 'FOR BUSINESSES THAT THINK GLOBAL', title: 'Move money across borders. Grow without friction.', text: 'Sovereign brings payments, balances and controls together so your business can operate confidently wherever opportunity takes you.', button: 'Create your account' },
  personal: { eyebrow: 'FOR PEOPLE WITH BIGGER PLANS', title: 'Your money, ready for wherever life takes you.', text: 'Receive, send and manage money with a clearer view of every movement—from your first payment to your next big step.', button: 'Create your account' },
};

function App() {
  const [page, setPage] = useState<Page>('home');
  const [menu, setMenu] = useState(false);
  const [audience, setAudience] = useState<Audience>('business');
  const copy = audiences[audience];

  if (page === 'dashboard') return <Dashboard onBack={() => setPage('home')} />;
  if (page === 'auth') return <AuthFlow onBack={() => setPage('home')} onComplete={() => setPage('dashboard')} />;
  if (page === 'platform') return <PlatformPage onBack={() => setPage('home')} onStart={() => setPage('auth')} />;

  return <div className="site">
    <header className="header">
      <button className="logo" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><span>S</span>SOVEREIGN</button>
      <nav><a href="#products">Products <ChevronDown size={14} /></a><a href="#audiences">Who we serve</a><a href="#why">Why Sovereign</a><a href="#resources">Resources</a></nav>
      <div className="head-actions"><button onClick={() => setPage('dashboard')}>Sign in</button><button className="primary" onClick={() => setPage('dashboard')}>Get started <ArrowRight size={15} /></button></div>
      <button className="menu" aria-label="Open navigation" onClick={() => setMenu(!menu)}>{menu ? <X /> : <Menu />}</button>
    </header>
    {menu && <div className="mobile-nav"><a href="#products" onClick={() => setMenu(false)}>Products</a><a href="#audiences" onClick={() => setMenu(false)}>Who we serve</a><a href="#why" onClick={() => setMenu(false)}>Why Sovereign</a><a href="#resources" onClick={() => setMenu(false)}>Resources</a><button onClick={() => setPage('dashboard')}>Get started</button></div>}

    <main>
      <section className="hero-new">
        <div className="hero-new-copy">
          <div className="audience-switch"><button className={audience === 'business' ? 'active' : ''} onClick={() => setAudience('business')}>Business</button><button className={audience === 'personal' ? 'active' : ''} onClick={() => setAudience('personal')}>Personal</button></div>
          <div className="eyebrow">{copy.eyebrow}</div>
          <h1>{copy.title}</h1>
          <p>{copy.text}</p>
          <div className="hero-actions"><button className="primary large" onClick={() => setPage('auth')}>{copy.button} <ArrowRight size={17} /></button><button className="text" onClick={() => setPage('platform')}>Explore the platform <ArrowRight size={15} /></button></div>
          <div className="hero-proof"><span><Check size={14} /> Clear, upfront controls</span><span><Check size={14} /> Built for global movement</span></div>
        </div>
        <div className="hero-art" aria-label="Sovereign account preview">
          <div className="glow" />
          <div className="money-card primary-card"><div className="card-top"><span>SOVEREIGN</span><span>•••</span></div><div className="card-chip" /><strong>GLOBAL ACCOUNT</strong><small>CONTROL · CLARITY · MOVEMENT</small></div>
          <div className="account-card"><div className="account-head"><span>AVAILABLE BALANCE</span><b>USD · TEST</b></div><strong>$24,680.00</strong><div className="account-foot"><span><i className="dot green" /> Ready to move</span><span>•••</span></div></div>
          <div className="transfer-card"><div><span className="avatar">A</span><span><b>Atlas Studio</b><small>Payment received</small></span></div><strong>+$4,250</strong></div>
        </div>
      </section>

      <section className="logo-strip"><span>ONE ACCOUNT FOR YOUR GLOBAL FINANCES</span><div><b>GET PAID</b><b>SEND PAYMENTS</b><b>MANAGE CASHFLOW</b><b>SPEND WITH CONTROL</b><b>GROW GLOBALLY</b></div></section>

      <section id="products" className="section product-section"><div className="section-head"><div><div className="eyebrow">ONE PLATFORM. EVERY BUSINESS MOVE.</div><h2>Powerful tools to help you <em>go further.</em></h2></div><p>Everything you need to get paid, move money, manage your operation and build what comes next—all in one beautifully simple account.</p></div><div className="product-grid">{products.map(({ icon: Icon, title, text, tag }, index) => <article className="product-tile" key={title}><div className="tile-top"><span>0{index + 1}</span><div className="tile-icon"><Icon /></div></div><small>{tag}</small><h3>{title}</h3><p>{text}</p><a href="#why">Explore {title.toLowerCase()} <ArrowRight size={14} /></a></article>)}</div><div className="suite-note"><span><ShieldCheck size={18} /> Built with security and visibility at the core</span><a href="#why">Why businesses choose Sovereign <ArrowRight size={14} /></a></div></section>

      <section id="audiences" className="audience-section"><div className="audience-copy"><div className="eyebrow">BUILT AROUND YOUR AMBITION</div><h2>One platform.<br /><em>More possibilities.</em></h2><p>Whether you are building a global company or building a life across borders, your money should work with you—not slow you down.</p><button className="text" onClick={() => setPage('dashboard')}>See your workspace <ArrowRight size={15} /></button></div><div className="audience-grid"><article><span className="audience-number">01</span><Users /><h3>For growing teams</h3><p>Pay people, manage spend and keep financial operations visible as your business scales.</p><a href="#products">Explore business <ArrowRight size={14} /></a></article><article><span className="audience-number">02</span><Sparkles /><h3>For independent minds</h3><p>Get paid, organize your money and take your next opportunity with you.</p><a href="#products">Explore personal <ArrowRight size={14} /></a></article></div></section>

      <section id="why" className="trust-section"><div className="trust-intro"><div className="eyebrow">WHY SOVEREIGN</div><h2>More visibility.<br /><em>Less uncertainty.</em></h2><p>The best financial tools make the important things easy to see. Every Sovereign workflow is designed around clarity, control and confident action.</p></div><div className="trust-grid"><article><ShieldCheck /><b>Security in every step</b><p>Important actions are reviewed before they are authorized.</p></article><article><BarChart3 /><b>One view of your money</b><p>Understand balances, movement and activity without the noise.</p></article><article><Lock /><b>Privacy by design</b><p>Share the context required—not more than you need to.</p></article><article><Globe2 /><b>Ready for anywhere</b><p>Build workflows that match the way modern business moves.</p></article></div></section>

      <section id="resources" className="story-section"><div className="story-card"><div className="eyebrow">A CLEARER WAY TO OPERATE</div><h2>Make every movement<br /><em>count.</em></h2><p>Start with a workspace that puts your priorities first. Connect the rails you trust, set your controls and stay close to what matters.</p><button className="primary" onClick={() => setPage('platform')}>Explore Sovereign <ArrowRight size={15} /></button></div><div className="story-side"><div className="mini-stat"><strong>190+</strong><span>markets in motion</span></div><div className="mini-stat"><strong>24/7</strong><span>visibility and control</span></div><div className="mini-stat"><strong>01</strong><span>connected workspace</span></div></div></section>

      <section className="final"><div><div className="eyebrow">READY WHEN YOU ARE</div><h2>Start moving with <em>more confidence.</em></h2></div><button className="primary large" onClick={() => setPage('auth')}>Create your account <ArrowRight size={17} /></button></section>
    </main>
    <footer><button className="logo"><span>S</span>SOVEREIGN</button><p>Global financial infrastructure for clear, controlled movement.</p><small>Prototype environment · Synthetic data only · © 2026 Sovereign</small></footer>
  </div>;
}

function AuthFlow({ onBack, onComplete }: { onBack: () => void; onComplete: () => void }) {
  const [step, setStep] = useState(1);
  return <div className="flow-page"><div className="flow-top"><button className="logo" onClick={onBack}><span>S</span>SOVEREIGN</button><button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back to website</button></div><div className="flow-shell"><div className="flow-brand"><div className="eyebrow">CREATE YOUR ACCOUNT</div><h1>Move forward with <em>confidence.</em></h1><p>A few simple steps to set up your Sovereign workspace. You stay in control at every stage.</p><div className="flow-steps"><span className={step >= 1 ? 'done' : ''}>01 <b>Account</b></span><span className={step >= 2 ? 'done' : ''}>02 <b>Verify</b></span><span className={step >= 3 ? 'done' : ''}>03 <b>Workspace</b></span></div></div><div className="auth-card">{step === 1 && <><div className="auth-card-head"><h2>Create your account</h2><p>Start with your email. It only takes a minute.</p></div><button className="google-button" onClick={() => setStep(2)}><span className="google-mark">G</span> Continue with Google <ArrowRight size={15} /></button><div className="or"><span>or continue with email</span></div><label>Email address<input type="email" placeholder="you@company.com" /></label><button className="primary auth-submit" onClick={() => setStep(2)}>Continue <ArrowRight size={15} /></button><small className="auth-legal">By continuing, you agree to our Terms and Privacy Policy.</small></>}{step === 2 && <><div className="auth-card-head"><div className="step-icon"><Mail /></div><h2>Verify your email</h2><p>We sent a verification link to your inbox. Verify it to keep your account secure.</p></div><div className="verify-box"><CheckCircle2 /><b>Verification link sent</b><span>Check your inbox and follow the secure link.</span></div><button className="primary auth-submit" onClick={() => setStep(3)}>I’ve verified my email <ArrowRight size={15} /></button><button className="resend" onClick={() => setStep(3)}>Resend verification email</button></>}{step === 3 && <><div className="auth-card-head"><div className="step-icon"><Smartphone /></div><h2>Secure your workspace</h2><p>Set up two-step verification for stronger protection on sensitive actions.</p></div><div className="security-option"><ShieldCheck /><div><b>Two-step verification</b><span>Authenticator app or security key</span></div><CheckCircle2 className="selected-check" /></div><button className="primary auth-submit" onClick={onComplete}>Enter your workspace <ArrowRight size={15} /></button><small className="auth-legal">Security setup can be completed from your Settings.</small></>}</div></div></div>;
}

function PlatformPage({ onBack, onStart }: { onBack: () => void; onStart: () => void }) {
  return <div className="platform-page"><header className="flow-top"><button className="logo" onClick={onBack}><span>S</span>SOVEREIGN</button><button className="back-link" onClick={onBack}><ArrowLeft size={14} /> Back to website</button></header><main><section className="platform-hero"><div className="eyebrow">THE SOVEREIGN PLATFORM</div><h1>One clear view of <em>every move.</em></h1><p>Payments, cashflow and control—designed together for the way modern businesses and people operate globally.</p><button className="primary large" onClick={onStart}>Create your account <ArrowRight size={16} /></button></section><section className="platform-flow"><div className="flow-intro"><div className="eyebrow">HOW IT WORKS</div><h2>From first payment<br /><em>to next opportunity.</em></h2></div><div className="platform-steps"><article><b>01</b><Globe2 /><h3>Connect globally</h3><p>Bring your trusted payment rails and financial context into one account.</p></article><article><b>02</b><ShieldCheck /><h3>Stay in control</h3><p>Set permissions, review important actions and keep your operation clear.</p></article><article><b>03</b><BarChart3 /><h3>Move forward</h3><p>Understand performance and make the next decision with confidence.</p></article></div></section><section className="platform-banner"><div><div className="eyebrow">BUILT FOR WHAT’S NEXT</div><h2>Financial infrastructure<br /><em>without the friction.</em></h2></div><button className="primary" onClick={onStart}>Get started <ArrowRight size={15} /></button></section></main></div>;
}

function Dashboard({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState('Overview');
  const tabs = ['Overview', 'Money', 'Payments', 'Vault', 'Cards', 'Recipients', 'Activity', 'Compliance', 'Reports', 'Settings'];
  return <div className="dash"><aside><button className="logo"><span>S</span>SOVEREIGN</button><div className="workspace-user"><b>Wasim Treasury</b><small>Personal workspace</small></div>{tabs.map(t => <button className={tab === t ? 'selected' : ''} onClick={() => setTab(t)} key={t}>{t}</button>)}<button className="signout" onClick={onBack}>← Back to website</button></aside><main><header><button className="mobile-dash" onClick={onBack}>←</button><span>Wasim Treasury / {tab}</span><span className="env">● PREVIEW WORKSPACE</span></header><div className="dash-content"><div className="limit"><b>Identity review in progress</b><span>Outgoing transactions are limited to <strong>$100</strong> until verification is approved.</span></div><h1>{tab}</h1><p className="dash-sub">{tab === 'Overview' ? 'Here is the financial position that matters right now.' : `Manage your ${tab.toLowerCase()} workspace.`}</p>{tab === 'Overview' ? <><div className="quick"><button onClick={() => setTab('Money')}><Wallet /><b>Add funds</b><small>Bank or wallet</small></button><button onClick={() => setTab('Payments')}><Send /><b>Send</b><small>Move money</small></button><button onClick={() => setTab('Payments')}><ArrowRight /><b>Receive</b><small>Get paid</small></button></div><div className="cards"><section className="treasury"><small>TOTAL TREASURY · USD · TEST</small><strong>$0.00</strong><p>No settled funds. Connect a supported funding rail to begin.</p><div className="empty">Treasury history will appear after the first settled transaction.</div><footer>Available to move <b>$0.00</b><span>Protected <b>$0.00</b></span></footer></section><section className="side"><div><small>AVAILABLE TO MOVE</small><strong>$0.00</strong><p>No funding rail connected</p></div><div><small>PROTECTED IN VAULT</small><strong>$0.00</strong><p>No protected allocation</p></div></section></div><div className="bottom"><section><h2>Recent activity</h2><p>No activity yet. Settled transactions and security events will appear here.</p></section><section><h2>Trust posture</h2><p>Identity credential — Pending review</p><p>Sanctions screening — Clear</p><p>Policy proof — Ready</p><p>Key custody — Non-custodial</p></section></div></> : <section className="module"><h2>{tab}</h2><p>This workspace is ready for real integrations. No fabricated balances, transactions or performance figures are shown.</p><div className="module-grid"><div><Wallet /><b>Ready</b><small>Connect a supported rail</small></div><div><ShieldCheck /><b>Policy-aware</b><small>Review controls before action</small></div><div><Globe2 /><b>Global rails</b><small>Multiple currencies and routes</small></div></div></section>}</div></main></div>
}

export default App;
