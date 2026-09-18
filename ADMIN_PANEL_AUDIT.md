# Paywai Admin Panel — Full Architecture & Security Audit

Audit date: 2026-09-18

## Executive finding

The previous AdminPanel in `src/Demo.tsx` was primarily an investor/demo control surface. It contained Overview, Users, Transactions, Compliance, Settings and TEST INF labels, but most operational modules were not implemented as real administration workflows.

The secret URL also had an unnecessary second authentication layer: after the private password gate, `AdminGate` required a Supabase customer session and an `admin_users` row. That is why the private URL could send the operator to the normal customer Login page.

## Changes implemented in this audit

1. The secret admin password gate now opens the AdminPanel directly after successful authentication.
2. The normal `/admin` route remains unavailable.
3. The AdminPanel UI was expanded into a banking operations workspace with:
   - Executive dashboard
   - Customer/user administration
   - KYC & compliance
   - Transaction and ledger monitoring
   - Risk & fraud
   - Maker/checker approvals
   - Audit & security
   - Management reports
   - Access control / RBAC model
   - TEST INF investor environment
   - System settings
4. Mobile/tablet layouts were added for the admin console.
5. Browser clients can no longer directly insert transaction rows.
6. Browser clients can no longer directly update ledger balances.
7. Audit writes now go through a narrowly scoped database function.
8. Ledger-account creation now goes through a narrowly scoped database function.
9. Customer KYC status is protected from self-approval/self-rejection.

## Critical architecture gaps that remain before calling this a real banking back-office

### 1. Server-side admin data plane

A production admin panel must not read all customer/financial records directly from the browser. The current Supabase RLS model is intentionally user-scoped.

The next production layer should be:

Browser
-> private admin session
-> server-side admin API
-> server-side authorization/RBAC
-> Supabase secret key
-> database

The Supabase secret key must never be bundled into browser code.

### 2. Admin authentication

The current private gate uses a fixed password and IPv4 allowlist in `api/admin-gate.ts`.

For production:
- move the password to a Vercel server environment secret;
- add rate limiting / lockout;
- require MFA for privileged access;
- record successful and failed admin logins;
- support session revocation;
- avoid relying on a single public IPv4 address as the primary authorization mechanism.

### 3. RBAC and segregation of duties

Required roles should include at least:
- Super Administrator
- Admin Maker
- Admin Checker
- Operations Manager
- Compliance/KYC Officer
- Risk/Fraud Analyst
- Support Officer
- Read-only Auditor

Permissions must be action-level, not just page-level.

A maker must not approve their own sensitive change.

### 4. Financial transaction controls

Real financial writes must be server-side and ledger-based.

The browser must never be allowed to:
- change balances;
- create a settled transaction;
- change transaction status to authorized/settled;
- change settlement references;
- create arbitrary financial entries.

All material financial operations should use:
- idempotency keys;
- transaction references;
- authorization levels;
- maker/checker;
- limits;
- immutable event history;
- reconciliation.

### 5. KYC/AML

A serious banking/fintech admin needs:
- KYC review queue;
- document review;
- customer risk profile;
- enhanced due diligence;
- sanctions/PEP screening;
- suspicious transaction alerts;
- case management;
- escalation/SLA;
- reviewer decision history;
- before/after audit evidence.

### 6. Reconciliation

The current schema is not a complete banking ledger/reconciliation system.

Production architecture needs:
- double-entry ledger;
- journal entries;
- settlement accounts;
- pending/authorized/settled/reversed states;
- reconciliation queues;
- unmatched-item aging;
- reversal/chargeback workflows;
- daily close controls.

### 7. Audit trail

Audit should be append-only and server generated.

Each privileged event should record at minimum:
- actor;
- role;
- timestamp;
- source IP/session;
- action;
- target entity;
- before state;
- after state;
- approval chain;
- correlation/reference ID;
- result/failure.

### 8. Operations and resilience

Add:
- service health;
- queue monitoring;
- webhook/event monitoring;
- failed settlement queue;
- backups;
- restore testing;
- incident log;
- operational alerts;
- maintenance controls;
- session/device monitoring.

## Regulatory design reference

Bangladesh Bank's 2024 CBS Features and Controls document calls for RBAC/least privilege, segregation of duties, transaction monitoring, audit trails, session logging, real-time monitoring, authorization review and maker-checker controls. It also describes dual control for administrator activities and detailed audit journals.

This is an architecture reference for the product design, not a statement that Paywai is a licensed bank or currently compliant.

## Current maturity

The UI is now suitable as a serious investor/operations prototype.

It should NOT yet be represented as a production banking core or regulated banking system. The remaining work is primarily the server-side authorization/data plane, real ledger model, compliance integrations, and operational controls.

## Important source files

- `src/App.tsx` — private route and password gate
- `src/Demo.tsx` — admin/investor UI
- `src/demo.css` — admin UI styling
- `api/admin-gate.ts` — private access gate
- `src/lib/account.ts` — customer data access
- `supabase/schema.sql` — core data model
- `supabase/migrations/20260918090000_harden_user_financial_writes.sql` — client-write hardening

## Final implementation rule

Never solve an admin-security problem only by hiding a route or adding a client-side check. Every privileged financial operation must be enforced server-side/database-side as well.
