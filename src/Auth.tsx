import { useEffect, useMemo, useState } from 'react';
import './account-opening.css';
import { supabase, supabaseConfigured } from './lib/supabase';
import {
  ensureLedgerAccount,
  loadKyc,
  loadProfile,
  loadSecurity,
  recordAudit,
  saveKyc,
  saveProfile,
  saveSecurity,
} from './lib/account';
import { passwordIssues } from './lib/security';
import QRCode from 'qrcode';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Lock,
  Shield,
} from 'lucide-react';

type SignupStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;
type LoginStep = 'credentials' | 'email' | 'authenticator';

const COUNTRIES = ['Bangladesh','United States','United Kingdom','United Arab Emirates','Canada','Australia','Germany','India','Singapore','Other'];

const STEP_TITLES: Record<SignupStep,string> = {
  1: 'Create your account',
  2: 'Verify your email',
  3: 'Tell us about you',
  4: 'Verify your identity',
  5: 'Where do you live?',
  6: 'Secure your account',
  7: 'Account created',
};

const b32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const makeSecret=()=>{const bytes=crypto.getRandomValues(new Uint8Array(20));let out='',buf=0,bits=0;for(const b of bytes){buf=(buf<<8)|b;bits+=8;while(bits>=5){bits-=5;out+=b32[(buf>>bits)&31]}}if(bits)out+=b32[(buf<<(5-bits))&31];return out};
const decodeBase32=(value:string)=>{const clean=value.replace(/=+$/,'').toUpperCase();let buf=0,bits=0;const out:number[]=[];for(const c of clean){const n=b32.indexOf(c);if(n<0)throw new Error('Invalid authenticator secret');buf=(buf<<5)|n;bits+=5;if(bits>=8){bits-=8;out.push((buf>>bits)&255)}}return new Uint8Array(out)};
const hotp=async(secret:string,counter:number)=>{const key=await crypto.subtle.importKey('raw',decodeBase32(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);const data=new ArrayBuffer(8),view=new DataView(data);view.setUint32(0,Math.floor(counter/0x100000000));view.setUint32(4,counter>>>0);const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,data));const offset=digest[digest.length-1]&15;const n=((digest[offset]&127)<<24)|((digest[offset+1]&255)<<16)|((digest[offset+2]&255)<<8)|(digest[offset+3]&255);return String(n%1000000).padStart(6,'0')};
const validTotp=async(secret:string,code:string)=>{if(!/^\d{6}$/.test(code))return false;const counter=Math.floor(Date.now()/30000);for(const delta of [-1,0,1])if(await hotp(secret,counter+delta)===code)return true;return false};

export default function Auth({onBack,onSuccess,initialMode='signup'}:{onBack:()=>void;onSuccess:()=>void;initialMode?:'signup'|'signin'}) {
  const [mode,setMode]=useState<'signup'|'signin'>(initialMode);
  const [step,setStep]=useState<SignupStep>(1);
  const [loginStep,setLoginStep]=useState<LoginStep>('credentials');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [password2,setPassword2]=useState('');
  const [emailCode,setEmailCode]=useState('');
  const [authCode,setAuthCode]=useState('');
  const [fullName,setFullName]=useState('');
  const [phone,setPhone]=useState('');
  const [legalName,setLegalName]=useState('');
  const [dob,setDob]=useState('');
  const [nationality,setNationality]=useState('Bangladesh');
  const [occupation,setOccupation]=useState('');
  const [documentType,setDocumentType]=useState('National ID');
  const [documentNumber,setDocumentNumber]=useState('');
  const [documentCountry,setDocumentCountry]=useState('Bangladesh');
  const [address,setAddress]=useState('');
  const [city,setCity]=useState('');
  const [region,setRegion]=useState('');
  const [postal,setPostal]=useState('');
  const [taxResidence,setTaxResidence]=useState('Bangladesh');
  const [userId,setUserId]=useState<string|null>(null);
  const [mfaSecret,setMfaSecret]=useState('');
  const [mfaQr,setMfaQr]=useState('');
  const [mfaCode,setMfaCode]=useState('');
  const [loginMfaSecret,setLoginMfaSecret]=useState('');
  const [loginUserId,setLoginUserId]=useState<string|null>(null);
  const [googleSignup,setGoogleSignup]=useState(false);
  const passwordProblems=useMemo(()=>passwordIssues(password),[password]);

  useEffect(()=>{void (async()=>{const {data}=await supabase.auth.getSession();if(data.session?.user){setUserId(data.session.user.id);setEmail(data.session.user.email??'');const pending=window.localStorage.getItem('paywai_google_signup')==='1';if(pending){window.localStorage.removeItem('paywai_google_signup');setGoogleSignup(true);const name=data.session.user.user_metadata?.full_name??data.session.user.user_metadata?.name??'';if(name){setFullName(name);setLegalName(name);}setNotice('Google verified your email. Now create your Paywai password to continue.');}}})().catch(()=>undefined);},[]);

  const go=(next:SignupStep)=>{setError('');setNotice('');setStep(next);window.scrollTo({top:0,behavior:'smooth'})};

  const startGoogleSignup=async()=>{if(!supabaseConfigured){setError('Account creation is not configured on this deployment yet.');return}setBusy(true);setError('');window.localStorage.setItem('paywai_google_signup','1');const {error:e}=await supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin}});if(e){window.localStorage.removeItem('paywai_google_signup');setBusy(false);setError(e.message)}};

  const sendSignupCode=async()=>{const {error:e}=await supabase.auth.resend({type:'signup',email:email.trim()});if(e)throw e};

  const completeGooglePassword=async()=>{if(!userId){setError('Your Google sign-in session could not be found. Please start again.');return}if(passwordProblems.length){setError(`Your password needs ${passwordProblems.join(', ')}.`);return}if(password!==password2){setError('The two passwords do not match.');return}setBusy(true);setError('');const {error:e}=await supabase.auth.updateUser({password});if(e){setBusy(false);setError(e.message);return}await recordAudit(userId,'onboarding.google_password_set','auth');setBusy(false);go(3)};

  const createAccount=async()=>{
    if(!supabaseConfigured){setError('Account creation is not configured on this deployment yet.');return}
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){setError('Enter a valid email address.');return}
    if(passwordProblems.length){setError(`Your password needs ${passwordProblems.join(', ')}.`);return}
    if(password!==password2){setError('The two passwords do not match.');return}
    setBusy(true);setError('');
    const {data,error:e}=await supabase.auth.signUp({email:email.trim(),password,options:{data:{country:'Bangladesh',account_type:'personal'},emailRedirectTo:window.location.origin}});
    if(e){setBusy(false);setError(e.message.toLowerCase().includes('already')?'An account already exists for this email. Sign in instead.':e.message);return}
    if(!data.user){setBusy(false);setError('We could not create the account. Please try again.');return}
    setUserId(data.user.id);setEmail(data.user.email??email.trim());
    go(2);
    setBusy(false);
  };

  const verifySignupEmail=async()=>{
    if(!/^\d{6,8}$/.test(emailCode.trim())){setError('Enter the verification code from your email.');return}
    setBusy(true);setError('');
    const {data,error:e}=await supabase.auth.verifyOtp({email:email.trim(),token:emailCode.trim(),type:'email'});
    if(e){setBusy(false);setError('That verification code is incorrect or expired.');return}
    if(data.user)setUserId(data.user.id);
    setBusy(false);go(3);
  };

  const resendSignupCode=async()=>{setBusy(true);setError('');try{await sendSignupCode();setNotice('A new verification code has been sent to your email.');}catch(e){setError((e as Error).message||'Could not send a new code.');}finally{setBusy(false)}};

  const persistDetails=async()=>{
    if(!userId||!fullName.trim()){setError('Enter your full legal name.');return}
    if(!/^\+?[\d\s()-]{7,}$/.test(phone.trim())){setError('Enter a valid mobile number including the country code.');return}
    setBusy(true);setError('');
    try{await saveProfile(userId,{account_type:'personal',country:'Bangladesh',full_name:fullName.trim(),phone:phone.trim(),business_name:null,business_type:null,business_category:null,onboarding_status:'details_pending'});await recordAudit(userId,'onboarding.details_saved','profile');go(4)}catch(e){setError((e as Error).message||'We could not save your details.')}finally{setBusy(false)}
  };

  const persistIdentity=async()=>{
    if(!userId||!legalName.trim()||!dob||!documentNumber.trim()||!occupation.trim()){setError('Legal name, date of birth, document number and occupation are required.');return}
    setBusy(true);setError('');
    try{await saveKyc(userId,{legal_name:legalName.trim(),date_of_birth:dob,nationality,occupation:occupation.trim(),document_type:documentType,document_number:documentNumber.trim(),document_country:documentCountry,status:'draft'});await saveProfile(userId,{onboarding_status:'kyc_pending'});await recordAudit(userId,'onboarding.identity_saved','kyc_application');go(5)}catch(e){setError((e as Error).message||'We could not save your identity details.')}finally{setBusy(false)}
  };

  const persistResidence=async()=>{
    if(!userId||!address.trim()||!city.trim()||!postal.trim()){setError('Street address, city and postal code are required.');return}
    setBusy(true);setError('');
    try{await saveKyc(userId,{address_line1:address.trim(),city:city.trim(),region:region.trim(),postal_code:postal.trim(),tax_residence:taxResidence});await recordAudit(userId,'onboarding.residence_saved','kyc_application');await setupAuthenticator();go(6)}catch(e){setError((e as Error).message||'We could not save your address.')}finally{setBusy(false)}
  };

  const setupAuthenticator=async()=>{
    if(!userId)return;
    const secret=makeSecret();
    const issuer='Paywai';
    const label=`Paywai:${email.trim()}`;
    const uri=`otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    const qr=await QRCode.toDataURL(uri,{width:220,margin:1});
    setMfaSecret(secret);setMfaQr(qr);setMfaCode('');
  };

  const verifyAuthenticator=async()=>{
    if(!userId||!mfaSecret){setError('Generate the authenticator setup first.');return}
    setBusy(true);setError('');
    try{if(!(await validTotp(mfaSecret,mfaCode.trim())))throw new Error('That authenticator code is incorrect or expired.');await saveSecurity(userId,{mfa_secret:mfaSecret,mfa_enabled:true});await recordAudit(userId,'security.mfa_enabled','security_settings');await finishAccount(true)}catch(e){setError((e as Error).message||'Could not enable the authenticator.')}finally{setBusy(false)}
  };

  const skipAuthenticator=async()=>{if(!userId)return;setBusy(true);setError('');try{await saveSecurity(userId,{mfa_secret:null,mfa_enabled:false});await recordAudit(userId,'security.mfa_skipped','security_settings');await finishAccount(false)}catch(e){setError((e as Error).message||'Could not finish account setup.')}finally{setBusy(false)}};

  const finishAccount=async(mfa:boolean)=>{
    if(!userId)return;
    await saveKyc(userId,{status:'submitted',submitted_at:new Date().toISOString()});
    await saveProfile(userId,{onboarding_status:'submitted'});
    await ensureLedgerAccount(userId,'USD');
    await recordAudit(userId,'onboarding.submitted','kyc_application',userId,{mfaEnabled:mfa});
    go(7);
  };

  const startLogin=async()=>{
    if(!email.trim()||!password){setError('Enter your email address and password.');return}
    setBusy(true);setError('');
    const {data,error:e}=await supabase.auth.signInWithPassword({email:email.trim(),password});
    if(e){setBusy(false);setError(e.message.toLowerCase().includes('not confirmed')?'Verify your email address first.':'That email and password combination is not correct.');return}
    if(!data.user){setBusy(false);setError('Sign in could not be completed.');return}
    const id=data.user.id;setLoginUserId(id);
    const security=await loadSecurity(id).catch(()=>null);
    await supabase.auth.signOut();
    try{const {error:otpError}=await supabase.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:false}});if(otpError)throw otpError}catch(e){setBusy(false);setError((e as Error).message||'We could not send your email verification code.');return}
    setLoginMfaSecret(security?.mfa_enabled&&security.mfa_secret?security.mfa_secret:'');
    setLoginStep('email');setBusy(false);
  };

  const verifyLoginEmail=async()=>{
    if(!/^\d{6,8}$/.test(emailCode.trim())){setError('Enter the verification code from your email.');return}
    if(!loginUserId){setError('Your login session expired. Start again.');return}
    setBusy(true);setError('');
    const {data,error:e}=await supabase.auth.verifyOtp({email:email.trim(),token:emailCode.trim(),type:'email'});
    if(e){setBusy(false);setError('That verification code is incorrect or expired.');return}
    if(!data.user){setBusy(false);setError('Email verification did not complete.');return}
    if(loginMfaSecret){setLoginStep('authenticator');setBusy(false);return}
    onSuccess();
  };

  const verifyLoginAuthenticator=async()=>{
    if(!loginMfaSecret){onSuccess();return}
    setBusy(true);setError('');
    if(!(await validTotp(loginMfaSecret,authCode.trim()))){setBusy(false);setError('That authenticator code is incorrect or expired.');return}
    await recordAudit(loginUserId??'', 'auth.mfa_verified','security_settings',loginUserId??undefined);
    setBusy(false);onSuccess();
  };

  const resendLoginCode=async()=>{setBusy(true);setError('');try{const {error:e}=await supabase.auth.signInWithOtp({email:email.trim(),options:{shouldCreateUser:false}});if(e)throw e;setNotice('A new verification code has been sent.')}catch(e){setError((e as Error).message||'Could not send a new code.')}finally{setBusy(false)}};

  const back=()=>{if(step===1){setGoogleSignup(false);setNotice('');setError('');return onBack();}if(step===2)return go(1);if(step===3)return go(1);if(step===4)return go(3);if(step===5)return go(4);if(step===6)return go(5);return go(1)};

  if(mode==='signin')return <AuthShell onBack={onBack} title={loginStep==='credentials'?'Welcome back':loginStep==='email'?'Verify your email':'Authenticator verification'} kicker="SIGN IN TO PAYWAI" step={loginStep==='credentials'?'01 / 03':loginStep==='email'?'02 / 03':'03 / 03'}>
    {loginStep==='credentials'&&<Panel title="Email and password" text="Enter your Paywai email and password first. We will then send a one-time code to your email."><Field label="Email address"><input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></Field><Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Your password"/></Field>{error&&<div className="error-note">{error}</div>}<button className="primary auth-submit" onClick={startLogin} disabled={busy}>{busy?'Checking…':'Continue'} <ArrowRight size={15}/></button></Panel>}
    {loginStep==='email'&&<Panel title="Enter your email code" text={`We sent a verification code to ${email}. Enter it here to continue.`}><Field label="Email verification code"><input className="otp-input" inputMode="numeric" maxLength={8} value={emailCode} onChange={e=>setEmailCode(e.target.value.replace(/\D/g,''))} placeholder="123456"/></Field>{notice&&<div className="success-note">{notice}</div>}{error&&<div className="error-note">{error}</div>}<button className="primary auth-submit" onClick={verifyLoginEmail} disabled={busy}>{busy?'Verifying…':'Verify email'} <ArrowRight size={15}/></button><button className="resend" onClick={resendLoginCode} disabled={busy}>Send a new code</button></Panel>}
    {loginStep==='authenticator'&&<Panel title="Enter your authenticator code" text="Open Google Authenticator or your chosen authenticator app and enter the current 6-digit code."><Field label="Authenticator code"><input className="otp-input" inputMode="numeric" maxLength={6} value={authCode} onChange={e=>setAuthCode(e.target.value.replace(/\D/g,''))} placeholder="000000"/></Field>{error&&<div className="error-note">{error}</div>}<button className="primary auth-submit" onClick={verifyLoginAuthenticator} disabled={busy}>{busy?'Verifying…':'Verify and sign in'} <Check size={15}/></button></Panel>}
    <AuthFooter onBack={onBack} onSignup={()=>{setError('');setLoginStep('credentials');setMode('signup');setStep(1)}}/>
  </AuthShell>;

  if(step===7)return <AuthShell onBack={onBack} title="Your account was created successfully" kicker="PAYWAI ACCOUNT READY" step="07 / 07"><Panel title="Account successfully created" text="Your Paywai account has been created. You can now go to your dashboard."><button className="primary auth-submit" onClick={onSuccess}>Go to dashboard <ArrowRight size={15}/></button></Panel><div className="onboarding-foot"><Lock size={13}/> Your security settings are saved to your account.</div></AuthShell>;

  return <AuthShell onBack={onBack} title={step===1&&googleSignup?'Set your Paywai password':STEP_TITLES[step]} kicker="OPEN A PAYWAI ACCOUNT" step={`${String(step).padStart(2,'0')} / 07`}>
    <div className="progress-track"><i style={{width:`${(step/7)*100}%`}}/></div>
    {step===1&&<Panel title={googleSignup?'Create your Paywai password':'Create your account'} text={googleSignup?'Your Google account has verified your email. Set the password you will use for Paywai sign-in.':'Choose Google or continue manually with your email address and password.'}>{googleSignup?<><Field label="Verified Google email"><input type="email" value={email} readOnly/></Field><Field label="Paywai password"><input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Create a strong password"/></Field><Field label="Confirm password"><input type="password" autoComplete="new-password" value={password2} onChange={e=>setPassword2(e.target.value)} placeholder="Repeat your password"/></Field>{notice&&<div className="success-note">{notice}</div>}{error&&<div className="error-note">{error}</div>}<Actions back={onBack} next={completeGooglePassword} busy={busy} label="Set password and continue"/></>:<><button type="button" className="google-button" onClick={startGoogleSignup} disabled={busy}><span className="google-mark">G</span><span>Continue with Google</span></button><div className="auth-divider"><span>OR</span></div><Field label="Email address"><input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></Field><Field label="Password"><input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Create a password"/></Field><Field label="Confirm password"><input type="password" autoComplete="new-password" value={password2} onChange={e=>setPassword2(e.target.value)} placeholder="Repeat your password"/></Field><div className="notice"><Lock size={15}/><span>At least 8 characters with an uppercase letter, a lowercase letter and a number.</span></div>{error&&<div className="error-note">{error}</div>}<Actions back={onBack} next={createAccount} busy={busy} label="Create account"/></>}</Panel>}
    {step===2&&<Panel title="Verify your email" text={`We sent a one-time verification code to ${email}. Enter the code here; no confirmation link is required.`}><Field label="Email verification code"><input className="otp-input" inputMode="numeric" maxLength={8} value={emailCode} onChange={e=>setEmailCode(e.target.value.replace(/\D/g,''))} placeholder="123456"/></Field>{notice&&<div className="success-note">{notice}</div>}{error&&<div className="error-note">{error}</div>}<button className="primary auth-submit" onClick={verifySignupEmail} disabled={busy}>{busy?'Verifying…':'Verify email'} <ArrowRight size={15}/></button><button className="resend" onClick={resendSignupCode} disabled={busy}>Send a new code</button></Panel>}
    {step===3&&<Panel title="Your personal details" text="Use your legal information so your Paywai profile can be reviewed accurately."><Field label="Full legal name"><input value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="First and last name"/></Field><Field label="Mobile number"><input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+880 1XXX XXXXXX"/></Field>{error&&<div className="error-note">{error}</div>}<Actions back={()=>go(1)} next={persistDetails} busy={busy} label="Save and continue"/></Panel>}
    {step===4&&<Panel title="Identity document" text="Enter the details exactly as they appear on your passport or national ID."><Field label="Legal full name"><input value={legalName} onChange={e=>setLegalName(e.target.value)} placeholder="Exactly as shown on your ID"/></Field><div className="form-grid"><Field label="Date of birth"><input type="date" value={dob} onChange={e=>setDob(e.target.value)}/></Field><Field label="Nationality"><select value={nationality} onChange={e=>setNationality(e.target.value)}>{COUNTRIES.map(c=><option key={c}>{c}</option>)}</select></Field><Field label="Document type"><select value={documentType} onChange={e=>setDocumentType(e.target.value)}><option>National ID</option><option>Passport</option><option>Driver's license</option></select></Field><Field label="Document country"><select value={documentCountry} onChange={e=>setDocumentCountry(e.target.value)}>{COUNTRIES.map(c=><option key={c}>{c}</option>)}</select></Field></div><Field label="Document number"><input value={documentNumber} onChange={e=>setDocumentNumber(e.target.value)} placeholder="Enter the number on the document"/></Field><Field label="Occupation"><input value={occupation} onChange={e=>setOccupation(e.target.value)} placeholder="Occupation or profession"/></Field><div className="notice"><FileCheck2 size={15}/><span>Document authenticity and liveness checks can be performed by the identity provider before approval.</span></div>{error&&<div className="error-note">{error}</div>}<Actions back={()=>go(3)} next={persistIdentity} busy={busy} label="Save and continue"/></Panel>}
    {step===5&&<Panel title="Residential address" text="Use the address where you currently live."><Field label="Street address"><input value={address} onChange={e=>setAddress(e.target.value)} placeholder="House, street and area"/></Field><div className="form-grid"><Field label="City"><input value={city} onChange={e=>setCity(e.target.value)} placeholder="City"/></Field><Field label="State or region"><input value={region} onChange={e=>setRegion(e.target.value)} placeholder="State or region"/></Field><Field label="Postal code"><input value={postal} onChange={e=>setPostal(e.target.value)} placeholder="Postal code"/></Field><Field label="Tax residence"><select value={taxResidence} onChange={e=>setTaxResidence(e.target.value)}>{COUNTRIES.map(c=><option key={c}>{c}</option>)}</select></Field></div>{error&&<div className="error-note">{error}</div>}<Actions back={()=>go(4)} next={persistResidence} busy={busy} label="Continue to security"/></Panel>}
    {step===6&&<Panel title="Set up your authenticator app" text="This is optional. Scan the QR code with Google Authenticator, Microsoft Authenticator or another compatible app, or enter the setup key manually."><div className="mfa-setup">{mfaQr&&<img className="mfa-qr" src={mfaQr} alt="Authenticator setup QR code"/>}<div className="mfa-secret"><span>Manual setup key</span><strong>{mfaSecret}</strong></div><Field label="6-digit authenticator code"><input className="otp-input" inputMode="numeric" maxLength={6} value={mfaCode} onChange={e=>setMfaCode(e.target.value.replace(/\D/g,''))} placeholder="000000"/></Field></div>{error&&<div className="error-note">{error}</div>}<div className="onboarding-actions"><button className="secondary" onClick={skipAuthenticator} disabled={busy}>Skip for now</button><button className="primary" onClick={verifyAuthenticator} disabled={busy}>{busy?'Saving…':'Continue and enable'} <Check size={15}/></button></div><div className="notice"><Smartphone size={15}/><span>If you skip, you can set up your authenticator later from the dashboard security settings.</span></div></Panel>}
    <div className="onboarding-foot"><Lock size={13}/> Paywai staff will never ask you for your password or a login code.</div>
  </AuthShell>;
}

function AuthShell({children,onBack,title,kicker,step}:{children:React.ReactNode;onBack:()=>void;title:string;kicker:string;step:string}){return <div className="auth-page onboarding-page"><div className="auth-side onboarding-side"><button className="brand" onClick={onBack}><span className="brand-mark"><Shield size={17}/></span><span><span className="brand-name light">PAYWAI</span><span className="brand-sub light">PRIVATE FINANCIAL INFRASTRUCTURE</span></span></button><div className="onboarding-side-copy"><div className="eyebrow pale">SECURE ACCOUNT ACCESS</div><h1>Your money. <em>One clear view.</em></h1><p>Protect your account with email verification and optional authenticator-based security.</p><div className="onboarding-assurance"><div><Shield size={16}/><span><b>Protected sign-in</b><small>Email verification before access</small></span></div><div><Lock size={16}/><span><b>Authenticator ready</b><small>Optional additional sign-in protection</small></span></div></div></div></div><div className="auth-form-wrap"><div className="onboarding-form"><div className="mobile-auth-logo"><button className="brand" onClick={onBack}><span className="brand-mark"><Shield size={17}/></span><span><span className="brand-name">PAYWAI</span><span className="brand-sub">PRIVATE FINANCIAL INFRASTRUCTURE</span></span></button></div><div className="onboarding-head"><div><div className="auth-kicker">{kicker}</div><h2>{title}</h2></div><span className="step-count">{step}</span></div>{children}</div></div></div>}

function Panel({children,title,text}:{children:React.ReactNode;title:string;text:string}){return <div className="verification-panel"><b>{title}</b><p>{text}</p>{children}</div>}
function Field({label,children}:{label:string;children:React.ReactNode}){return <label>{label}{children}</label>}
function Actions({back,next,busy,label}:{back:()=>void;next:()=>void;busy:boolean;label:string}){return <div className="onboarding-actions"><button className="secondary" onClick={back} disabled={busy}>Back</button><button className="primary" onClick={next} disabled={busy}>{busy?'Saving…':label} <ArrowRight size={15}/></button></div>}
function AuthFooter({onBack,onSignup}:{onBack:()=>void;onSignup:()=>void}){return <><div className="onboarding-actions"><button className="secondary" onClick={onBack}><ArrowLeft size={15}/> Back to website</button><button className="secondary" onClick={onSignup}>Create an account</button></div><div className="onboarding-foot"><Lock size={13}/> Paywai staff will never ask you for your password or a login code.</div></>}
