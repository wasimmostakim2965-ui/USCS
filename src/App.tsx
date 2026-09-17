import { useState } from 'react';
import {
  ArrowRight, Check, ChevronDown, Globe2, Lock, Menu, Send,
  ShieldCheck, Wallet, X, CreditCard, BarChart3, Users, Sparkles,
} from 'lucide-react';

type Page = 'home' | 'dashboard';
type Audience = 'business' | 'personal';

const products = [
  { icon: Send, title: 'Receive payments', text: 'Get paid from clients, customers and platforms with one simple global account.' },
  { icon: Globe2, title: 'Send money worldwide', text: 'Move funds to partners, teams and suppliers with clear rates and full visibility.' },
  { icon: Wallet, title: 'Hold and manage funds', text: 'See your balances, currencies and cashflow in one calm, connected workspace.' },
  { icon: CreditCard, title: 'Spend with confidence', text: 'Create controlled cards and spending workflows for the people who move your business forward.' },
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
          <div className="hero-actions"><button className="primary large" onClick={() => setPage('dashboard')}>{copy.button} <ArrowRight size={17} /></button><a href="#products">Explore the platform <ArrowRight size={15} /></a></div>
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

      <section id="products" className="section product-section"><div className="section-head"><div><div className="eyebrow">A PLATFORM THAT DOES MORE</div><h2>Everything you need to <em>move forward.</em></h2></div><p>From the first payment to the next market, Sovereign gives you the tools and context to make every financial movement feel simple.</p></div><div className="product-grid">{products.map(({ icon: Icon, title, text }) => <article className="product-tile" key={title}><div className="tile-icon"><Icon /></div><h3>{title}</h3><p>{text}</p><a href="#why">Learn more <ArrowRight size={14} /></a></article>)}</div></section>

      <section id="audiences" className="audience-section"><div className="audience-copy"><div className="eyebrow">BUILT AROUND YOUR AMBITION</div><h2>One platform.<br /><em>More possibilities.</em></h2><p>Whether you are building a global company or building a life across borders, your money should work with you—not slow you down.</p><button className="text" onClick={() => setPage('dashboard')}>See your workspace <ArrowRight size={15} /></button></div><div className="audience-grid"><article><span className="audience-number">01</span><Users /><h3>For growing teams</h3><p>Pay people, manage spend and keep financial operations visible as your business scales.</p><a href="#products">Explore business <ArrowRight size={14} /></a></article><article><span className="audience-number">02</span><Sparkles /><h3>For independent minds</h3><p>Get paid, organize your money and take your next opportunity with you.</p><a href="#products">Explore personal <ArrowRight size={14} /></a></article></div></section>

      <section id="why" className="trust-section"><div className="trust-intro"><div className="eyebrow">WHY SOVEREIGN</div><h2>More visibility.<br /><em>Less uncertainty.</em></h2><p>The best financial tools make the important things easy to see. Every Sovereign workflow is designed around clarity, control and confident action.</p></div><div className="trust-grid"><article><ShieldCheck /><b>Security in every step</b><p>Important actions are reviewed before they are authorized.</p></article><article><BarChart3 /><b>One view of your money</b><p>Understand balances, movement and activity without the noise.</p></article><article><Lock /><b>Privacy by design</b><p>Share the context required—not more than you need to.</p></article><article><Globe2 /><b>Ready for anywhere</b><p>Build workflows that match the way modern business moves.</p></article></div></section>

      <section id="resources" className="story-section"><div className="story-card"><div className="eyebrow">A CLEARER WAY TO OPERATE</div><h2>Make every movement<br /><em>count.</em></h2><p>Start with a workspace that puts your priorities first. Connect the rails you trust, set your controls and stay close to what matters.</p><button className="primary" onClick={() => setPage('dashboard')}>Explore Sovereign <ArrowRight size={15} /></button></div><div className="story-side"><div className="mini-stat"><strong>190+</strong><span>markets in motion</span></div><div className="mini-stat"><strong>24/7</strong><span>visibility and control</span></div><div className="mini-stat"><strong>01</strong><span>connected workspace</span></div></div></section>

      <section className="final"><div><div className="eyebrow">READY WHEN YOU ARE</div><h2>Start moving with <em>more confidence.</em></h2></div><button className="primary large" onClick={() => setPage('dashboard')}>Get started <ArrowRight size={17} /></button></section>
    </main>
    <footer><button className="logo"><span>S</span>SOVEREIGN</button><p>Global financial infrastructure for clear, controlled movement.</p><small>Prototype environment · Synthetic data only · © 2026 Sovereign</small></footer>
  </div>;
}

function Dashboard({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState('Overview');
  const tabs = ['Overview', 'Money', 'Payments', 'Vault', 'Cards', 'Recipients', 'Activity', 'Compliance', 'Reports', 'Settings'];
  return <div className="dash"><aside><button className="logo"><span>S</span>SOVEREIGN</button><div className="workspace-user"><b>Wasim Treasury</b><small>Personal workspace</small></div>{tabs.map(t => <button className={tab === t ? 'selected' : ''} onClick={() => setTab(t)} key={t}>{t}</button>)}<button className="signout" onClick={onBack}>← Back to website</button></aside><main><header><button className="mobile-dash" onClick={onBack}>←</button><span>Wasim Treasury / {tab}</span><span className="env">● TEST ENVIRONMENT</span></header><div className="dash-content"><div className="limit"><b>Identity review in progress</b><span>Outgoing transactions are limited to <strong>$100</strong> until verification is approved.</span></div><h1>{tab}</h1><p className="dash-sub">{tab === 'Overview' ? 'Here is the financial position that matters right now.' : `Manage your ${tab.toLowerCase()} workspace.`}</p>{tab === 'Overview' ? <><div className="quick"><button onClick={() => setTab('Money')}><Wallet /><b>Add funds</b><small>Bank or wallet</small></button><button onClick={() => setTab('Payments')}><Send /><b>Send</b><small>Move money</small></button><button onClick={() => setTab('Payments')}><ArrowRight /><b>Receive</b><small>Get paid</small></button></div><div className="cards"><section className="treasury"><small>TOTAL TREASURY · USD · TEST</small><strong>$0.00</strong><p>No settled funds. Connect a supported funding rail to begin.</p><div className="empty">Treasury history will appear after the first settled transaction.</div><footer>Available to move <b>$0.00</b><span>Protected <b>$0.00</b></span></footer></section><section className="side"><div><small>AVAILABLE TO MOVE</small><strong>$0.00</strong><p>No funding rail connected</p></div><div><small>PROTECTED IN VAULT</small><strong>$0.00</strong><p>No protected allocation</p></div></section></div><div className="bottom"><section><h2>Recent activity</h2><p>No activity yet. Settled transactions and security events will appear here.</p></section><section><h2>Trust posture</h2><p>Identity credential — Pending review</p><p>Sanctions screening — Clear</p><p>Policy proof — Ready</p><p>Key custody — Non-custodial</p></section></div></> : <section className="module"><h2>{tab}</h2><p>This workspace is ready for real integrations. No fabricated balances, transactions or performance figures are shown.</p><div className="module-grid"><div><Wallet /><b>Ready</b><small>Connect a supported rail</small></div><div><ShieldCheck /><b>Policy-aware</b><small>Review controls before action</small></div><div><Globe2 /><b>Global rails</b><small>Multiple currencies and routes</small></div></div></section>}</div></main></div>
}

export default App;
