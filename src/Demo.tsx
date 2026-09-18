import { useState } from 'react';
import './demo.css';

const steps = [
  ['01','Account','Google or email, password'],
  ['02','Email','One-time verification code'],
  ['03','Personal details','Legal name and mobile number'],
  ['04','Identity','DOB, nationality, document and occupation'],
  ['05','Residence','Address, city, region, postal code and tax residence'],
  ['06','Security','Authenticator setup or skip'],
  ['07','Complete','Account-ready confirmation'],
];

export function AdminPanel({ onHome }: { onHome:()=>void }) {
  return <div className="demo-admin">
    <header><button className="demo-brand" onClick={onHome}><span>P</span> PAYWAI</button><span className="admin-badge">ADMIN CONSOLE · DEMO</span></header>
    <main>
      <div className="demo-eyebrow">INVESTOR DEMONSTRATION</div>
      <h1>Paywai <em>control center.</em></h1>
      <p className="demo-lead">A presentation-only control surface for showing the product experience without touching production customer data.</p>
      <div className="admin-grid">
        <section className="admin-card primary-admin"><small>DEMO ENVIRONMENT</small><strong>Investor preview</strong><p>Use the two safe presentation links below. They do not create users, write to Supabase, or affect balances.</p><div className="admin-actions"><a href="/test-registration">Open test registration</a><a href="/test-dashboard">Open test dashboard</a></div></section>
        <section className="admin-card"><small>LIVE SYSTEM</small><strong>Production modules</strong><div className="admin-list"><span>Authentication <b>Connected</b></span><span>Customer dashboard <b>Available</b></span><span>Supabase data <b>Protected</b></span><span>Demo data writes <b>Disabled</b></span></div></section>
      </div>
      <section className="admin-card roadmap"><small>REGISTRATION FLOW</small><h2>What an investor can see</h2><div className="step-list">{steps.map(([n,t,d])=><div key={n}><b>{n}</b><span><strong>{t}</strong><small>{d}</small></span></div>)}</div></section>
    </main>
  </div>;
}

export function TestRegistration({ onHome }: { onHome:()=>void }) {
  const [step,setStep]=useState(0);
  const current=steps[step];
  return <div className="demo-page"><header><button className="demo-brand" onClick={onHome}><span>P</span> PAYWAI</button><span className="demo-badge">TEST MODE · NO DATA SAVED</span></header><main className="test-flow">
    <div className="test-kicker">INVESTOR TEST REGISTRATION · {current[0]} / 07</div>
    <h1>{current[1]}</h1><p className="demo-lead">This is a presentation-only copy of the Paywai registration experience. Every value below is synthetic test data.</p>
    <div className="test-progress"><i style={{width:((step+1)/7)*100+'%'}}/></div>
    <section className="test-panel">
      <h2>{current[1]}</h2><p>{current[2]}</p>
      {step===0&&<><TestField label="Email address"/><TestField label="Password"/><TestField label="Confirm password"/></>}
      {step===1&&<><TestField label="Verification code"/><div className="test-note">TEST · Verification code accepted automatically.</div></>}
      {step===2&&<><TestField label="Full legal name"/><TestField label="Mobile number"/></>}
      {step===3&&<><TestField label="Legal full name"/><div className="test-two"><TestField label="Date of birth"/><TestField label="Nationality"/></div><div className="test-two"><TestField label="Document type"/><TestField label="Document country"/></div><TestField label="Document number"/><TestField label="Occupation"/></>}
      {step===4&&<><TestField label="Street address"/><div className="test-two"><TestField label="City"/><TestField label="State or region"/></div><div className="test-two"><TestField label="Postal code"/><TestField label="Tax residence"/></div></>}
      {step===5&&<><div className="test-security"><b>Authenticator app</b><span>TEST · QR setup and 6-digit verification preview.</span></div><TestField label="Authenticator code"/><div className="test-note">TEST · You may continue without enabling security.</div></>}
      {step===6&&<div className="complete-box"><strong>TEST · Account created</strong><p>The investor preview has reached the same completion state as the real onboarding flow. Nothing was saved.</p></div>}
      <div className="test-actions">{step>0&&<button className="test-secondary" onClick={()=>setStep(step-1)}>Back</button>}<button className="test-primary" onClick={()=>step===6?onHome():setStep(step+1)}>{step===6?'Return to website':'Continue'} {step<6&&'→'}</button></div>
    </section>
  </main></div>;
}

function TestField({label}:{label:string}){return <label className="test-field">{label}<input value="TEST" readOnly/></label>}

export function TestDashboard({ onHome }: { onHome:()=>void }) {
  const tabs=['Overview','Money','Payments','Cards','Recipients','Activity','Compliance','Settings'];
  const [tab,setTab]=useState('Overview');
  return <div className="test-dash"><aside><button className="demo-brand" onClick={onHome}><span>P</span> PAYWAI</button><div className="test-user"><b>TEST USER</b><small>Personal account</small></div>{tabs.map(t=><button className={tab===t?'active':''} key={t} onClick={()=>setTab(t)}>{t}</button>)}<button className="test-signout" onClick={onHome}>← Exit test</button></aside><main><header><span>TEST USER / {tab}</span><b>● TEST ENVIRONMENT</b></header><div className="test-dash-content"><div className="demo-eyebrow">INVESTOR TEST DASHBOARD</div><h1>{tab}</h1><p className="demo-lead">Presentation-only dashboard. All balances, activity and statuses are synthetic.</p>{tab==='Overview'?<><div className="test-quick"><div>WALLET<strong>Add funds</strong><small>TEST · Bank or wallet</small></div><div>SEND<strong>Send payment</strong><small>TEST · Move money</small></div><div>RECEIVE<strong>Get paid</strong><small>TEST · Incoming</small></div></div><div className="test-balance"><small>TOTAL AVAILABLE BALANCE</small><strong>$24,680.00</strong><span>USD · TEST BALANCE</span><div className="balance-foot"><b>Available · $24,680.00</b><b>Pending · $0.00</b></div></div><div className="test-bottom"><section><h2>Recent activity</h2><p>TEST · Payment received · +$4,250.00</p><p>TEST · Supplier payment · -$980.00</p></section><section><h2>Verification status</h2><p>Identity — TEST · Submitted</p><p>Email confirmed — TEST · Yes</p><p>Country — TEST</p></section></div></>:<section className="test-module"><h2>{tab}</h2><p>TEST · This module is available in the investor preview.</p><div className="module-cells"><span>TEST · Ready</span><span>TEST · Protected</span><span>TEST · Global</span></div></section>}</div></main></div>;
}
