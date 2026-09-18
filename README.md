# Paywai

**Global payments, balances and cards in one account.**

Paywai is a payments platform for people and businesses that work across borders. It brings together
the way you get paid, hold funds and spend, so the money you earn abroad is usable without waiting
weeks or juggling several providers.

The product direction is a single account for the whole flow:

**Create account → Verify identity → Add a funding method → Deposit → Hold → Receive → Send → Spend → Withdraw**

---

## What works today

This repository is the Paywai web application. The account layer is real and runs on Supabase:

- **Email and password registration** with email confirmation
- **Sign in, sign out and password reset**
- **Persistent onboarding** across four steps: account type, identity details, residence, review
- **Personal and business** account paths, each collecting the fields that path requires
- **Identity (KYC) application** stored and submitted for review
- **Per-user ledger accounts** created in the currencies you hold
- **Transaction password** — a separate secret that authorises sensitive transfers
- **Two-factor authentication** via any TOTP authenticator app
- **Audit trail** — sensitive actions are written to an audit history

Everything is protected by Postgres row-level security. A user can only ever read or write rows that
belong to their own account, and anonymous access is denied at the database level rather than in the
client.

## What is not wired up yet

Payments, cards, funding rails and payouts need real provider integrations, agreements and licences.
Those areas deliberately show no balances, transactions or figures, because fabricated financial data
is worse than an honest empty state.

The roadmap below is direction, not a claim of current connectivity.

---

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase values
npm run dev
```

Build and type-check:

```bash
npm run typecheck
npm run build
```

### Required environment variables

| Variable                   | Where to find it                                      |
| -------------------------- | ----------------------------------------------------- |
| `VITE_SUPABASE_URL`        | Supabase → Project Settings → API → Project URL        |
| `VITE_SUPABASE_ANON_KEY`   | Supabase → Project Settings → API → anon/public key    |

Set the same two variables in your hosting provider (for Vercel: Project → Settings → Environment
Variables). The publishable/anon key is designed for browser use and is safe to expose; row-level
security is what protects the data.

### Database setup

The schema lives in [`supabase/schema.sql`](supabase/schema.sql). Apply it once to a new Supabase
project to create the tables, row-level security policies, the signup trigger that provisions a
profile for every new user, and the `updated_at` triggers.

Tables:

| Table                | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `profiles`           | Account identity: type, country, contact, onboarding status     |
| `kyc_applications`   | Identity verification data and its review status                |
| `security_settings`  | Transaction password hash and authenticator enrolment           |
| `ledger_accounts`    | Per-currency balances for a user                                |
| `transactions`       | Payment records                                                  |
| `audit_events`       | Immutable record of sensitive account actions                   |

In Supabase, also set **Authentication → URL Configuration → Site URL** to your production domain
and add your deployment domains to the redirect allow-list, otherwise confirmation and reset emails
will point at the wrong host.

---

## Registration flow

Financial regulation requires identity checks, so Paywai collects them once, upfront, in the order
established platforms use:

1. **Create account** — country, email, password. A confirmation link verifies the email address.
2. **Account** — personal or business, name, contact number, and business details when applicable.
3. **Identity** — legal name, date of birth, nationality, occupation, document type and number.
4. **Residence** — residential address and country of tax residence.
5. **Review and submit** — the application goes to identity review.

Transaction passwords and two-factor authentication are **not** part of sign-up. Asking a brand new
user to invent an extra password and scan a QR code before they have seen the product adds friction
and confusion without adding trust. Both are configured afterwards, from **Settings**, where they
protect the actions they actually guard.

---

## Project structure

```
src/
  App.tsx                 Session routing: landing, auth, onboarding, dashboard
  components/Brand.tsx    Wordmark and mark
  lib/
    supabase.ts           Supabase client
    account.ts            Data access for profiles, KYC, ledger, audit
    security.ts           PBKDF2 hashing, TOTP, password policy
  pages/
    Landing.tsx           Public site
    Auth.tsx              Sign in, sign up, verify email, reset password
    Onboarding.tsx        Four-step account opening
    Dashboard.tsx         Account workspace
    SecurityPanel.tsx     Transaction password and 2FA management
  styles.css              Design tokens and all component styles
supabase/schema.sql       Database schema, RLS policies and triggers
backend/index.ts          Legacy AppDeploy-style API, kept for reference
```

`backend/index.ts` is the previous server-side draft of these same flows. The application now talks
to Supabase directly with RLS enforcing authorisation, so that file is retained only as a reference
and is not built or deployed.

---

## Security model

- Row-level security on every table; policies scope rows to `auth.uid()`.
- Anonymous and cross-user reads are denied by the database, not by the UI.
- The transaction password is stored as a PBKDF2-SHA256 hash (210,000 iterations, per-user random
  salt). Plaintext passwords are never stored or logged.
- TOTP secrets are verified against a ±1 step window to tolerate clock drift.
- Email ownership is confirmed before an account becomes usable.
- Sensitive actions are recorded in `audit_events`.

### Reporting a problem

If you find a security issue, do not open a public issue. Contact the maintainer directly.

---

## Roadmap

**Phase 1 — Account foundation (current)**
Secure web application, authentication, onboarding, KYC capture, ledger foundation, audit history.

**Phase 2 — Financial connectivity**
Banking integrations, card issuing partners, payment gateways, deposit and withdrawal rails.

**Phase 3 — Expansion**
Country-by-country integrations, local payment systems, cross-border transfers, merchant
connectivity.

**Phase 4 — Platform**
Unified payment orchestration, advanced risk systems, business finance, commerce connectivity.

Availability of any rail, country or card programme depends on real technical integrations, provider
agreements, licensing, compliance and regulated partners. A country appearing on the roadmap does not
mean it is supported.

---

## Status

Paywai is a prototype. It is not a licensed financial institution and does not offer financial
services. Nothing in this repository should be treated as an offer of banking, payment or card
services.

**Paywai — one account for global money movement.**
