import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Building2,
  CheckCircle2,
  FileCheck2,
  Lock,
  MapPin,
  ShieldCheck,
  UserRound,
  Wallet,
} from 'lucide-react';
import Brand from '../components/Brand';
import { supabase, supabaseConfigured } from '../lib/supabase';
import {
  loadKyc,
  loadProfile,
  recordAudit,
  saveKyc,
  saveProfile,
  type AccountType,
  type Profile,
} from '../lib/account';

type Step = 1 | 2 | 3 | 4;

const countries = [
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

const documentTypes = ['Passport', 'National ID card', "Driver's licence", 'Residence permit'];

const businessTypes = [
  'Sole trader / freelancer',
  'Private limited company',
  'Partnership',
  'Public company',
  'Non-profit',
];

const businessCategories = [
  'Software and IT services',
  'Professional services',
  'E-commerce and retail',
  'Creative and media',
  'Marketing and advertising',
  'Education',
  'Other',
];

export default function Onboarding({
  userId,
  onBack,
  onDone,
}: {
  userId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [accountType, setAccountType] = useState<AccountType>('personal');
  const [country, setCountry] = useState('Bangladesh');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [businessType, setBusinessType] = useState(businessTypes[0]);
  const [businessCategory, setBusinessCategory] = useState(businessCategories[0]);

  const [legalName, setLegalName] = useState('');
  const [dob, setDob] = useState('');
  const [nationality, setNationality] = useState('Bangladesh');
  const [occupation, setOccupation] = useState('');
  const [documentType, setDocumentType] = useState(documentTypes[0]);
  const [documentNumber, setDocumentNumber] = useState('');
  const [documentCountry, setDocumentCountry] = useState('Bangladesh');

  const [address1, setAddress1] = useState('');
  const [address2, setAddress2] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postal, setPostal] = useState('');
  const [taxResidence, setTaxResidence] = useState('Bangladesh');

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!supabaseConfigured) {
        setError('The auth backend is not configured for this deployment.');
        setLoading(false);
        return;
      }
      try {
        const [p, k] = await Promise.all([loadProfile(userId), loadKyc(userId)]);
        if (!alive) return;
        setProfile(p);
        if (p) {
          setAccountType(p.account_type ?? 'personal');
          setCountry(p.country ?? 'Bangladesh');
          setFullName(p.full_name ?? '');
          setPhone(p.phone ?? '');
          setBusinessName(p.business_name ?? '');
          setBusinessType(p.business_type ?? businessTypes[0]);
          setBusinessCategory(p.business_category ?? businessCategories[0]);
        }
        if (k) {
          setLegalName(k.legal_name ?? '');
          setDob(k.date_of_birth ?? '');
          setNationality(k.nationality ?? 'Bangladesh');
          setOccupation(k.occupation ?? '');
          setDocumentType(k.document_type ?? documentTypes[0]);
          setDocumentNumber(k.document_number ?? '');
          setDocumentCountry(k.document_country ?? 'Bangladesh');
          setAddress1(k.address_line1 ?? '');
          setAddress2(k.address_line2 ?? '');
          setCity(k.city ?? '');
          setRegion(k.region ?? '');
          setPostal(k.postal_code ?? '');
          setTaxResidence(k.tax_residence ?? 'Bangladesh');
        }
      } catch (e) {
        setError((e as Error).message || 'We could not load your account.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId]);

  const isBusiness = accountType === 'business';

  const steps = useMemo(
    () => (isBusiness ? ['Account', 'Details', 'Address', 'Review'] : ['Account', 'Details', 'Address', 'Review']),
    [isBusiness],
  );

  const saveAccount = async () => {
    setError('');
    if (!fullName.trim()) return setError('Enter your full name.');
    if (isBusiness && !businessName.trim()) return setError('Enter your registered business name.');
    if (!/^[+\d][\d\s()-]{6,}$/.test(phone.trim()))
      return setError('Enter a reachable mobile number, including country code.');
    try {
      setBusy(true);
      await saveProfile(userId, {
        account_type: accountType,
        country,
        full_name: fullName.trim(),
        phone: phone.trim(),
        business_name: isBusiness ? businessName.trim() : null,
        business_type: isBusiness ? businessType : null,
        business_category: isBusiness ? businessCategory : null,
        onboarding_status: 'details_pending',
      });
      await recordAudit(userId, 'onboarding.account_details_saved', 'profile');
      setNotice('Saved.');
      setStep(2);
    } catch (e) {
      setError((e as Error).message || 'We could not save your details.');
    } finally {
      setBusy(false);
    }
  };

  const saveDetails = async () => {
    setError('');
    if (!legalName.trim()) return setError('Enter your legal name exactly as shown on your document.');
    if (!dob) return setError('Enter your date of birth.');
    if (!occupation.trim()) return setError('Enter your occupation.');
    if (!documentNumber.trim()) return setError('Enter your document number.');
    if (new Date(dob) > new Date())
      return setError('Date of birth cannot be in the future.');
    try {
      setBusy(true);
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
      await recordAudit(userId, 'onboarding.identity_details_saved', 'kyc_application');
      setNotice('Saved.');
      setStep(3);
    } catch (e) {
      setError((e as Error).message || 'We could not save your identity details.');
    } finally {
      setBusy(false);
    }
  };

  const saveAddress = async () => {
    setError('');
    if (!address1.trim()) return setError('Enter your street address.');
    if (!city.trim()) return setError('Enter your city.');
    if (!postal.trim()) return setError('Enter your postal code.');
    try {
      setBusy(true);
      await saveKyc(userId, {
        address_line1: address1.trim(),
        address_line2: address2.trim() || null,
        city: city.trim(),
        region: region.trim() || null,
        postal_code: postal.trim(),
        tax_residence: taxResidence,
        status: 'draft',
      });
      await saveProfile(userId, { onboarding_status: 'kyc_pending' });
      await recordAudit(userId, 'onboarding.address_saved', 'kyc_application');
      setNotice('Saved.');
      setStep(4);
    } catch (e) {
      setError((e as Error).message || 'We could not save your address.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setError('');
    try {
      setBusy(true);
      await saveKyc(userId, { status: 'submitted', submitted_at: new Date().toISOString() });
      await saveProfile(userId, { onboarding_status: 'submitted' });
      await recordAudit(userId, 'onboarding.submitted', 'kyc_application');
      onDone();
    } catch (e) {
      setError((e as Error).message || 'We could not submit your application.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="auth-shell">
        <main className="auth-main">
          <div className="auth-card narrow">
            <p className="muted">Loading your account…</p>
          </div>
        </main>
      </div>
    );
  }

  const savedStatus = profile?.onboarding_status;

  return (
    <div className="auth-shell">
      <aside className="auth-aside">
        <button
          className="btn btn-quiet"
          onClick={onBack}
          style={{ color: '#a9bdd2', alignSelf: 'flex-start', padding: 0 }}
        >
          <ArrowLeft size={14} /> Back to website
        </button>
        <Brand onDark />
        <h2 className="headline">
          Complete your account so it can hold and move money.
        </h2>
        <p className="sub">
          Financial accounts need identity verification. We collect it once, keep it protected, and
          review it before payment features are enabled.
        </p>
        <div className="assurance">
          <div>
            <UserRound size={17} />
            <span>
              <b>Your details</b>
              <small>Name, contact and account type.</small>
            </span>
          </div>
          <div>
            <FileCheck2 size={17} />
            <span>
              <b>Identity document</b>
              <small>As shown on your passport or national ID.</small>
            </span>
          </div>
          <div>
            <MapPin size={17} />
            <span>
              <b>Residence</b>
              <small>Where you live and pay tax.</small>
            </span>
          </div>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-topbar">
          <Brand />
          <span className="step-meta">
            Step {step} of {steps.length}
          </span>
        </div>

        <div className="auth-card">
          <div className="step-track">
            {steps.map((label, index) => (
              <div key={label} className={'seg' + (step > index ? ' on' : '')} />
            ))}
          </div>

          {savedStatus && savedStatus !== 'started' && (
            <div className="alert alert-info">
              <ShieldCheck size={16} />
              <span>
                Your application is currently <b>{savedStatus.replace(/_/g, ' ')}</b>. Saving again
                updates your existing application.
              </span>
            </div>
          )}
          {error && <div className="alert alert-danger">{error}</div>}
          {notice && !error && (
            <div className="alert alert-success">
              <CheckCircle2 size={16} /> {notice}
            </div>
          )}

          {step === 1 && (
            <>
              <div className="auth-head">
                <h2>What kind of account do you need?</h2>
                <p>
                  This determines the documents we ask for. You can only change it by contacting
                  support once your account is verified.
                </p>
              </div>
              <div className="choice-grid" style={{ marginBottom: 22 }}>
                <button
                  className={'choice' + (accountType === 'personal' ? ' on' : '')}
                  onClick={() => setAccountType('personal')}
                >
                  <Wallet size={18} color="#0d6efd" />
                  <b style={{ marginTop: 10 }}>Personal</b>
                  <small>For your own payments, balances and card.</small>
                </button>
                <button
                  className={'choice' + (accountType === 'business' ? ' on' : '')}
                  onClick={() => setAccountType('business')}
                >
                  <Building2 size={18} color="#0d6efd" />
                  <b style={{ marginTop: 10 }}>Business</b>
                  <small>For a registered company, team payouts and supplier payments.</small>
                </button>
              </div>

              <div className="form-grid">
                <label className="field span-2">
                  <span>{isBusiness ? 'Your full name' : 'Full name'}</span>
                  <input
                    className="input"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="First and last name"
                  />
                </label>
                {isBusiness && (
                  <>
                    <label className="field span-2">
                      <span>Registered business name</span>
                      <input
                        className="input"
                        value={businessName}
                        onChange={(e) => setBusinessName(e.target.value)}
                        placeholder="Exactly as registered"
                      />
                    </label>
                    <label className="field">
                      <span>Business type</span>
                      <select
                        className="input"
                        value={businessType}
                        onChange={(e) => setBusinessType(e.target.value)}
                      >
                        {businessTypes.map((b) => (
                          <option key={b}>{b}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Business category</span>
                      <select
                        className="input"
                        value={businessCategory}
                        onChange={(e) => setBusinessCategory(e.target.value)}
                      >
                        {businessCategories.map((b) => (
                          <option key={b}>{b}</option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                <label className="field">
                  <span>Country or region</span>
                  <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
                    {countries.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Mobile number</span>
                  <input
                    className="input"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+880 1XXX XXXXXX"
                  />
                  <small className="hint">Include your country code. We use this for security checks.</small>
                </label>
              </div>

              <div className="auth-actions">
                <button className="btn btn-ghost" onClick={onBack}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={saveAccount} disabled={busy}>
                  {busy ? 'Saving…' : 'Save and continue'} <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="auth-head">
                <h2>Verify your identity</h2>
                <p>
                  Enter your details exactly as they appear on your identity document. Mismatched
                  details are the most common reason applications are delayed.
                </p>
              </div>
              <div className="form-grid">
                <label className="field span-2">
                  <span>Legal full name</span>
                  <input
                    className="input"
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    placeholder="Exactly as shown on your document"
                  />
                </label>
                <label className="field">
                  <span>Date of birth</span>
                  <input
                    className="input"
                    type="date"
                    value={dob}
                    max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setDob(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Nationality</span>
                  <select
                    className="input"
                    value={nationality}
                    onChange={(e) => setNationality(e.target.value)}
                  >
                    {countries.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className="field span-2">
                  <span>Occupation</span>
                  <input
                    className="input"
                    value={occupation}
                    onChange={(e) => setOccupation(e.target.value)}
                    placeholder="e.g. Software engineer, Business owner"
                  />
                </label>
                <label className="field">
                  <span>Document type</span>
                  <select
                    className="input"
                    value={documentType}
                    onChange={(e) => setDocumentType(e.target.value)}
                  >
                    {documentTypes.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Issuing country</span>
                  <select
                    className="input"
                    value={documentCountry}
                    onChange={(e) => setDocumentCountry(e.target.value)}
                  >
                    {countries.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className="field span-2">
                  <span>Document number</span>
                  <input
                    className="input"
                    value={documentNumber}
                    onChange={(e) => setDocumentNumber(e.target.value)}
                    placeholder="Enter the number printed on your document"
                  />
                </label>
              </div>
              <div className="alert alert-info">
                <FileCheck2 size={16} />
                <span>
                  Uploading a photo of your document and completing a liveness check is done by our
                  verification partner once your details are submitted.
                </span>
              </div>
              <div className="auth-actions">
                <button className="btn btn-ghost" onClick={() => setStep(1)}>
                  Back
                </button>
                <button className="btn btn-primary" onClick={saveDetails} disabled={busy}>
                  {busy ? 'Saving…' : 'Save and continue'} <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="auth-head">
                <h2>Where do you live?</h2>
                <p>Use your current residential address. A PO box cannot be accepted.</p>
              </div>
              <div className="form-grid">
                <label className="field span-2">
                  <span>Street address</span>
                  <input
                    className="input"
                    value={address1}
                    onChange={(e) => setAddress1(e.target.value)}
                    placeholder="House, street, area"
                  />
                </label>
                <label className="field span-2">
                  <span>
                    Apartment, suite or floor <span className="hint" style={{ display: 'inline' }}>(optional)</span>
                  </span>
                  <input
                    className="input"
                    value={address2}
                    onChange={(e) => setAddress2(e.target.value)}
                    placeholder="Apartment, suite or floor"
                  />
                </label>
                <label className="field">
                  <span>City</span>
                  <input className="input" value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" />
                </label>
                <label className="field">
                  <span>State or region</span>
                  <input
                    className="input"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="State, province or region"
                  />
                </label>
                <label className="field">
                  <span>Postal code</span>
                  <input
                    className="input"
                    value={postal}
                    onChange={(e) => setPostal(e.target.value)}
                    placeholder="Postal or ZIP code"
                  />
                </label>
                <label className="field">
                  <span>Country or region of tax residence</span>
                  <select
                    className="input"
                    value={taxResidence}
                    onChange={(e) => setTaxResidence(e.target.value)}
                  >
                    {countries.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="auth-actions">
                <button className="btn btn-ghost" onClick={() => setStep(2)}>
                  Back
                </button>
                <button className="btn btn-primary" onClick={saveAddress} disabled={busy}>
                  {busy ? 'Saving…' : 'Save and continue'} <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <div className="auth-head">
                <h2>Review and submit</h2>
                <p>Check everything carefully. Submitting sends your application for review.</p>
              </div>
              <div className="review">
                <div className="group">Account</div>
                <div className="row">
                  <span>Account type</span>
                  <b>{isBusiness ? 'Business' : 'Personal'}</b>
                </div>
                <div className="row">
                  <span>Full name</span>
                  <b>{fullName || 'Missing'}</b>
                </div>
                {isBusiness && (
                  <>
                    <div className="row">
                      <span>Business name</span>
                      <b>{businessName || 'Missing'}</b>
                    </div>
                    <div className="row">
                      <span>Business type</span>
                      <b>{businessType}</b>
                    </div>
                    <div className="row">
                      <span>Business category</span>
                      <b>{businessCategory}</b>
                    </div>
                  </>
                )}
                <div className="row">
                  <span>Country</span>
                  <b>{country}</b>
                </div>
                <div className="row">
                  <span>Mobile</span>
                  <b>{phone || 'Missing'}</b>
                </div>
                <div className="group">Identity</div>
                <div className="row">
                  <span>Legal name</span>
                  <b>{legalName || 'Missing'}</b>
                </div>
                <div className="row">
                  <span>Date of birth</span>
                  <b>{dob || 'Missing'}</b>
                </div>
                <div className="row">
                  <span>Nationality</span>
                  <b>{nationality}</b>
                </div>
                <div className="row">
                  <span>Occupation</span>
                  <b>{occupation || 'Missing'}</b>
                </div>
                <div className="row">
                  <span>Document</span>
                  <b>
                    {documentType} · {documentNumber || 'Missing'} · {documentCountry}
                  </b>
                </div>
                <div className="group">Residence</div>
                <div className="row">
                  <span>Address</span>
                  <b>{[address1, address2, city, region, postal].filter(Boolean).join(', ') || 'Missing'}</b>
                </div>
                <div className="row">
                  <span>Tax residence</span>
                  <b>{taxResidence}</b>
                </div>
              </div>
              <div className="alert alert-info" style={{ marginTop: 20 }}>
                <BadgeCheck size={16} />
                <span>
                  After you submit, your details go to identity review. You can use your workspace
                  immediately, but payments stay limited until verification is approved.
                </span>
              </div>
              <div className="auth-actions">
                <button className="btn btn-ghost" onClick={() => setStep(3)}>
                  Back
                </button>
                <button className="btn btn-primary" onClick={submit} disabled={busy}>
                  {busy ? 'Submitting…' : 'Submit for review'} <CheckCircle2 size={15} />
                </button>
              </div>
            </>
          )}

          <p className="auth-foot" style={{ margin: '18px auto 0' }}>
            <Lock size={12} /> Your information is stored against your account only and protected by
            row-level security.
          </p>
        </div>
      </main>
    </div>
  );
}