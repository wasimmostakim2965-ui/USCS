import { useState } from 'react';
import { ArrowRight, Check, ChevronDown, Globe2, Lock, Menu, Send, ShieldCheck, Wallet, X } from 'lucide-react';

type Page = 'home' | 'dashboard';

const solutions = [
  ['Move money', 'Send and receive across supported bank, card and digital rails.'],
  ['Manage liquidity', 'Keep balances, currencies and funding context in one workspace.'],
  ['Protect assets', 'Separate protected allocations from everyday financial activity.'],
  ['Prove compliance', 'Show the policy evidence required without unnecessary disclosure.'],
];

function App() {
  const [page, setPage] = useState<Page>('home');
  const [menu, setMenu] = useState(false);
  const [solution, setSolution] = useState(0);

  if (page === 'dashboard') return <Dashboard onBack={() => setPage('home')} />;

  return <div className="site">
    <header className="header">
      <button className="logo" onClick={() => window.scrollTo({top:0,behavior:'smooth'})}><span>S</span>SOVEREIGN</button>
      <nav>
        <a href="#solutions">Solutions <ChevronDown size={13}/></a><a href="#platform">Platform</a><a href="#security">Security</a><a href="#resources">Resources</a>
      </nav>
      <div className="head-actions"><button onClick={() => setPage('dashboard')}>Sign in</button><button className="primary" onClick={() => setPage('dashboard')}>Get started <ArrowRight size={15}/></button></div>
      <button className="menu" onClick={() => setMenu(!menu)}>{menu ? <X/> : <Menu/>}</button>
    </header>
    {menu && <div className="mobile-nav"><a href="#solutions" onClick={()=>setMenu(false)}>Solutions</a><a href="#platform" onClick={()=>setMenu(false)}>Platform</a><a href="#security" onClick={()=>setMenu(false)}>Security</a><a href="#resources" onClick={()=>setMenu(false)}>Resources</a><button onClick={()=>setPage('dashboard')}>Get started</button></div>}

    <main>
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow">PRIVATE FINANCIAL INFRASTRUCTURE</div><h1>The financial platform built around <em>control.</em></h1><p>Move money, manage assets and prove what matters across supported financial rails — with privacy and policy built into the workflow.</p><div className="hero-actions"><button className="primary large" onClick={()=>setPage('dashboard')}>Open an account <ArrowRight size={17}/></button><a href="#solutions">Explore solutions <ArrowRight size={15}/></a></div><div className="checks"><span><Check size={14}/> Non-custodial</span><span><Check size={14}/> Policy-aware</span><span><Check size={14}/> Audit-ready</span></div></div>
        <div className="product"><div className="browser"><span>● ● ●</span><b>YOUR SOVEREIGN WORKSPACE</b><small>PRIVATE</small></div><div className="workspace"><aside><strong>S</strong><i/><i/><i/><i/></aside><div className="workspace-main"><div className="topline">OVERVIEW <span>TEST ENVIRONMENT</span></div><div className="balance"><small>AVAILABLE TO MOVE</small><strong>$ —</strong><p>Connect a supported rail to begin.</p><button onClick={()=>setPage('dashboard')}>Review workspace <ArrowRight size={13}/></button></div><div className="mini-grid"><div><b>01</b><strong>Move</strong><small>Review routes</small></div><div><b>02</b><strong>Prove</strong><small>Verify policy</small></div><div><b>03</b><strong>Record</strong><small>Audit trail</small></div></div><footer>● NO SETTLED FUNDS <span>NON-CUSTODIAL</span></footer></div></div></div>
      </section>

      <section className="band"><div><b>A clearer operating layer for modern financial movement.</b><span>Connect rails, policies and authorization without unnecessary complexity.</span></div><div>MOVE　 MANAGE　 PROTECT　 PROVE　 RECONCILE</div></section>

      <section id="solutions" className="section"><div className="section-head"><div><div className="eyebrow">PRODUCT SUITE</div><h2>Everything you need to <em>operate.</em></h2></div><p>One platform can hold the context around a financial action — from the first review to the final record.</p></div><div className="tabs">{solutions.map((s,i)=><button className={solution===i?'active':''} key={s[0]} onClick={()=>setSolution(i)}>{String(i+1).padStart(2,'0')} {s[0]} <ArrowRight size={14}/></button>)}</div><div className="feature"><div><div className="icon"><Wallet/></div><div className="eyebrow">0{solution+1} / {solutions[solution][0].toUpperCase()}</div><h3>{solutions[solution][0]}</h3><p>{solutions[solution][1]}</p><button className="text" onClick={()=>setPage('dashboard')}>Explore the workspace <ArrowRight size={14}/></button><ul><li><Check/> Clear authorization state</li><li><Check/> Counterparty context</li><li><Check/> Audit-ready activity</li></ul></div><div className="feature-visual"><div className="visual-card"><small>CONTROL CENTER</small><strong>{solutions[solution][0]}</strong><p>Review → Authorize → Settle → Record</p><div className="lines"/></div><div className="float"><b>READY FOR REVIEW</b><span><Check/> No fabricated financial state</span></div></div></div></section>

      <section id="platform" className="section platform"><div><div className="eyebrow">THE PLATFORM</div><h2>From intent to settlement, <em>one clear flow.</em></h2><p>Important state is visible before each sensitive action.</p><div className="steps"><div><b>01</b><span><strong>Review</strong> Route, destination, policy and limits.</span></div><div><b>02</b><span><strong>Authorize</strong> Explicit user-controlled approval.</span></div><div><b>03</b><span><strong>Settle</strong> Execute through a supported rail.</span></div><div><b>04</b><span><strong>Record</strong> Retain a clear activity trail.</span></div></div></div><div className="review"><div className="topline">PAYMENT REVIEW <span>READY</span></div><strong>$ — <small>USD</small></strong><div className="route"><div><small>FROM</small><b>Supported source</b></div><ArrowRight/><div><small>TO</small><b>Verified destination</b></div></div><div className="review-checks"><span><Check/> Identity policy</span><span><Check/> Sanctions policy</span><span><Check/> Authorization</span></div><button className="primary" onClick={()=>setPage('dashboard')}>Review before authorization <ArrowRight size={14}/></button></div></section>

      <section id="security" className="dark"><div><div className="eyebrow">TRUST & SECURITY</div><h2>Protection is part of the <em>architecture.</em></h2><p>No inflated security claims. Visible controls designed to reduce unnecessary trust and make sensitive state understandable.</p></div><div className="security-grid"><article><ShieldCheck/><b>Non-custodial</b><p>Signing authority stays separate from application infrastructure.</p></article><article><Lock/><b>Selective disclosure</b><p>Policy evidence can avoid exposing unnecessary identity data.</p></article><article><Globe2/><b>Policy-aware</b><p>Actions can be evaluated against explicit rules before authorization.</p></article><article><Check/><b>Audit-ready</b><p>Important financial and security events remain traceable.</p></article></div></section>

      <section id="resources" className="section resources"><div className="section-head"><div><div className="eyebrow">RESOURCES</div><h2>Understand the system <em>before you use it.</em></h2></div><p>Clear explainers for privacy-preserving financial workflows.</p></div><div className="resource-grid"><article><small>PRIVACY</small><h3>Selective disclosure</h3><p>Prove a required policy without making every identity detail part of the transaction.</p></article><article><small>PAYMENTS</small><h3>Controlled movement</h3><p>Understand what happens between review, authorization and settlement.</p></article><article><small>PLATFORM</small><h3>Developer infrastructure</h3><p>Connect APIs, policy evaluation and audit events around existing rails.</p></article></div></section>
      <section className="final"><div><div className="eyebrow">SOVEREIGN</div><h2>Build your financial operation <em>around control.</em></h2></div><button className="primary large" onClick={()=>setPage('dashboard')}>Get started <ArrowRight size={17}/></button></section>
    </main>
    <footer><button className="logo"><span>S</span>SOVEREIGN</button><p>Private financial infrastructure for controlled movement, verification and reconciliation.</p><small>Prototype environment · Synthetic data only · © 2026 Sovereign</small></footer>
  </div>;
}

function Dashboard({onBack}:{onBack:()=>void}) {
  const [tab,setTab]=useState('Overview');
  const tabs=['Overview','Money','Payments','Vault','Cards','Recipients','Activity','Compliance','Reports','Settings'];
  return <div className="dash"><aside><button className="logo"><span>S</span>SOVEREIGN</button><div className="workspace-user"><b>Wasim Treasury</b><small>Personal workspace</small></div>{tabs.map(t=><button className={tab===t?'selected':''} onClick={()=>setTab(t)} key={t}>{t}</button>)}<button className="signout" onClick={onBack}>← Back to website</button></aside><main><header><button className="mobile-dash" onClick={onBack}>←</button><span>Wasim Treasury / {tab}</span><span className="env">● TEST ENVIRONMENT</span></header><div className="dash-content"><div className="limit"><b>Identity review in progress</b><span>Outgoing transactions are limited to <strong>$100</strong> until verification is approved.</span></div><h1>{tab}</h1><p className="dash-sub">{tab==='Overview'?'Here is the financial position that matters right now.':`Manage your ${tab.toLowerCase()} workspace.`}</p>{tab==='Overview'?<><div className="quick"><button onClick={()=>setTab('Money')}><Wallet/><b>Add funds</b><small>Bank or wallet</small></button><button onClick={()=>setTab('Payments')}><Send/><b>Send</b><small>Move money</small></button><button onClick={()=>setTab('Payments')}><ArrowRight/><b>Receive</b><small>Get paid</small></button></div><div className="cards"><section className="treasury"><small>TOTAL TREASURY · USD · TEST</small><strong>$0.00</strong><p>No settled funds. Connect a supported funding rail to begin.</p><div className="empty">Treasury history will appear after the first settled transaction.</div><footer>Available to move <b>$0.00</b><span>Protected <b>$0.00</b></span></footer></section><section className="side"><div><small>AVAILABLE TO MOVE</small><strong>$0.00</strong><p>No funding rail connected</p></div><div><small>PROTECTED IN VAULT</small><strong>$0.00</strong><p>No protected allocation</p></div></section></div><div className="bottom"><section><h2>Recent activity</h2><p>No activity yet. Settled transactions and security events will appear here.</p></section><section><h2>Trust posture</h2><p>Identity credential — Pending review</p><p>Sanctions screening — Clear</p><p>Policy proof — Ready</p><p>Key custody — Non-custodial</p></section></div></>:<section className="module"><h2>{tab}</h2><p>This workspace is ready for real integrations. No fabricated balances, transactions or performance figures are shown.</p><div className="module-grid"><div><Wallet/><b>Ready</b><small>Connect a supported rail</small></div><div><ShieldCheck/><b>Policy-aware</b><small>Review controls before action</small></div><div><Globe2/><b>Global rails</b><small>Multiple currencies and routes</small></div></div></section>}</div></main></div>
}

export default App;
