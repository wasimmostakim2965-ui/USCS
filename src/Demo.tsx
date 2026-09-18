import { useEffect, useMemo, useState } from 'react';
import './demo.css';
import Auth from './Auth';
import Dashboard from './Dashboard';

const steps = [
  ['01','Account','Email, password and account access'],
  ['02','Email verification','One-time verification code'],
  ['03','Personal details','Legal name and mobile number'],
  ['04','Identity','DOB, nationality, document and occupation'],
  ['05','Residence','Address, city, region, postal code and tax residence'],
  ['06','Security','Authenticator setup or skip'],
  ['07','Complete','Account-ready confirmation'],
] as const;

type TestView = 'dashboard' | 'admin' | 'registration';
const VISIBILITY_KEY = 'paywai_test_inf_visibility';

export function AdminPanel({ onHome }: { onHome: () => void }) {
  const [testOpen, setTestOpen] = useState(false);
  const [section, setSection] = useState<'overview' | 'settings'>('overview');
  const [view, setView] = useState<TestView>('dashboard');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');

  useEffect(() => {
    const saved = window.localStorage.getItem(VISIBILITY_KEY);
    if (saved === 'public') setVisibility('public');
  }, []);

  const selectTest = (next: TestView) => {
    if (visibility === 'private') return;
    setTestOpen(true);
    setView(next);
  };

  const setPublic = (next: 'public' | 'private') => {
    setVisibility(next);
    window.localStorage.setItem(VISIBILITY_KEY, next);
  };

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <button className="demo-brand" onClick={onHome}><span>P</span> PAYWAI</button>
        <div className="admin-account"><b>ADMIN</b><small>Control center</small></div>
        {['Overview','Users','Transactions','Compliance'].map(item => (
          <button key={item} className={section === 'overview' && item === 'Overview' ? 'active' : ''} onClick={() => { setSection('overview'); setTestOpen(false); }}>{item}</button>
        ))}
        <button className={section === 'settings' ? 'active' : ''} onClick={() => { setSection('settings'); setTestOpen(false); }}>Settings</button>
        <button className={'test-inf-menu ' + (testOpen ? 'expanded' : '')} onClick={() => setTestOpen(!testOpen)}>
          <span>TEST INF</span><b>{testOpen ? '−' : '+'}</b>
        </button>
        {testOpen && (
          <div className="test-inf-submenu">
            <button className={view === 'dashboard' ? 'active' : ''} onClick={() => selectTest('dashboard')}>Test Dashboard</button>
            <button className={view === 'admin' ? 'active' : ''} onClick={() => selectTest('admin')}>Test Admin</button>
            <button className={view === 'registration' ? 'active' : ''} onClick={() => selectTest('registration')}>Test Registration</button>
          </div>
        )}
        <button className="admin-exit" onClick={onHome}>← Back to website</button>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar">
          <div><span>ADMIN CONSOLE</span><b>Investor presentation workspace</b></div>
          <span className="admin-badge">DEMO · SYNTHETIC DATA</span>
        </header>

        {!testOpen && section === 'settings' ? (
          <AdminSettings visibility={visibility} setPublic={setPublic} />
        ) : !testOpen ? (
          <div className="admin-content">
            <div className="demo-eyebrow">CONTROL CENTER</div>
            <h1>Paywai <em>control center.</em></h1>
            <p className="demo-lead">Manage the demonstration environment and open the investor previews from TEST INF.</p>
            <div className="admin-grid">
              <section className="admin-card primary-admin">
                <small>INVESTOR DEMONSTRATION</small>
                <strong>TEST INF</strong>
                <p>Three presentation experiences are grouped here so an investor can see the customer dashboard, admin interface and complete registration journey without creating real data.</p>
                <button className="admin-open-test" onClick={() => setTestOpen(true)}>Open TEST INF</button>
              </section>
              <section className="admin-card">
                <small>LIVE SYSTEM</small>
                <strong>Production modules</strong>
                <div className="admin-list">
                  <span>Authentication <b>Connected</b></span>
                  <span>Customer dashboard <b>Available</b></span>
                  <span>Supabase data <b>Protected</b></span>
                  <span>Demo writes <b>Disabled</b></span>
                </div>
              </section>
            </div>

            <section className="admin-card roadmap">
              <small>REGISTRATION FLOW</small>
              <h2>Seven-step investor preview</h2>
              <div className="step-list">{steps.map(([n,t,d]) => <div key={n}><b>{n}</b><span><strong>{t}</strong><small>{d}</small></span></div>)}</div>
            </section>
          </div>
        ) : (
          <TestInfWorkspace visibility={visibility} view={view} onView={setView} />
        )}
      </main>
    </div>
  );
}

function AdminSettings({ visibility, setPublic }: { visibility: 'public' | 'private'; setPublic: (next: 'public' | 'private') => void }) {
  return <div className="admin-content">
    <div className="demo-eyebrow">ADMIN SETTINGS</div>
    <h1>Control <em>access.</em></h1>
    <p className="demo-lead">TEST INF visibility is controlled here so the investor presentation can be temporarily opened or closed.</p>
    <section className="admin-card visibility-card">
      <div><small>TEST INF VISIBILITY</small><h2>Investor access</h2><p>Public opens the three TEST INF previews. Private returns the 403 screen.</p></div>
      <div className="visibility-control">
        <button className={visibility === 'private' ? 'selected' : ''} onClick={() => setPublic('private')}>Private</button>
        <button className={visibility === 'public' ? 'selected' : ''} onClick={() => setPublic('public')}>Public</button>
        <strong>{visibility === 'public' ? '201 · PUBLIC' : '403 · PRIVATE'}</strong>
      </div>
    </section>
  </div>;
}

function TestInfWorkspace({ visibility, view, onView }: { visibility: 'public' | 'private'; view: TestView; onView: (v: TestView) => void }) {
  if (visibility === 'private') return <div className="forbidden"><div><strong>403</strong><h1>Test INF is private</h1><p>This investor preview is currently disabled. Change TEST INF visibility to Public in Admin Settings to present it.</p></div></div>;
  return (
    <div className="test-inf-workspace">
      <div className="test-inf-header">
        <div><div className="demo-eyebrow">TEST INF</div><h1>Investor <em>preview.</em></h1></div>
        <span>201 · PUBLIC</span>
      </div>
      <div className="test-inf-tabs">
        <button className={view === 'dashboard' ? 'selected' : ''} onClick={() => onView('dashboard')}>Test Dashboard</button>
        <button className={view === 'admin' ? 'selected' : ''} onClick={() => onView('admin')}>Test Admin</button>
        <button className={view === 'registration' ? 'selected' : ''} onClick={() => onView('registration')}>Test Registration</button>
      </div>
      {view === 'dashboard' && <TestDashboard />}
      {view === 'admin' && <TestAdmin />}
      {view === 'registration' && <TestRegistration />}
    </div>
  );
}

function TestAdmin() {
  return <section className="test-admin-preview">
    <div className="preview-admin-sidebar"><b>PAYWAI</b><small>ADMIN CONSOLE</small><span className="selected">Overview</span><span>Users</span><span>Transactions</span><span>Compliance</span><span>Settings</span><span className="selected">TEST INF</span><span className="indent">Test Dashboard</span><span className="indent">Test Admin</span><span className="indent">Test Registration</span></div>
    <div className="preview-admin-body"><div className="demo-eyebrow">TEST ADMIN</div><h2>Control center</h2><p>Investor preview of the Paywai administration experience. No production controls are executed from this screen.</p><div className="preview-stat-grid"><div><small>USERS</small><strong>TEST · 1,248</strong></div><div><small>TRANSACTIONS</small><strong>TEST · 8,420</strong></div><div><small>COMPLIANCE</small><strong>TEST · READY</strong></div></div><div className="preview-table"><b>Recent activity</b><span>TEST · Account created · Just now</span><span>TEST · Verification reviewed · Today</span><span>TEST · Payment processed · Today</span></div></div>
  </section>;
}

function TestRegistration() {
  return <section className="live-preview-card">
    <div className="live-preview-banner"><strong>LIVE REGISTRATION PREVIEW</strong><span>Same Auth component · DEMO MODE · no database writes</span></div>
    <Auth demoMode onBack={() => undefined} onSuccess={() => undefined} initialMode="signup" />
  </section>;
}
function TestDashboard() {
  return <section className="live-preview-card">
    <div className="live-preview-banner"><strong>LIVE DASHBOARD PREVIEW</strong><span>Same Dashboard component · DEMO MODE · synthetic data only</span></div>
    <Dashboard demoMode onBack={() => undefined} />
  </section>;
}
