import { useEffect, useMemo, useState } from 'react';
import './account-opening.css';
import { supabase, supabaseConfigured } from './lib/supabase';
import {
  ensureLedgerAccount,
  loadKyc,
  loadProfile,
  recordAudit,
  saveKyc,
  saveProfile,
} from './lib/account';
import { passwordIssues } from './lib/security';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  FileCheck2,
  Lock,
  Mail,
  MapPin,
  Shield,
  UserRound,
} from 'lucide-react';

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type AccountType = 'personal' | 'business';

const COUNTRIES = [
  'Bangladesh',
  'United States',
  'United Kingdom',
  'United Arab Emirates',
  'Canada',
  'Australia',
  'Germany',
  'India',
  'Singapore',
  'Other',
];

const STEP_TITLES: Record<Step, string> = {
  1: 'How will you use Paywai?',
  2: 'Create your login',
  3: 'Confirm your email',
  4: 'Tell us about you',
  5: 'Verify your identity',
  6: 'Where do you live?',
  7: 'Review and submit',
};

export default function Auth({
  onBack,
  onSuccess,
  initialMode = 'signup',
}: {
  onBack: () => void;
  onSuccess: () => void;
  initialMode?: 'signup' | 'signin';
}) {
  const [mode, setMode] = useState<'signup' | 'signin'>(initialMode);
  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [accountType, setAccountType] = useState<AccountType>('personal');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [country, setCountry] = useState('Bangladesh');

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [businessType, setBusinessType] = useState('Sole proprietorship');
  const [businessCategory, setBusinessCategory] = useState('Software and IT services');

  const [legalName, setLegalName] = useState('');
  const [dob, setDob] = useState('');
  const [nationality, setNationality] = useState('Bangladesh');
  const [occupation, setOccupation] = useState('');
  const [documentType, setDocumentType] = useState('National ID');
  const [documentNumber, setDocumentNumber] = useState('');
  const [documentCountry, setDocumentCountry] = useState('Bangladesh');

  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postal, setPostal] = useState('');
  const [taxResidence, setTaxResidence] = useState('Bangladesh');

  const [userId, setUserId] = useState<string | null>(null);

  const passwordProblems = useMemo(() => passwordIssues(password), [password]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session?.user) return;
      setUserId(session.user.id);
      setEmail(session.user.email ?? '');
      const existing = await loadProfile(session.user.id).catch(() => null);
      if (existing) {
        setAccountType(existing.account_type);
        setFullName(existing.full_name ?? '');
        setPhone(existing.phone ?? '');
        setCountry(existing.country ?? 'Bangladesh');
        setBusinessName(existing.business_name ?? '');
        setBusinessType(existing.business_type ?? 'Sole proprietorship');
        setBusinessCategory(existing.business_category ?? 'Software and IT services');
      }
      if (initialMode === 'signin' && (existing?.onboarding_status === 'submitted' || existing?.onboarding_status === 'verified')) {
        onSuccess();
        return;
      }
      const kyc = await loadKyc(session.user.id).catch(() => null);
      const resume: Step = !existing?.full_name
        ? 4
        : !kyc?.legal_name
          ? 5
          : !kyc?.address_line1
            ? 6
            : 7;
      setStep((current) => (current <= 3 ? resume : current));
    })();

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        setUserId(session.user.id);
        setEmail(session.user.email ?? '');
        setStep((current) => (mode === 'signup' && current <= 3 ? 4 : current));
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const go = (next: Step) => {
    setError('');
    setNotice('');
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const createAccount = async () => {
    if (!supabaseConfigured) {
      setError('Account creation is not configured on this deployment yet. Please contact support.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email address.');
      return;
    }
    if (passwordProblems.length) {
      setError(`Your password needs ${passwordProblems.join(', ')}.`);
      return;
    }
    if (password !== password2) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { country, account_type: accountType },
        emailRedirectTo: window.location.origin,
      },
    });
    setBusy(false);
    if (signUpError) {
      setError(
        signUpError.message.toLowerCase().includes('already')
          ? 'An account already exists for this email. Sign in instead.'
          : signUpError.message,
      );
      return;
    }
    if (data.user && !data.session) {
      go(3);
      return;
    }
    if (data.user) {
      setUserId(data.user.id);
      go(4);
    }
  };

  const resendConfirmation = async () => {
    setBusy(true);
    setNotice('');
    setError('');
    const { error: resendError } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (resendError) setError(resendError.message);
    else setNotice('A new confirmation link is on its way. Check your inbox and spam folder.');
  };

  const signIn = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email address and password.');
      return;
    }
    setBusy(true);
    setError('');
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (signInError) {
      const msg = signInError.message.toLowerCase();
      setError(
        msg.includes('not confirmed')
          ? 'Confirm your email address first — check your inbox for the link.'
          : msg.includes('invalid')
            ? 'That email and password combination is not correct.'
            : signInError.message,
      );
      return;
    }
    if (data.user) {
      setUserId(data.user.id);
      const existing = await loadProfile(data.user.id).catch(() => null);
      if (existing?.onboarding_status === 'submitted' || existing?.onboarding_status === 'verified') {
        onSuccess();
        return;
      }
      // The account exists but onboarding is unfinished — resume it instead of
      // dropping the user into a workspace they cannot use yet.
      setMode('signup');
      setStep(4);
    }
  };

  const persistDetails = async () => {
    if (!userId) return;
    if (!fullName.trim()) {
      setError('Enter your full name.');
      return;
    }
    if (!/^\+?[\d\s()-]{7,}$/.test(phone.trim())) {
      setError('Enter a valid mobile number including the country code.');
      return;
    }
    if (accountType === 'business' && !businessName.trim()) {
      setError('Enter your registered business name.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveProfile(userId, {
        account_type: accountType,
        country,
        full_name: fullName.trim(),
        phone: phone.trim(),
        business_name: accountType === 'business' ? businessName.trim() : null,
        business_type: accountType === 'business' ? businessType : null,
        business_category: accountType === 'business' ? businessCategory : null,
        onboarding_status: 'details_pending',
      });
      await recordAudit(userId, 'onboarding.details_saved', 'profile');
      go(5);
    } catch (e) {
      setError((e as Error).message || 'We could not save your details. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const persistIdentity = async () => {
    if (!userId) return;
    if (!legalName.trim() || !dob || !documentNumber.trim()) {
      setError('Legal name, date of birth and document number are all required.');
      return;
    }
    if (!occupation.trim()) {
      setError('Enter your occupation or profession.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveKyc(userId, {
        legal_name: legalName.trim(),
        date_of_birth: dob,
        nationality,
        occupation: occupation.trim(),
        document_type: documentType,
        document_number: documentNumber.trim(),
        document_country: documentCountry,
        status: 'draft',
      });
      await saveProfile(userId, { onboarding_status: 'kyc_pending' });
      await recordAudit(userId, 'onboarding.identity_saved', 'kyc_application');
      go(6);
    } catch (e) {
      setError((e as Error).message || 'We could not save your identity details. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const persistResidence = async () => {
    if (!userId) return;
    if (!address.trim() || !city.trim() || !postal.trim()) {
      setError('Street address, city and postal code are required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveKyc(userId, {
        address_line1: address.trim(),
        city: city.trim(),
        region: region.trim(),
        postal_code: postal.trim(),
        tax_residence: taxResidence,
      });
      await recordAudit(userId, 'onboarding.residence_saved', 'kyc_application');
      go(7);
    } catch (e) {
      setError((e as Error).message || 'We could not save your address. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!userId) return;
    setBusy(true);
    setError('');
    try {
      await saveKyc(userId, { status: 'submitted', submitted_at: new Date().toISOString() });
      await saveProfile(userId, { onboarding_status: 'submitted' });
      await ensureLedgerAccount(userId, 'USD');
      await recordAudit(userId, 'onboarding.submitted', 'kyc_application');
      onSuccess();
    } catch (e) {
      setError((e as Error).message || 'We could not submit your application. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    if (step === 1) return onBack();
    if (step === 3) return go(2);
    if (step === 4) return go(accountType ? 2 : 1);
    go((step - 1) as Step);
  };

  if (mode === 'signin') {
    return (
      <div className="auth-page onboarding-page">
        <div className="auth-side onboarding-side">
          <button className="brand" onClick={onBack}>
            <span className="brand-mark">
              <Shield size={17} />
            </span>
            <span>
              <span className="brand-name light">PAYWAI</span>
              <span className="brand-sub light">PRIVATE FINANCIAL INFRASTRUCTURE</span>
            </span>
          </button>
          <div className="onboarding-side-copy">
            <div className="eyebrow pale">WELCOME BACK</div>
            <h1>
              Your money. <em>One clear view.</em>
            </h1>
            <p>Sign in to see your balances, move money and manage your account.</p>
            <div className="onboarding-assurance">
              <div>
                <Shield size={16} />
                <span>
                  <b>Encrypted session</b>
                  <small>Your session is refreshed automatically</small>
                </span>
              </div>
              <div>
                <Lock size={16} />
                <span>
                  <b>Row-level security</b>
                  <small>Only you can read your records</small>
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="auth-form-wrap">
          <div className="onboarding-form">
            <div className="mobile-auth-logo">
              <button className="brand" onClick={onBack}>
                <span className="brand-mark">
                  <Shield size={17} />
                </span>
                <span>
                  <span className="brand-name">PAYWAI</span>
                  <span className="brand-sub">PRIVATE FINANCIAL INFRASTRUCTURE</span>
                </span>
              </button>
            </div>

            <div className="onboarding-head">
              <div>
                <div className="auth-kicker">SIGN IN TO PAYWAI</div>
                <h2>Welcome back</h2>
              </div>
            </div>

            <div className="verification-panel">
              <div className="verification-icon">
                <Lock />
              </div>
              <b>Sign in with your email</b>
              <p>Use the email address and password you chose when you opened your account.</p>
              <div className="form-grid">
                <label className="span-2">
                  Email address
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </label>
                <label className="span-2">
                  Password
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Your password"
                  />
                </label>
              </div>
              {error && <div className="error-note">{error}</div>}
              <button className="primary auth-submit" onClick={signIn} disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'} <ArrowRight size={15} />
              </button>
            </div>

            <div className="onboarding-actions">
              <button className="secondary" onClick={onBack}>
                <ArrowLeft size={15} /> Back to website
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setError('');
                  setMode('signup');
                  setStep(1);
                }}
              >
                Create an account
              </button>
            </div>

            <div className="onboarding-foot">
              <Lock size={13} /> Paywai staff will never ask you for your password or a login code.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page onboarding-page">
      <div className="auth-side onboarding-side">
        <button className="brand" onClick={onBack}>
          <span className="brand-mark">
            <Shield size={17} />
          </span>
          <span>
            <span className="brand-name light">PAYWAI</span>
            <span className="brand-sub light">PRIVATE FINANCIAL INFRASTRUCTURE</span>
          </span>
        </button>
        <div className="onboarding-side-copy">
          <div className="eyebrow pale">SECURE ACCOUNT OPENING</div>
          <h1>
            One identity. <em>Every control.</em>
          </h1>
          <p>
            Open your Paywai account in a few clear steps. Your progress is saved as you go, so you
            can stop and pick up where you left off.
          </p>
          <div className="onboarding-assurance">
            <div>
              <Shield size={16} />
              <span>
                <b>Protected sign-in</b>
                <small>Email confirmation and encrypted sessions</small>
              </span>
            </div>
            <div>
              <Lock size={16} />
              <span>
                <b>Your data stays yours</b>
                <small>Row-level security on every record</small>
              </span>
            </div>
            <div>
              <FileCheck2 size={16} />
              <span>
                <b>Regulated onboarding</b>
                <small>Identity checks before money can move</small>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="auth-form-wrap">
        <div className="onboarding-form">
          <div className="mobile-auth-logo">
            <button className="brand" onClick={onBack}>
              <span className="brand-mark">
                <Shield size={17} />
              </span>
              <span>
                <span className="brand-name">PAYWAI</span>
                <span className="brand-sub">PRIVATE FINANCIAL INFRASTRUCTURE</span>
              </span>
            </button>
          </div>

          <div className="onboarding-head">
            <div>
              <div className="auth-kicker">OPEN A PAYWAI ACCOUNT</div>
              <h2>{STEP_TITLES[step]}</h2>
            </div>
            <span className="step-count">{String(step).padStart(2, '0')} / 07</span>
          </div>

          <div className="progress-track">
            <i style={{ width: `${(step / 7) * 100}%` }} />
          </div>

          {step === 1 && (
            <div className="verification-panel">
              <div className="verification-icon">
                <UserRound />
              </div>
              <b>Choose your account type</b>
              <p>
                This decides the details we ask for. You can only change it by contacting support
                once your account is verified.
              </p>
              <div className="type-choices">
                <button
                  type="button"
                  className={accountType === 'personal' ? 'type-choice selected' : 'type-choice'}
                  onClick={() => setAccountType('personal')}
                >
                  <UserRound size={18} />
                  <b>Personal</b>
                  <small>For your own payments, balances and card.</small>
                  {accountType === 'personal' && <CheckCircle2 size={17} className="selected-check" />}
                </button>
                <button
                  type="button"
                  className={accountType === 'business' ? 'type-choice selected' : 'type-choice'}
                  onClick={() => setAccountType('business')}
                >
                  <Building2 size={18} />
                  <b>Business</b>
                  <small>For a registered company, team payouts and supplier payments.</small>
                  {accountType === 'business' && <CheckCircle2 size={17} className="selected-check" />}
                </button>
              </div>
              {error && <div className="error-note">{error}</div>}
            </div>
          )}

          {step === 2 && (
            <div className="verification-panel">
              <div className="verification-icon">
                <Mail />
              </div>
              <b>Your email and password</b>
              <p>This is how you will sign in to Paywai from now on.</p>
              <div className="form-grid">
                <label className="span-2">
                  Email address
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                  />
                </label>
                <label className="span-2">
                  Country or region of residence
                  <select value={country} onChange={(e) => setCountry(e.target.value)}>
                    {COUNTRIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a password"
                  />
                </label>
                <label>
                  Confirm password
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password2}
                    onChange={(e) => setPassword2(e.target.value)}
                    placeholder="Repeat your password"
                  />
                </label>
              </div>
              <div className="notice span-2">
                <Lock size={15} />
                <span>At least 8 characters with an uppercase letter, a lowercase letter and a number.</span>
              </div>
              {error && <div className="error-note">{error}</div>}
            </div>
          )}

          {step === 3 && (
            <div className="verification-panel">
              <div className="verification-icon">
                <Mail />
              </div>
              <b>Check your inbox</b>
              <p>
                We sent a confirmation link to <strong>{email}</strong>. Open it to activate your
                account — the link brings you straight back here to finish setting up.
              </p>
              <div className="verify-box">
                <CheckCircle2 />
                <b>One step left to activate</b>
                <span>Confirmation proves you own this email address.</span>
              </div>
              <button className="primary auth-submit" onClick={resendConfirmation} disabled={busy}>
                {busy ? 'Sending…' : 'Resend confirmation email'}
              </button>
              <button className="resend" onClick={() => go(2)}>
                Use a different email address
              </button>
              {notice && <div className="success-note">{notice}</div>}
              {error && <div className="error-note">{error}</div>}
            </div>
          )}

          {step === 4 && (
            <div className="verification-panel">
              <div className="verification-icon">
                <UserRound />
              </div>
              <b>{accountType === 'business' ? 'Your business details' : 'Your details'}</b>
              <p>
                {accountType === 'business'
                  ? 'Tell us who we are opening the account for and how to reach you.'
                  : 'Use your legal name so it matches your identity document.'}
              </p>
              <div className="form-grid">
                <label className="span-2">
                  Full name
                  <input
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="First and last name"
                  />
                </label>
                <label>
                  Mobile number
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+880 1XXX XXXXXX"
                  />
                </label>
                <label>
                  Email
                  <input value={email} readOnly />
                </label>
                {accountType === 'business' && (
                  <>
                    <label className="span-2">
                      Registered business name
                      <input
                        value={businessName}
                        onChange={(e) => setBusinessName(e.target.value)}
                        placeholder="As registered with the authorities"
                      />
                    </label>
                    <label>
                      Business type
                      <select value={businessType} onChange={(e) => setBusinessType(e.target.value)}>
                        <option>Sole proprietorship</option>
                        <option>Limited company</option>
                        <option>Partnership</option>
                        <option>Freelancer</option>
                        <option>Non-profit</option>
                      </select>
                    </label>
                    <label>
                      Industry
                      <select
                        value={businessCategory}
                        onChange={(e) => setBusinessCategory(e.target.value)}
                      >
                        <option>Software and IT services</option>
                        <option>Professional services</option>
                        <option>E-commerce and retail</option>
                        <option>Creative and media</option>
                        <option>Education</option>
                        <option>Other</option>
                      </select>
                    </label>
                  </>
                )}
              </div>
              {error && <div className="error-note">{error}</div>}
            </div>
          )}

          {step === 5 && (
            <div className="verification-panel">
              <div className="verification-icon">
                <FileCheck2 />
              </div>
              <b>Identity document</b>
              <p>Enter your details exactly as they appear on your passport or national ID.</p>
              <div className="form-grid">
                <label className="span-2">
                  Legal full name
                  <input
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="Exactly as shown on your ID"
                  />
                </label>
                <label>
                  Date of birth
                  <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
                </label>
                <label>
                  Nationality
                  <select value={nationality} onChange={(e) => setNationality(e.target.value)}>
                    {COUNTRIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Document type
                  <select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
                    <option>National ID</option>
                    <option>Passport</option>
                    <option>Driver&apos;s license</option>
                  </select>
                </label>
                <label>
                  Document country
                  <select
                    value={documentCountry}
                    onChange={(e) => setDocumentCountry(e.target.value)}
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className="span-2">
                  Document number
                  <input
                    value={documentNumber}
                    onChange={(e) => setDocumentNumber(e.target.value)}
                    placeholder="Enter the number on the document"
                  />
                </label>
                <label className="span-2">
                  Occupation
                  <input
                    value={occupation}
                    onChange={(e) => setOccupation(e.target.value)}
                    placeholder="Occupation or profession"
                  />
                </label>
              </div>
              <div className="notice span-2">
                <FileCheck2 size={15} />
                <span>
                  Document authenticity and liveness checks are performed by our identity provider
                  before your account is approved.
                </span>
              </div>
              {error && <div className="error-note">{error}</div>}
            </div>
          )}

          {step === 6 && (
            <div className="verification-panel">
              <div className="verification-icon">
                <MapPin />
              </div>
              <b>Residential address</b>
              <p>Use the address where you currently live, not a business address.</p>
              <div className="form-grid">
                <label className="span-2">
                  Street address
                  <input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="House, street and area"
                  />
                </label>
                <label>
                  City
                  <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
                </label>
                <label>
                  State or region
                  <input
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="State or region"
                  />
                </label>
                <label>
                  Postal code
                  <input
                    value={postal}
                    onChange={(e) => setPostal(e.target.value)}
                    placeholder="Postal code"
                  />
                </label>
                <label>
                  Country of tax residence
                  <select value={taxResidence} onChange={(e) => setTaxResidence(e.target.value)}>
                    {COUNTRIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="notice span-2">
                <MapPin size={15} />
                <span>Proof of address may be requested if we cannot verify these details.</span>
              </div>
              {error && <div className="error-note">{error}</div>}
            </div>
          )}

          {step === 7 && (
            <div className="review-list">
              <Row label="Account type" value={accountType === 'business' ? 'Business' : 'Personal'} />
              <Row label="Email" value={email} />
              <Row label="Full name" value={fullName || 'Missing'} />
              {accountType === 'business' && (
                <>
                  <Row label="Business" value={businessName || 'Missing'} />
                  <Row label="Business type" value={businessType} />
                </>
              )}
              <Row label="Mobile" value={phone || 'Missing'} />
              <Row label="Legal name" value={legalName || 'Missing'} />
              <Row label="Date of birth" value={dob || 'Missing'} />
              <Row label="Document" value={`${documentType} · ${documentNumber || 'Missing'}`} />
              <Row label="Nationality" value={nationality} />
              <Row label="Occupation" value={occupation || 'Missing'} />
              <Row
                label="Residence"
                value={address ? `${address}, ${city} ${postal}`.trim() : 'Missing'}
              />
              <Row label="Tax residence" value={taxResidence} />
              {error && <div className="error-note">{error}</div>}
            </div>
          )}

          {step === 1 && (
            <div className="onboarding-actions">
              <button className="secondary" onClick={onBack}>
                <ArrowLeft size={15} /> Back to website
              </button>
              <button className="primary" onClick={() => go(2)}>
                Continue <ArrowRight size={15} />
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="onboarding-actions">
              <button className="secondary" onClick={back}>
                Back
              </button>
              <button className="primary" onClick={createAccount} disabled={busy}>
                {busy ? 'Creating account…' : 'Create account'} <ArrowRight size={15} />
              </button>
            </div>
          )}

          {step === 4 && (
            <div className="onboarding-actions">
              <button className="secondary" onClick={back}>
                Back
              </button>
              <button className="primary" onClick={persistDetails} disabled={busy}>
                {busy ? 'Saving…' : 'Save and continue'} <ArrowRight size={15} />
              </button>
            </div>
          )}

          {step === 5 && (
            <div className="onboarding-actions">
              <button className="secondary" onClick={back}>
                Back
              </button>
              <button className="primary" onClick={persistIdentity} disabled={busy}>
                {busy ? 'Saving…' : 'Save and continue'} <ArrowRight size={15} />
              </button>
            </div>
          )}

          {step === 6 && (
            <div className="onboarding-actions">
              <button className="secondary" onClick={back}>
                Back
              </button>
              <button className="primary" onClick={persistResidence} disabled={busy}>
                {busy ? 'Saving…' : 'Review details'} <ArrowRight size={15} />
              </button>
            </div>
          )}

          {step === 7 && (
            <div className="onboarding-actions">
              <button className="secondary" onClick={back}>
                Back
              </button>
              <button className="primary" onClick={submit} disabled={busy}>
                {busy ? 'Submitting…' : 'Submit for review'} <Check size={15} />
              </button>
            </div>
          )}

          <div className="onboarding-foot">
            <Lock size={13} /> Your information is protected by row-level security and used only to
            open your account.
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
