import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import Landing from './pages/Landing';
import Auth from './pages/Auth';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import { supabase, supabaseConfigured } from './lib/supabase';
import { loadProfile, type Profile } from './lib/account';

type Screen = 'landing' | 'auth' | 'onboarding' | 'dashboard';

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signup');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(!supabaseConfigured);

  useEffect(() => {
    if (!supabaseConfigured) return;
    let alive = true;

    const syncProfile = async (active: Session | null) => {
      if (!active) {
        if (alive) {
          setProfile(null);
          setSession(null);
          setScreen('landing');
        }
        return;
      }
      try {
        const p = await loadProfile(active.user.id);
        if (!alive) return;
        setSession(active);
        setProfile(p);
        setScreen(p?.onboarding_status === 'started' ? 'onboarding' : 'dashboard');
      } catch {
        if (!alive) return;
        setSession(active);
        setScreen('dashboard');
      }
    };

    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      void syncProfile(data.session).finally(() => {
        if (alive) setReady(true);
      });
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      void syncProfile(next);
    });

    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const refreshProfile = async () => {
    if (!session) return;
    const p = await loadProfile(session.user.id);
    setProfile(p);
    if (p?.onboarding_status && p.onboarding_status !== 'started') setScreen('dashboard');
  };

  if (!ready) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <p style={{ color: 'var(--ink-500)' }}>Loading Paywai…</p>
      </div>
    );
  }

  if (screen === 'auth') {
    return (
      <Auth
        initialMode={authMode}
        onBack={() => setScreen('landing')}
        onSignedIn={refreshProfile}
      />
    );
  }

  if (session && screen === 'onboarding') {
    return (
      <Onboarding
        userId={session.user.id}
        onBack={() => setScreen('landing')}
        onDone={refreshProfile}
      />
    );
  }

  if (session && screen === 'dashboard') {
    return (
      <Dashboard
        userId={session.user.id}
        onExit={() => {
          setSession(null);
          setProfile(null);
          setScreen('landing');
        }}
        onCompleteProfile={() => setScreen('onboarding')}
      />
    );
  }

  if (session && profile?.onboarding_status === 'started') {
    return (
      <Onboarding
        userId={session.user.id}
        onBack={() => setScreen('landing')}
        onDone={refreshProfile}
      />
    );
  }

  return (
    <Landing
      onSignIn={() => {
        setAuthMode('signin');
        setScreen('auth');
      }}
      onGetStarted={() => {
        setAuthMode('signup');
        setScreen(session ? 'dashboard' : 'auth');
      }}
      onPlatform={() => {
        setAuthMode('signup');
        setScreen('auth');
      }}
    />
  );
}