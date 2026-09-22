import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";
import AuthDialog from "@/components/AuthDialog";
import { ArrowUpRight, ChevronRight, GitBranch, Globe2, LockKeyhole, ShieldCheck } from "lucide-react";

function LandingPage() {
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const openAuth = (mode: "signin" | "signup") => {
    setAuthMode(mode);
    setAuthOpen(true);
  };
  return <div className="landing-page">
    <header className="landing-nav">
      <a className="landing-brand" href="#top" aria-label="Cloud Wai home"><span className="brand-mark"><span /></span><span><strong>Cloud Wai</strong><small>Unified cloud platform</small></span></a>
      <nav className="landing-links" aria-label="Main navigation"><a href="#platform">Platform</a><a href="#security">Security</a><a href="#developers">Developers</a><a href="#pricing">Pricing</a></nav>
      <div className="landing-actions"><button className="landing-signin" onClick={() => openAuth("signin")}>Sign in</button><button className="landing-cta" onClick={() => openAuth("signup")}>Get started <ArrowUpRight size={15} /></button></div>
    </header>
    <main id="top">
      <section className="landing-hero">
        <div className="hero-copy"><div className="hero-kicker"><span className="live-dot" />The operating system for modern applications</div><h1>Build the web.<br /><em>Without the glue.</em></h1><p>Domains, deployments, databases, storage, and security in one calm, beautifully simple workspace.</p><div className="hero-actions"><button className="landing-cta landing-cta-large" onClick={() => openAuth("signup")}>Create your workspace <ArrowUpRight size={17} /></button><button className="hero-text-button" onClick={() => document.getElementById("platform")?.scrollIntoView({ behavior: "smooth" })}>Explore the platform <ChevronRight size={16} /></button></div><div className="hero-note"><LockKeyhole size={14} /> Secure by default. No fake metrics. No hidden infrastructure surprises.</div></div>
        <div className="hero-visual" aria-label="Cloud Wai platform preview"><div className="hero-glow" /><div className="mini-window"><div className="mini-window-bar"><span className="mini-dots"><i /><i /><i /></span><span>app.uscs.io / overview</span><span className="mini-live">PREVIEW</span></div><div className="mini-window-body"><div className="mini-sidebar"><strong>Cloud Wai</strong><span className="mini-active">Overview</span><span>Projects</span><span>Domains</span><span>Security</span><span>Settings</span></div><div className="mini-content"><small>CONTROL PLANE / OVERVIEW</small><h3>Ship with confidence.</h3><div className="mini-cards"><div><small>Production</small><strong>Not connected</strong><span className="mini-line" /></div><div><small>Security</small><strong>Configuration</strong><span className="mini-line short" /></div></div><div className="mini-table"><span /><span /><span /><span /></div></div></div></div></div>
      </section>
      <section className="trusted-row"><span>Everything your product needs to run</span><div><b>DOMAINS</b><b>DEPLOYMENTS</b><b>DATA</b><b>SECURITY</b><b>OBSERVABILITY</b></div></section>
      <section className="landing-section" id="platform"><div className="section-intro"><div className="landing-eyebrow">One surface</div><h2>From first commit<br />to production.</h2><p>Cloud Wai turns the scattered work of running an application into one clear path. Simple enough for a solo builder, powerful enough for a serious team.</p></div><div className="feature-grid"><article className="feature-card feature-wide"><span className="feature-index">01 / BUILD</span><h3>Deploy without the dance.</h3><p>Connect GitHub, choose a branch, and let Cloud Wai detect your framework, run checks, and ship a real deployment.</p><div className="feature-foot"><GitBranch size={16} /> Preview environments · Rollbacks · Logs</div></article><article className="feature-card"><span className="feature-index">02 / OWN</span><h3>Your domain, finally in context.</h3><p>Search, connect DNS, and secure a domain next to the project it belongs to.</p><div className="feature-foot"><Globe2 size={16} /> Registrar-ready architecture</div></article><article className="feature-card"><span className="feature-index">03 / PROTECT</span><h3>Security is the starting line.</h3><p>Private data, scoped access, audit trails, and production checks are designed into the workflow.</p><div className="feature-foot"><ShieldCheck size={16} /> Evidence over empty scores</div></article></div></section>
      <section className="security-section" id="security"><div className="security-copy"><div className="landing-eyebrow">Security, not theatre</div><h2>Nothing is called<br /><em>protected</em> without proof.</h2><p>Cloud Wai makes the honest state visible. If a provider is not connected, you see “Configuration required”—not a made-up green check.</p><button className="hero-text-button" onClick={() => openAuth("signin")}>See the control plane <ArrowUpRight size={16} /></button></div><div className="security-list"><div><span>01</span><strong>Private by default</strong><small>Databases, buckets, and secrets start behind an explicit access boundary.</small></div><div><span>02</span><strong>Every action has a trail</strong><small>Deployments, DNS changes, access changes, and security events are auditable.</small></div><div><span>03</span><strong>Providers stay replaceable</strong><small>Your business logic is not locked to one registrar or deployment vendor.</small></div></div></section>
      <section className="final-cta" id="developers"><div><div className="landing-eyebrow">The quiet advantage</div><h2>Less infrastructure<br /><em>in your head.</em></h2><p>Start with a workspace. Add providers when you are ready.</p></div><button className="landing-cta landing-cta-large" onClick={() => openAuth("signup")}>Create your workspace <ArrowUpRight size={17} /></button></section>
    </main>
    <footer className="landing-footer"><span>© 2026 Cloud Wai</span><span>Built for people who ship.</span><span><a href="#security">Security</a><a href="#pricing">Pricing</a><button onClick={() => openAuth("signin")}>Sign in</button></span></footer>
    <AuthDialog open={authOpen} initialMode={authMode} onClose={() => setAuthOpen(false)} />
  </div>;
}

export function AuthCallback() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const completeOAuth = async () => {
      if (!supabase) {
        if (active) setError("Authentication is not configured for this deployment.");
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      const oauthError = params.get("error_description") || params.get("error");
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

      try {
        if (oauthError) throw new Error(oauthError);
        let exchangedSession: Session | null = null;
        if (code) {
          const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) throw exchangeError;
          exchangedSession = data.session;
        } else if (hashParams.get("access_token") && hashParams.get("refresh_token")) {
          const { data, error: hashError } = await supabase.auth.setSession({
            access_token: hashParams.get("access_token")!,
            refresh_token: hashParams.get("refresh_token")!,
          });
          if (hashError) throw hashError;
          exchangedSession = data.session;
        }

        const { data: { session: storedSession }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        const session = exchangedSession ?? storedSession;

        if (!session?.user) {
          throw new Error("No authenticated session was returned by Supabase.");
        }

        // Force a fresh app bootstrap after persistence. A client-side route
        // transition can mount Home before Supabase's storage event is visible
        // on mobile Chrome, briefly rendering the public landing page.
        if (active) window.location.replace("/dashboard");
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Unable to complete sign-in.");
        }
      }
    };

    void completeOAuth();
    return () => {
      active = false;
    };
  }, [setLocation]);

  if (error) {
    return (
      <div className="auth-loading" style={{ flexDirection: "column", gap: 12 }}>
        <strong>Sign-in could not be completed</strong>
        <span>{error}</span>
        <button className="button button-primary" onClick={() => setLocation("/")}>Back to sign in</button>
      </div>
    );
  }

  return <div className="auth-loading" aria-label="Completing sign-in" />;
}


export default function Home() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.pathname === "/" && supabase) {
      void supabase.auth.getSession().then(({ data: { session } }) => {
        if (session?.user) setLocation("/dashboard");
      });
    }
  }, [setLocation]);
  return <LandingPage />;
}
