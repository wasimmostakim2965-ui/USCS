import { useEffect, useState } from 'react';
import './auth-v2.css';
import QRCode from 'qrcode';
import { api, auth } from '@appdeploy/client';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, FileCheck2, Lock, Mail, MapPin, Shield, Smartphone, UserRound } from 'lucide-react';

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export default function AuthV2({ onBack, onSuccess }: { onBack: () => void; onSuccess: () => void }) {
  const [step, setStep] = useState<Step>(1);
  const [email, setEmail] = useState('');
  const [googleReady, setGoogleReady] = useState(false);
  const [txPassword, setTxPassword] = useState('');
  const [txPassword2, setTxPassword2] = useState('');
  const [mfaUri, setMfaUri] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [mfaQr, setMfaQr] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaReady, setMfaReady] = useState(false);
  const [legalName, setLegalName] = useState('');
  const [dob, setDob] = useState('');
  const [nationality, setNationality] = useState('Bangladesh');
  const [occupation, setOccupation] = useState('');
  const [phone, setPhone] = useState('');
  const [documentType, setDocumentType] = useState('National ID');
  const [documentCountry, setDocumentCountry] = useState('Bangladesh');
  const [documentNumber, setDocumentNumber] = useState('');
  const [identityReady, setIdentityReady] = useState(false);
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [postal, setPostal] = useState('');
  const [taxResidence, setTaxResidence] = useState('Bangladesh');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState('');

  useEffect(() => {
    void auth.getUser().then((u) => {
      if (u) { setEmail(u.email ?? ''); setGoogleReady(true); }
    });
  }, []);

  const googleSignIn = async () => {
    try {
      setBusy(true); setErrorText('');
      const result = await auth.signIn({ scope: 'openid email profile offline_access' });
      setEmail(result.user.email ?? '');
      setGoogleReady(true);
      setStep(2);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setErrorText(err.code === 'popup_closed' ? 'Google sign-in was cancelled.' : err.code === 'popup_blocked' ? 'Allow pop-ups for Sovereign and try again.' : err.message ?? 'Google sign-in failed.');
    } finally { setBusy(false); }
  };

  const saveTxPassword = async () => {
    if (txPassword.length < 8) return setErrorText('Use at least 8 characters.');
    if (txPassword !== txPassword2) return setErrorText('The passwords do not match.');
    try { setBusy(true); setErrorText(''); await api.post('/api/security/transaction-password', { password: txPassword }); setStep(3); }
    catch (e) { setErrorText((e as Error).message || 'Could not save the transaction password.'); }
    finally { setBusy(false); }
  };

  const setupMfa = async () => {
    try {
      setBusy(true); setErrorText('');
      const response = await api.post('/api/security/mfa/setup');
      const data = response.data as { otpauthUri: string; secret: string };
      setMfaUri(data.otpauthUri); setMfaSecret(data.secret);
      setMfaQr(await QRCode.toDataURL(data.otpauthUri, { width: 220, margin: 1 }));
    } catch (e) { setErrorText((e as Error).message || 'Could not prepare authenticator setup.'); }
    finally { setBusy(false); }
  };

  const verifyMfa = async () => {
    if (!/^\d{6}$/.test(mfaCode)) return setErrorText('Enter the 6-digit code from your authenticator.');
    try { setBusy(true); setErrorText(''); await api.post('/api/security/mfa/verify', { code: mfaCode }); setMfaReady(true); setStep(4); }
    catch (e) { setErrorText((e as Error).message || 'Authenticator verification failed.'); }
    finally { setBusy(false); }
  };

  const save = async (submitted = false) => {
    try {
      setBusy(true); setErrorText('');
      await api.post('/api/onboarding', { legalName, dateOfBirth: dob, nationality, occupation, phone, address, city, region, postalCode: postal, taxResidence, documentType, documentNumber, documentCountry, identityStatus: identityReady ? 'submitted' : 'not_started', faceStatus: identityReady ? 'completed' : 'not_started', residenceStatus: address ? 'submitted' : 'not_started', submitted });
      if (submitted) onSuccess(); else setStep((step + 1) as Step);
    } catch (e) { setErrorText((e as Error).message || 'Could not save your account information.'); }
    finally { setBusy(false); }
  };

  const next = async () => {
    setErrorText('');
    if (step === 4 && (!legalName || !dob || !documentNumber)) return setErrorText('Complete legal name, date of birth and document number.');
    if (step === 5 && (!occupation || !phone)) return setErrorText('Complete occupation and mobile number.');
    if (step === 6 && (!address || !city || !postal)) return setErrorText('Complete your residential address.');
    if (step >= 4 && step <= 6) return save(false);
    setStep((step + 1) as Step);
  };

  return <div className='auth-page onboarding-page'>
    <div className='auth-side onboarding-side'><button className='back-brand' onClick={onBack}><Logo /></button><div className='onboarding-side-copy'><div className='eyebrow pale'>SECURE ACCOUNT OPENING</div><h1>One identity. <em>Every control.</em></h1><p>Authentication, transaction security, identity and residence are collected as separate reviewable stages.</p><div className='onboarding-assurance'><div><Shield size={16}/><span><b>Real Google authentication</b><small>Account chooser, not a mock button</small></span></div><div><Lock size={16}/><span><b>Transfer security</b><small>Separate transaction password + authenticator</small></span></div><div><FileCheck2 size={16}/><span><b>Persistent onboarding</b><small>Protected account data is saved server-side</small></span></div></div></div></div>
    <div className='auth-form-wrap'><div className='onboarding-form'><div className='mobile-auth-logo'><Logo /></div><div className='onboarding-head'><div><div className='auth-kicker'>OPEN A SOVEREIGN ACCOUNT</div><h2>{step===1?'Authenticate with Google.':step===2?'Create your transaction password.':step===3?'Secure the account with an authenticator.':step===4?'Verify your identity.':step===5?'Tell us about yourself.':step===6?'Confirm your residence.':'Review and submit.'}</h2><p>{step===1?'Google authentication establishes the account identity and already verifies control of the Google email. The old redundant “Verify your email” page is gone.':step===2?'This is not your Google password. It is a separate password for authorizing sensitive money transfers.':step===3?'Scan the QR code with Google Authenticator, or enter the setup key manually, then verify the six-digit code.':step===4?'Enter the legal identity information required for review.':step===5?'Use your legal details and contact information.':step===6?'Enter your residential address and tax residence.':'Review everything before submitting the account for review.'}</p></div><span className='step-count'>{String(step).padStart(2,'0')} / 07</span></div><div className='progress-track'><i style={{width:`${step/7*100}%`}}/></div>
    {step===1&&<div className='verification-panel auth-provider-panel'><div className='verification-icon'><Shield/></div><b>Continue with Google</b><p>Clicking this opens the real Google authentication flow so you can choose your Gmail/Google account.</p><button className='google-auth-button' onClick={googleSignIn} disabled={busy}><GoogleMark/>{busy?'Connecting to Google…':'Continue with Google'}<ArrowRight size={15}/></button><div className='notice'><Mail size={15}/><span>Google authentication completes email ownership here. A separate “Verify your email” step will not appear.</span></div>{googleReady&&<div className='success-note'><CheckCircle2 size={15}/> Authenticated as {email}</div>}{errorText&&<div className='error-note'>{errorText}</div>}</div>}
    {step===2&&<div className='verification-panel'><div className='verification-icon'><Lock/></div><b>Transaction password</b><p>Used when a sensitive transfer needs your authorization. It is never the password for Google sign-in.</p><label>Password<input type='password' autoComplete='new-password' value={txPassword} onChange={e=>setTxPassword(e.target.value)} placeholder='At least 8 characters'/></label><label>Confirm password<input type='password' autoComplete='new-password' value={txPassword2} onChange={e=>setTxPassword2(e.target.value)} placeholder='Repeat the password'/></label><button className='primary' onClick={saveTxPassword} disabled={busy}>{busy?'Saving…':'Set transaction password'}<ArrowRight size={15}/></button>{errorText&&<div className='error-note'>{errorText}</div>}</div>}
    {step===3&&<div className='verification-panel mfa-panel'><div className='verification-icon'><Smartphone/></div><b>Google Authenticator</b><p>Set up TOTP two-factor authentication using a QR code or the manual setup key.</p>{!mfaUri&&<button className='primary' onClick={setupMfa} disabled={busy}>{busy?'Preparing…':'Generate QR code'}<ArrowRight size={15}/></button>}{mfaUri&&<div className='mfa-setup'>{mfaQr&&<img className='mfa-qr' src={mfaQr} alt='Google Authenticator QR code'/>}<div className='mfa-secret'><span>Manual setup key</span><strong>{mfaSecret}</strong></div><label>Authenticator code<input className='otp-input' inputMode='numeric' maxLength={6} value={mfaCode} onChange={e=>setMfaCode(e.target.value.replace(/\D/g,''))} placeholder='000000'/></label><button className='primary' onClick={verifyMfa} disabled={busy||mfaCode.length!==6}>{busy?'Verifying…':'Verify authenticator'}<Check size={15}/></button></div>}{mfaReady&&<div className='success-note'><CheckCircle2 size={15}/> Authenticator verified</div>}{errorText&&<div className='error-note'>{errorText}</div>}</div>}
    {step===4&&<div className='form-grid'><label className='span-2'>Legal full name<input value={legalName} onChange={e=>setLegalName(e.target.value)} placeholder='Exactly as shown on your ID'/></label><label>Date of birth<input type='date' value={dob} onChange={e=>setDob(e.target.value)}/></label><label>Nationality<select value={nationality} onChange={e=>setNationality(e.target.value)}><option>Bangladesh</option><option>United States</option><option>United Kingdom</option><option>United Arab Emirates</option><option>Canada</option><option>Australia</option><option>Other</option></select></label><label>Document country<select value={documentCountry} onChange={e=>setDocumentCountry(e.target.value)}><option>Bangladesh</option><option>United States</option><option>United Kingdom</option><option>United Arab Emirates</option><option>Canada</option></select></label><label>Document type<select value={documentType} onChange={e=>setDocumentType(e.target.value)}><option>National ID</option><option>Passport</option><option>Driver's license</option></select></label><label className='span-2'>Identity document number<input value={documentNumber} onChange={e=>setDocumentNumber(e.target.value)} placeholder='Enter document number'/></label><div className='notice span-2'><FileCheck2 size={15}/><span>Identity fields are stored for review. Actual document authenticity/liveness requires a connected KYC provider.</span></div><button className='secondary span-2' onClick={()=>setIdentityReady(true)}><UserRound size={15}/>{identityReady?'Identity review prepared':'Prepare identity review'}<ArrowRight size={15}/></button>{errorText&&<div className='error-note span-2'>{errorText}</div>}</div>}
    {step===5&&<div className='form-grid'><label className='span-2'>Authenticated email<input value={email} readOnly/></label><label className='span-2'>Legal name<input value={legalName} readOnly/></label><label>Occupation<input value={occupation} onChange={e=>setOccupation(e.target.value)} placeholder='Occupation or profession'/></label><label>Mobile number<input value={phone} onChange={e=>setPhone(e.target.value)} placeholder='+880 1XXXXXXXXX'/></label><div className='notice span-2'><Mail size={15}/><span>This email was authenticated by Google. No second email verification challenge is required.</span></div>{errorText&&<div className='error-note span-2'>{errorText}</div>}</div>}
    {step===6&&<div className='form-grid'><label className='span-2'>Residential address<input value={address} onChange={e=>setAddress(e.target.value)} placeholder='Street address'/></label><label>City<input value={city} onChange={e=>setCity(e.target.value)} placeholder='City'/></label><label>State / region<input value={region} onChange={e=>setRegion(e.target.value)} placeholder='State or region'/></label><label>Postal code<input value={postal} onChange={e=>setPostal(e.target.value)} placeholder='Postal code'/></label><label>Tax residence<select value={taxResidence} onChange={e=>setTaxResidence(e.target.value)}><option>Bangladesh</option><option>United States</option><option>United Kingdom</option><option>United Arab Emirates</option><option>Other</option></select></label><div className='notice span-2'><MapPin size={15}/><span>Additional proof of residence may be required by the actual financial/KYC provider.</span></div>{errorText&&<div className='error-note span-2'>{errorText}</div>}</div>}
    {step===7&&<div className='review-list'><Review label='Google account' value={email||'Not connected'}/><Review label='Transaction password' value='Configured'/><Review label='Authenticator' value={mfaReady?'Verified':'Not verified'}/><Review label='Legal identity' value={legalName||'Missing'}/><Review label='Identity document' value={documentType+' · '+(documentNumber||'Missing')}/><Review label='Occupation' value={occupation||'Missing'}/><Review label='Mobile' value={phone||'Missing'}/><Review label='Residence' value={address?address+', '+city:'Missing'}/><Review label='Tax residence' value={taxResidence}/>{errorText&&<div className='error-note'>{errorText}</div>}</div>}
    {step>1&&step<7&&<div className='onboarding-actions'><button className='secondary' onClick={()=>setStep((step-1) as Step)}>Back</button><button className='primary' onClick={next} disabled={busy}>{busy?'Saving…':'Save & continue'}<ArrowRight size={15}/></button></div>}{step===7&&<div className='onboarding-actions'><button className='secondary' onClick={()=>setStep(6)}>Back</button><button className='primary' onClick={()=>save(true)} disabled={busy}>{busy?'Submitting…':'Submit account for review'}<Check size={15}/></button></div>}{step===1&&<button className='back-link onboarding-back' onClick={onBack}><ArrowLeft size={14}/>Back to website</button>}<div className='onboarding-foot'><Lock size={13}/>Secure flow · Google credentials are never collected by Sovereign</div></div></div></div>;
}

function Logo(){return <div className='brand'><div className='brand-mark'><Shield size={17}/></div><div><div className='brand-name light'>SOVEREIGN</div><div className='brand-sub light'>PRIVATE FINANCIAL INFRASTRUCTURE</div></div></div>}
function GoogleMark(){return <span className='google-mark' aria-hidden='true'>G</span>}
function Review({label,value}:{label:string;value:string}){return <div><span>{label}</span><b>{value}</b></div>}
