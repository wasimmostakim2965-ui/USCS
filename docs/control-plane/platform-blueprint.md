# USCS প্ল্যাটফর্ম ব্লুপ্রিন্ট

**স্থিতি:** গবেষণা-ভিত্তিক প্রস্তাবিত নকশা  
**পরিধি:** USCS-এর workspace, project, deployment, backend resource, security এবং observability control plane  
**ভাষা:** বাংলা

## নির্বাহী উপসংহার

USCS-এর জন্য সবচেয়ে উপযোগী মডেল হলো **দুই-স্তরের, project-centric control plane**: উপরিভাগে workspace বা account governance, এবং তার নিচে application/project operations। Vercel-এর project/deployment-কেন্দ্রিকতা, Supabase-এর project-এর ভিতরে service-oriented backend workspace, এবং Cloudflare-এর account-to-zone scope model—এই তিনটির সমন্বিত পাঠ থেকে একটি নীতি স্পষ্ট হয়: ব্যবহারকারীকে প্রতিটি কাজের সময় **কোন workspace, কোন project এবং কোন resource-এ কাজ হচ্ছে** তা দৃশ্যমানভাবে জানতে হবে। Vercel project-কে deployment, domain, environment, settings ও telemetry-এর কেন্দ্র করে [1] [2]; Supabase project-কে Postgres, Auth, Storage, Functions ও Logs-এর operational boundary করে [11] [12]; Cloudflare account-কে সদস্য, zone, token ও audit-এর governance boundary করে [23] [24]।

USCS তাই একদিকে নতুন deployment-এর preview URL, promote, rollback, logs এবং environment-scoped secrets দেবে; অন্যদিকে database, API, files, functions, analytics ও audit-এর জন্য একই workspace/project context বজায় রাখবে। কিন্তু কোনো একটি reference product-এর সম্পূর্ণ breadth নকল করা হবে না। Vercel-এর অতিরিক্ত developer density, Supabase-এর Dashboard-only code editing, এবং Cloudflare-এর দীর্ঘ product taxonomy—তিনটিই USCS-এর প্রথম সংস্করণে সীমিত বা progressive disclosure-এর আড়ালে থাকবে।

প্রথম release-এর সফলতার মাপকাঠি হবে feature-count নয়, বরং পাঁচটি operational outcome: **(১) বর্তমান production অবস্থা দ্রুত বোঝা, (২) নিরাপদে deploy ও rollback করা, (৩) একই context-এ incident debug করা, (৪) permission ও secret-এর সীমা পরিষ্কার রাখা, এবং (৫) UI, API ও Git-backed workflow-কে একই domain model-এ রাখা।** গবেষণায় কোনো USCS-specific API contract, data-retention policy, compliance target, cloud provider বা open-source license সিদ্ধান্ত পাওয়া যায়নি। সেসব বিষয়কে এখানে **অনির্ধারিত সিদ্ধান্ত** হিসেবে চিহ্নিত করা হলো; সেগুলোর জন্য placeholder বা fake capability তৈরি করা যাবে না।

## ১. তিনটি reference platform-এর তুলনা

| মাত্রা | Vercel Dashboard | Supabase Studio | Cloudflare Dashboard | USCS-এর সিদ্ধান্ত |
|---|---|---|---|---|
| মূল product model | Team-scoped deployed web application control plane | Project-scoped managed Postgres backend control plane | User → account → zone control plane | Workspace → project → resource; deployment এবং backend resource একই project context-এ |
| প্রধান object | Project, deployment, domain, environment variable | Project, schema/table, Auth user, bucket, function, log | Account, zone, DNS record, rule, Worker, dashboard | Workspace, project, deployment, environment, service resource, audit event |
| প্রধান শক্তি | Preview URL, promote, rollback, deployment-centric operations; project overview-তে live state দেখা যায় [1] [3] | Database/RLS/API coupling, code-first parity, service-specific Logs ও function test surface [11] [12] [13] | Explicit scope, fine-grained policies, synchronized analytics, review step, audit/resource history [23] [24] [25] | তিনটির শক্তি একত্র করা; scope, state, security ও traceability-কে default করা |
| Navigation | Persistent project sidebar; team settings আলাদা | Project sidebar; Database/Auth/Storage/Functions/Logs | Scope বদলালে sidebar বদলায়; account ও zone আলাদা | Context switcher + task-based sidebar; একই resource দুবার তালিকাভুক্ত নয় |
| Observability | Live/searchable request logs, filters, detail pane, deep link [7] | Service logs, time range, raw JSON, Live, export, drains [17] | Aggregate analytics থেকে raw logs ও audit history-তে drill-down [26] | এক unified event explorer; provenance, freshness, sampling এবং retention দৃশ্যমান |
| Deployment | Git, CLI, Drop, Deploy Hook, REST; preview-to-production, redeploy, rollback | Git/CLI/migrations, branch preview, Edge Functions | Git import, build queue, workers.dev preview | Git-backed, asynchronous deployment state machine; UI/API/CLI parity |
| Configuration | Team/project inheritance; environment এবং branch targeting; secret write-only [6] | Database policy, keys, function secrets, Storage restrictions | Token templates, scope, IP/TTL, one-time secret display [27] | Config বনাম Secret আলাদা; scope, version, rotation এবং audit বাধ্যতামূলক |
| Authorization | Team membership, project roles, deployment protection | Postgres roles/grants/RLS ও project entitlement | User/account/zone permission groups ও resource scope | Workspace/project/resource scope; server-side enforcement এবং UI capability state |
| Safety | Typed-name confirmation, reversible pause banner [2] | RLS dependency, storage ownership, token expiry সতর্কতা | Review-before-submit, ordered rules, token verification | Impact preview, dependency check, typed confirmation, idempotency এবং rollback |
| যে pattern নকল করা হবে না | Unbounded sidebar ও jargon density | Version-controlহীন production code editor | Product breadth, opaque plan differences, ambiguous scope | Task-based IA, progressive disclosure এবং role-aware labels |

**সীমা:** তুলনাটি প্রদত্ত গবেষণা ফলের উপর ভিত্তি করে। Reference products-এর সব plan, region, retention বা proprietary implementation detail এখানে যাচাই করা হয়নি; তাই কোনো unavailable feature-কে USCS-এর guaranteed behaviour ধরা যাবে না।

## ২. প্রস্তাবিত USCS information architecture

### ২.১ Scope model

USCS-এর প্রতিটি route তিনটি scope বহন করবে: **workspace** (সংগঠন, সদস্য, entitlement, billing এবং governance), **project** (একটি deployable application এবং তার backend resources), এবং **resource** (deployment, database, function, bucket, domain বা policy)। URL, breadcrumb, page title এবং API request—সব জায়গায় এই scope explicit থাকবে। একই নামের resource থাকলে stable ID ও human-readable name উভয়ই দেখাতে হবে।

Workspace switcher সর্বদা global header-এ থাকবে। Project switcher project-level pages-এ থাকবে। Resource detail page-এ `Workspace / Project / Resource` breadcrumb থাকবে। কোনো create/edit form scope ছাড়া খুলবে না; deep link-এ scope missing বা access revoked হলে USCS generic empty state দেখাবে না, বরং **Not found or no access** state দেবে যাতে cross-tenant enumeration না ঘটে।

### ২.২ Workspace layer

Workspace হলো membership ও governance boundary। এখানে Members, Roles and policies, Activity/Audit, Environments defaults, Integrations, Entitlements/usage, API credentials এবং Workspace settings থাকবে। Workspace-এ project operational data সরাসরি দেখানো হবে না, যদি না user project নির্বাচন করে। Cloudflare-এর account governance এবং audit model [31] [32], Vercel-এর team/project separation [1] এবং Supabase-এর project boundary [11] এই বিভাজনের ভিত্তি।

প্রস্তাবিত workspace navigation:

1. **Workspace overview** — project inventory, active deployments, incidents, usage ও pending invitations-এর সংক্ষিপ্ত অবস্থা।
2. **Projects** — project list, status, owner/team, production version, environment ও last activity।
3. **Members & access** — সদস্য, role, project assignment, resource policy এবং pending invites।
4. **Activity & audit** — UI/API/system events, actor, scope, outcome, correlation ID, resource history।
5. **Integrations** — Git provider, marketplace/resource providers, webhooks, drains এবং external identity।
6. **Usage & plan** — current usage, retention, limits, capability state; কেবল গবেষণায় নির্দিষ্ট না থাকা billing workflow এখানে চূড়ান্ত নয়।
7. **Workspace settings** — defaults, security policy, SSO/2FA যেখানে supported, deletion policy ও notification policy।

### ২.৩ Project layer

Project হলো USCS-এর operational center। Project overview-তে “**এখন কী live?**” প্রশ্নের উত্তর প্রথম viewport-এই থাকবে: current production deployment, URL/domain, commit/version, environment, health/status, deployment time এবং immediate actions। Vercel-এর overview-first pattern [1] এবং deployment detail/resource cross-link [3] এখানে গ্রহণ করা হয়েছে।

প্রস্তাবিত project navigation:

1. **Overview**
2. **Deployments**
3. **Environments & configuration**
4. **Data** — database/schema/API resources; Supabase-এর Table Editor এবং generated API ধারণার সরল সংস্করণ [11] [13]।
5. **Users & access** — Auth users, application profiles, service identities।
6. **Files** — buckets, objects, ownership এবং policy।
7. **Functions & jobs** — deployable functions, queues, cron/workflows।
8. **Domains & delivery** — domain, DNS guidance, certificate, routes, redirects, cache।
9. **Logs & observability**
10. **Analytics**
11. **Security** — deployment protection, access policy, WAF/rate limits, bot/DDoS controls, source-map policy।
12. **Integrations**
13. **Project settings** — General, Build & runtime, Git, Environment variables, Webhooks, retention এবং advanced controls।

Sidebar capability-aware হবে, কিন্তু কোনো hidden feature নয়। Role বা plan-এর কারণে page unavailable হলে sidebar-এ locked/limited state এবং কারণ দেখাবে। Cloudflare-এর plan/permission-aware UI recommendation [26] গ্রহণ করা হলেও product list-এর breadth নকল করা হবে না।

## ৩. Exact page hierarchy

```text
USCS
├── Global header
│   ├── Workspace switcher
│   ├── Project switcher
│   ├── Global search
│   ├── Notifications / jobs
│   └── User profile
├── Workspace
│   ├── Overview
│   ├── Projects
│   │   ├── Project list
│   │   ├── Create / import project
│   │   └── Project archive / restore
│   ├── Members & access
│   │   ├── Members
│   │   ├── Roles & policies
│   │   └── Invitations
│   ├── Activity & audit
│   │   ├── Event explorer
│   │   └── Resource history / diff
│   ├── Integrations
│   ├── Usage & plan
│   └── Workspace settings
├── Project: :projectId
│   ├── Overview
│   ├── Deployments
│   │   ├── All deployments
│   │   ├── Deployment detail: :deploymentId
│   │   │   ├── Summary
│   │   │   ├── Build output
│   │   │   ├── Runtime resources
│   │   │   ├── Logs
│   │   │   └── Promotion / rollback history
│   │   └── New deployment
│   ├── Environments & configuration
│   │   ├── Environment overview
│   │   ├── Variables and secrets
│   │   └── Environment history
│   ├── Data
│   │   ├── Schemas / tables
│   │   ├── Table detail / rows
│   │   ├── SQL editor
│   │   ├── API explorer
│   │   └── Policies / grants
│   ├── Users & access
│   │   ├── Auth users
│   │   ├── User detail
│   │   └── Service identities
│   ├── Files
│   │   ├── Buckets
│   │   ├── Bucket detail
│   │   └── Object detail
│   ├── Functions & jobs
│   │   ├── Functions
│   │   ├── Function detail / test
│   │   ├── Queues
│   │   └── Cron / workflows
│   ├── Domains & delivery
│   │   ├── Domains
│   │   ├── DNS instructions
│   │   ├── Certificates
│   │   └── Routes / redirects / headers / cache
│   ├── Logs & observability
│   │   ├── Event explorer
│   │   ├── Request detail
│   │   ├── Function/runtime metrics
│   │   └── Drains / export
│   ├── Analytics
│   │   ├── Traffic
│   │   ├── Performance
│   │   ├── Functions
│   │   └── Custom views
│   ├── Security
│   │   ├── Deployment protection
│   │   ├── Access policies
│   │   ├── Firewall / WAF / rate limits
│   │   ├── Bot / DDoS controls
│   │   └── Source-map protection
│   ├── Integrations
│   │   ├── Git
│   │   ├── Marketplace resources
│   │   ├── Webhooks
│   │   └── API credentials
│   └── Project settings
│       ├── General
│       ├── Build & deployment
│       ├── Runtime & regions
│       ├── Git connection
│       ├── Environment variables
│       ├── Domains
│       ├── Security defaults
│       ├── Retention
│       └── Pause / delete
└── Error and safety states
    ├── No access / not found
    ├── Loading / backfill / eventual consistency
    ├── Capability unavailable
    ├── Failed job / retry
    └── Destructive confirmation
```

এই hierarchy-তে `Domains` ও `Environment variables`-এর operational page এবং settings page-এর মধ্যে duplicated source of truth থাকবে না। একটি canonical resource page থাকবে; settings-এ কেবল সেই resource-এর configuration shortcut বা deep link থাকবে।

## ৪. Page-by-page user flows

### ৪.১ Workspace overview এবং project creation

ব্যবহারকারী প্রথমে workspace নির্বাচন করবে। Overview-তে project list ও pending access কাজ দেখবে। **Create project** চাপলে template বা Git repository বেছে নেবে, project name ও owner নিশ্চিত করবে, framework/build detection যাচাই করবে, environment setup দেখবে এবং deploy করবে। Git provider webhook, commit/PR detection, build queue ও generated preview URL asynchronous job হিসেবে দেখাতে হবে। Vercel-এর import-to-deploy flow [1] এবং Cloudflare-এর Git import/deploy flow [23] থেকে এই flow নেওয়া হয়েছে।

যদি provider credential না থাকে, formটি silently fail করবে না; integration setup-এর কারণ, required permission এবং manual alternative দেখাবে। কোনো framework detection অনিশ্চিত হলে user confirmation চাইবে।

### ৪.২ Project overview

Overview project scope, current production deployment, URL/domain, commit, environment, build status, last incident এবং recent activity দেখাবে। Primary actions হবে **Deploy**, **View logs**, **Open production**, এবং role অনুযায়ী **Promote/Rollback**। Telemetry না থাকলে “No data” দেখিয়ে কেন—নতুন project, traffic না থাকা, backfill, retention বা entitlement—তা আলাদা করে বলা হবে; Supabase ও Vercel উভয়ের research-এ data latency/traffic-dependent empty state রয়েছে [7] [17]।

### ৪.৩ Deployments

Deployment list-এ status, environment, branch/commit, author, duration, URL, created time এবং action menu থাকবে। New deployment-এ Git reference, environment এবং optional variables নির্বাচন করে submit করতে হবে। Build queue → detection → build → artifact/resource inventory → URL provisioning → ready/failed state machine UI-তে progress হিসেবে আসবে।

Deployment detail-এ Summary, build logs, detected framework, resources, runtime logs, URL, domain assignment এবং promotion history থাকবে। Preview deployment থেকে **Promote to production**, **Redeploy**, **Rollback/Restore**, **Assign domain** action contextual menu-তে থাকবে। Production promotion-এর আগে commit, environment এবং impact review দেখাতে হবে। Vercel-এর deployment lifecycle [3] এবং preview-to-production flow [1] এই সিদ্ধান্তের ভিত্তি।

### ৪.৪ Environments, variables এবং secrets

ব্যবহারকারী project-এ environment নির্বাচন করবে—Development, Preview, Production বা custom environment। Team/workspace inherited value এবং project override স্পষ্টভাবে দেখাতে হবে। `Config` readable হতে পারে; `Secret` save-এর পরে write-only, masked এবং rotation history-সহ থাকবে। Branch targeting, effective value এবং source hierarchy দেখানো হবে, কিন্তু secret plaintext পুনরায় দেখানো যাবে না।

Save করার পরে banner দেখাবে: **“এই পরিবর্তন পরবর্তী deployment-এ কার্যকর হবে; বর্তমান deployment অপরিবর্তিত।”** এটি Vercel-এর environment variable semantics [6]-এর সঙ্গে সামঞ্জস্যপূর্ণ। Supabase-এর key separation এবং secret caution [18] [19] থেকে rotation/audit যুক্ত হবে।

### ৪.৫ Data, SQL এবং policy

Data page-এ schema/table list, relationship, columns, constraints, policies ও grants দেখা যাবে। Table editor row editing-এর entry point হতে পারে, কিন্তু spreadsheet-এর মতো unconstrained mutation নয়। নতুন table তৈরি করলে RLS বা equivalent row policy-এর security consequence দেখাতে হবে। Data API schema পরিবর্তনের সঙ্গে regenerate হলে generated endpoint, role এবং policy outcome দেখাতে হবে—Supabase-এর schema-reflective API model [13] এর adapted form।

SQL editor ad-hoc query-এর জন্য থাকবে। Production migration-এর জন্য editor-কে default path করা হবে না; Git-backed migration, diff, review এবং rollback বাধ্যতামূলক। Editor-only query-তে destructive command হলে typed confirmation ও impact preview চাইবে।

### ৪.৬ Users, Files এবং Functions

Auth users page-এ list, search, user detail, session/state এবং deletion dependency দেখাবে। user deletion-এর আগে owned files, linked profile এবং token expiry dependency check করতে হবে; Supabase research-এ Storage ownership-এর কারণে deletion আটকে যেতে পারে [14] [20]।

Files page-এ bucket visibility, MIME limit, size limit, ownership ও policy দেখাবে। public/private শব্দের পাশে actual access implication লিখতে হবে।

Functions page-এ source repository/commit, deployment state, endpoint, request test builder, response, logs এবং environment bindings থাকবে। Browser editor থাকলে তা prototype বা emergency patch হিসেবে label হবে; version control ছাড়া production deploy অনুমোদিত হবে না। Supabase dashboard editor-এর rollback/versioning সীমাবদ্ধতা [19] থেকে এই সতর্কতা এসেছে।

### ৪.৭ Domains ও delivery

Domains page-এ custom domain যোগ করার flow হবে: domain input → ownership check → DNS record/nameserver guidance → verification → certificate issuance → project/deployment assignment। Record type, TTL, proxy/routing এবং propagation status action-oriented ভাষায় দেখাতে হবে। Cloudflare DNS CRUD [23] এবং Vercel Domains flow [7] থেকে এই pattern নেওয়া হয়েছে।

Redirect, rewrite, header ও cache rule-এর জন্য type-dependent form, validation, preview এবং ordered evaluation explanation থাকবে। কোনো rule-এর effect নির্দিষ্ট deployment/domain ছাড়া save করা যাবে না।

### ৪.৮ Logs, observability এবং analytics

Event explorer-এ সময়সীমা, Live mode, severity, service, deployment, environment, branch, route/path, host, method, status, cache, user/request ID এবং text search composable filter হিসেবে থাকবে। Row selection right-side detail pane খুলবে; সেখানে overview, correlation IDs, request/response metadata, outgoing request trace এবং raw JSON থাকবে। URL-এ filter state সংরক্ষণ করা হবে, যাতে incident link share করা যায়। Vercel logs [6], Supabase Logs [17] এবং Cloudflare analytics drill-down [29] [30] এই সমন্বিত design-এর ভিত্তি।

Live mode-এ fixed range বা sort reset হলে আগে warning/confirmation থাকবে; Supabase-এর Live mode state reset observation [17] থেকে এই adaptation এসেছে। Export CSV/JSON, retention, sampling, freshness, data source এবং plan limit সবসময় দৃশ্যমান হবে। Aggregate analytics থেকে raw event বা audit history-তে drill-down হবে, কিন্তু raw data unavailable হলে chart-কে raw বলে দেখানো হবে না।

### ৪.৯ Security

Security page-এ deployment protection, password/identity/IP policy, source-map protection, WAF/rate limit, bot/DDoS policy এবং request-time evaluation থাকবে। Scope—preview, all deployments, production বা selected project—প্রতিটি policy-তে explicit। Save-এর আগে affected routes/deployments এবং bypass possibility দেখাতে হবে।

Rules ordered হলে execution order দৃশ্যমান থাকবে; Cloudflare security rules-এর first-to-last behavior [27] থেকে এই requirement এসেছে। Plan বা role-এর কারণে control unavailable হলে required entitlement/permission, data path এবং alternative API/CLI path দেখাতে হবে।

### ৪.১০ Members, audit এবং credentials

Invite flow: email/identity → workspace role → project/resource scope → review summary → invite। Role edit বা revoke-এ affected projects এবং active sessions দেখাতে হবে। Audit event-এ actor, interface (UI/API/system), resource, operation, success/failure, timestamp এবং correlation ID থাকবে। Resource history-তে versioned diff দেখানো হবে, Cloudflare audit/history pattern [32] অনুযায়ী।

API token flow: template বা custom permission → workspace/project/resource scope → optional IP/TTL → review → create → one-time secret display → verify/rotate/revoke। Secret কেবল একবার reveal হবে; recovery path হিসেবে rotation থাকবে। Cloudflare token flow [24] এবং Supabase public-versus-secret separation [16] থেকে এই নিরাপত্তা model নেওয়া হয়েছে।

## ৫. কোন pattern গ্রহণ, অভিযোজন বা প্রত্যাখ্যান করা হবে

### সরাসরি গ্রহণ

- **Persistent scope-aware navigation:** workspace ও project context header-এ স্থায়ী থাকবে।
- **Overview-first live state:** production deployment, URL, version, status ও immediate action প্রথমে থাকবে [1]।
- **Deployment-centric release workflow:** preview URL, promote, rollback, redeploy ও deployment history থাকবে [3]।
- **Composable Logs explorer:** filter bar, time range, detail pane, raw event, export ও deep link থাকবে [7] [17]।
- **Guided create + review:** DNS, rules, members, tokens ও destructive operation-এর আগে review summary থাকবে [23] [27]।
- **Audit ও resource history:** UI/API/system activity এবং diff first-class feature হবে [25]।
- **Code-first parity:** migration, API, CLI অথবা Git path প্রতিটি গুরুত্বপূর্ণ mutation-এর জন্য থাকবে [13] [16]।

### অভিযোজন

- Vercel-এর dense project sidebar-কে USCS-এ task-based group-এ সংকুচিত করা হবে।
- Supabase-এর table editor-কে schema, RLS, validation এবং migration guardrail-এর সঙ্গে যুক্ত করা হবে।
- Cloudflare-এর account→zone model-কে workspace→project→resource হিসেবে নেওয়া হবে; zone terminology নয়।
- Vercel-এর environment inheritance-এ USCS branch targeting, version history ও effective-value explanation যোগ করবে [6]।
- Cloudflare-এর synchronized analytics filters-এ USCS provenance, sample rate ও freshness যোগ করবে [26]।
- Supabase-এর Live mode-এ state-preserving confirmation যোগ করা হবে [20]।

### প্রত্যাখ্যান

- Product-specific jargon-এ ভরা অতি দীর্ঘ sidebar।
- Dashboard-only production code editing, যেখানে Git history, diff ও rollback নেই [16]।
- Opaque plan-gated tabs বা silently omitted actions।
- Public integration metadata ও secret একই UI surface-এ মিশিয়ে রাখা [18]।
- Raw DNS/runtime/provider terminology ব্যাখ্যা ছাড়া দেখানো।
- Unbounded realtime table যা pagination, virtualization, retention, accessibility ও failure state ছাড়া চলে।
- Marketing/content navigation-এর সঙ্গে operational control মেশানো।
- সব user-কে expert developer ধরে নেওয়া।

## ৬. Backend এবং adapter requirements

### ৬.১ Canonical control-plane services

**Identity এবং authorization service** workspace membership, project role, resource policy, team defaults, session এবং audit identity পরিচালনা করবে। Permission server-side enforce হবে; UI visibility কখনো authorization-এর বিকল্প নয়। Scope resolution প্রতিটি request-এ workspace/project/resource এবং actor policy যাচাই করবে।

**Project/deployment service** project ownership, source connection, commit/branch, environment, status, URL, domain assignment, framework/build metadata, artifacts, resources, logs এবং promotion history রাখবে। Deployment state machine-এ idempotent transition, retry, cancel, failed reason এবং correlation ID থাকতে হবে।

**Build/orchestration service** Git webhook, commit/PR detection, CLI/Drop/Deploy Hook/REST ingress, queue, executor, framework detection, artifact inventory, preview URL এবং deployment promotion পরিচালনা করবে। Queue job user request-কে synchronous page submit-এর মধ্যে আটকে রাখবে না।

**Environment/secrets service** workspace inheritance, project override, environment/branch target, encryption at rest, write-only secret, versioning, rotation, runtime injection এবং subsequent-deployment semantics enforce করবে। Secret plaintext logs-এ কখনো যাবে না।

**Data/API service** relational metadata, schemas, tables, columns, relationships, constraints, migrations, roles/grants, RLS-equivalent policies, generated REST/GraphQL documentation এবং request-time authorization রাখবে। Supabase-এর Postgres/RLS coupling [11] [16] ভিত্তি হলেও USCS-এর প্রথম release-এ exact database vendor অনির্ধারিত।

**Storage service** bucket/object metadata, ownership, visibility, MIME/size constraint এবং policy integration রাখবে। Auth user deletion dependency check করবে।

**Function/job service** source revision, build artifact, endpoint, runtime, region, bindings, test invocation, queues এবং cron/workflow status পরিচালনা করবে।

**Domain/delivery service** ownership verification, DNS guidance/status, certificate lifecycle, routing, redirects, rewrites, headers, cache control এবং assignment history রাখবে। Cloudflare DNS API concepts [26] এবং Vercel domain model [7] adapter boundary-তে থাকবে।

**Observability pipeline** logs/metrics/events ingest, index, retention, filter, aggregate, live stream, export, raw JSON, correlation ID এবং drains পরিচালনা করবে। Service-specific log type ও UI unified হলেও source metadata অপরিবর্তিত থাকবে।

**Analytics service** privacy-preserving aggregation, dimensions, time windows, panel queries, CSV export, function/edge metrics, usage এবং sampling/freshness metadata রাখবে। Raw unsampled logs-এর availability এখনও USCS সিদ্ধান্ত নয়; UI-তে unavailable হলে honest state দেখাতে হবে।

**Security enforcement plane** deployment access, password/identity/IP checks, protected source maps, firewall/WAF/rate limits, bot/DDoS control এবং request-time policy evaluation করবে।

### ৬.২ Adapter boundaries

Vendor বা self-hosted implementation পরিবর্তনের জন্য adapter interface হবে:

| Adapter | Minimum contract |
|---|---|
| Git | OAuth/credential, repository/branch, webhook verification, commit/PR event, disconnect |
| Build/deploy | queue, build logs, artifact, status transition, preview URL, promote/rollback |
| Database | schema introspection, migration apply, query, policy/grant, backup/restore status |
| Auth | user/session/identity, token expiry, deletion dependency, audit event |
| Storage | bucket/object CRUD, signed access, ownership, policy, limits |
| Runtime/functions | source revision, build, deploy, invoke/test, logs, secret binding |
| DNS/SSL | ownership verification, record guidance, certificate status, route assignment |
| Observability | ingest, query, live stream, export, retention, drain, correlation IDs |
| Security | rule compile/validate, ordered evaluation, deploy, rollback, effective policy |
| Billing/entitlement | capability check, limit, retention and upgrade state; provider unavailable হলে explicit unknown |

Adapters-এর response-এ `status`, `capabilities`, `source`, `freshness`, `correlationId` এবং stable error envelope থাকবে। UI কখনো provider-specific undocumented field-এর উপর নির্ভর করবে না।

### ৬.৩ Non-functional requirements

সব mutation idempotency key গ্রহণ করবে। Long-running action job ID ও polling/stream endpoint দেবে। List endpoint pagination এবং server-side filter দেবে; frontend বিশাল dataset একবারে আনবে না। Eventual consistency-র ক্ষেত্রে `pending`, `backfilling`, `stale`, `partial` state থাকবে। Deletion এবং promotion-এর আগে typed confirmation ও server-side recheck হবে। Audit pipeline failure হলে mutation success-এর পাশাপাশি audit delivery status স্পষ্ট করতে হবে; silently unaudited action অনুমোদিত নয়।

Cross-tenant data isolation database policy, service authorization, cache key এবং object storage path—সব স্তরে পরীক্ষা করতে হবে। Tenant ID কেবল frontend filter নয়; query authorization-এর server-side predicate হতে হবে। Correlation ID UI action থেকে adapter call, job, runtime log এবং audit event পর্যন্ত বহন করতে হবে।

## ৭. Open-source implementation choices

এগুলো **প্রস্তাবিত option**, চূড়ান্ত vendor selection নয়; গবেষণায় USCS-এর latency, compliance, scale, cloud বা license constraint নির্দিষ্ট নেই। Procurement ও security review ছাড়া কোনো option production choice হিসেবে দাবি করা যাবে না।

- **Web UI:** React + TypeScript, একটি accessible component system, TanStack Table/Virtual এবং URL-backed query state। Dense operational tables-এ keyboard navigation, screen-reader label এবং virtualization আবশ্যক।
- **API/control plane:** TypeScript NestJS/Fastify অথবা Go service; OpenAPI-first contract, generated client এবং consistent error envelope। সিদ্ধান্তটি latency ও team expertise যাচাইয়ের পর হবে।
- **Relational metadata:** PostgreSQL; migrations, row-level policy এবং transactional audit outbox ব্যবহার করা যেতে পারে। Exact managed provider অনির্ধারিত।
- **Authorization:** OpenFGA বা OPA-জাত policy engine মূল্যায়ন করা যেতে পারে। শুরুতে policy model ছোট রাখবে: workspace role, project role, resource scope, environment restriction।
- **Jobs/queues:** Temporal বা একটি durable queue/workflow engine; deployment, build, certificate, export ও rollback-কে retryable workflow হিসেবে চালানো হবে।
- **Events/observability:** OpenTelemetry-compatible traces, structured JSON logs, ClickHouse/Loki/OpenSearch-এর একটি evaluated backend; raw retention ও query cost-এর benchmark ছাড়া চূড়ান্ত নির্বাচন নয়।
- **Object storage:** S3-compatible storage; bucket policy, signed URL ও encryption key management provider-neutral থাকবে।
- **Secrets:** KMS/Vault-জাত secret manager; application database-এ plaintext নয়। Secret rotation ও audit প্রথম design-এর অংশ।
- **Deployment adapters:** GitHub/GitLab adapter, container/BuildKit-compatible executor এবং DNS provider adapters; vendor API credentials least privilege হবে।
- **Testing:** contract tests for adapters, property-based authorization tests, migration tests, Playwright end-to-end flows এবং tenant-isolation test fixtures।

Open-source library ব্যবহারে transitive license, maintenance, CVE response, data residency এবং commercial support যাচাই করতে হবে। “Open source” হওয়া একা operational suitability প্রমাণ করে না।

## ৮. UI/UX-first implementation sequence

### ধাপ ০ — সিদ্ধান্ত ও safety contract

প্রথমে scope vocabulary, role matrix, deployment states, environment semantics, capability states, error envelope এবং audit event schema লিখিতভাবে freeze করতে হবে। এই ধাপে কোনো fake API বা placeholder success state থাকবে না। Unavailable feature-এর জন্য explicit design state তৈরি হবে।

### ধাপ ১ — App shell এবং scope নিরাপত্তা

Workspace switcher, project switcher, breadcrumb, sidebar, global search, notification/job tray, loading/error/no-access/empty state এবং responsive table shell তৈরি হবে। Test করতে হবে যে একই URL অন্য workspace ID দিয়ে access করলে data leak হয় না।

### ধাপ ২ — Read-only project overview

Mock নয়, typed fixture বা clearly labelled local demo dataset দিয়ে project overview, current deployment, URL, commit, environment, status এবং activity card তৈরি হবে। Backend না থাকলে UI-তে “demo data” label বাধ্যতামূলক; production-looking fake telemetry নিষিদ্ধ।

### ধাপ ৩ — Deployment review surface

Deployment list, detail, build output, runtime resource, URL, status timeline এবং shareable route তৈরি হবে। প্রথমে read-only, তারপর real job API। Promote, rollback ও redeploy action শুরুতে disabled না রেখে capability response অনুযায়ী কারণসহ state দেখাবে।

### ধাপ ৪ — Logs explorer

Time range, composable filters, URL query state, live mode confirmation, right-side detail, raw JSON, correlation ID ও export UI বানাতে হবে। Empty, backfill, partial, retention এবং permission state একই design system-এ থাকবে।

### ধাপ ৫ — Environment/secrets এবং security

Environment selector, inheritance tree, Config/Secret distinction, effective value এবং next-deployment warning তৈরি হবে। এরপর Deployment Protection, roles/policies, review summary, typed deletion এবং token reveal/rotation flow। Secret test-এ plaintext leak detection যোগ হবে।

### ধাপ ৬ — Data, users, files, functions

Table schema/editor, SQL editor, policy view, Auth user list, storage bucket/object এবং function test surface তৈরি হবে। Production code edit-এর Git diff/rollback না থাকলে deploy button থাকবে না। Cross-resource deletion dependency UI এই ধাপেই যুক্ত হবে।

### ধাপ ৭ — Domains, analytics এবং integrations

DNS guidance, certificate status, route rule validation, synchronized analytics filters, provenance/freshness এবং Git/webhook integration যোগ হবে। Vendor adapter contract test ছাড়া provider-specific success banner দেওয়া যাবে না।

### ধাপ ৮ — Audit, usage এবং operational hardening

Resource history diff, UI/API/system event explorer, retention/entitlement state, incident links, export, rate limits, retries, idempotency এবং accessibility audit সম্পূর্ণ করতে হবে। তারপর feature flag ধরে staged rollout।

### Definition of done

প্রতিটি page-এর জন্য এই checks আবশ্যক: (১) scope header আছে, (২) permission server-side enforce হয়, (৩) loading/empty/error/partial state আছে, (৪) mutation-এর audit event আছে, (৫) deep link পুনরায় একই state খোলে, (৬) destructive action reversible বা typed confirmation-যুক্ত, (৭) API/CLI parity অথবা explicit prototype label আছে, এবং (৮) tenant-isolation test pass করেছে।

## ৯. Explicit anti-patterns

### Fake data এবং false telemetry

Production UI-তে hard-coded deployment, fabricated logs, fake chart, random success count বা simulated “healthy” status দেখানো যাবে না। Design prototype-এ demo data থাকলে প্রতিটি panel-এ `Demo data` label, fixed fixture source এবং non-production route থাকবে। Backend unavailable হলে **Data unavailable** বা **Awaiting first event** দেখাতে হবে।

### Dead buttons এবং misleading affordances

কোনো button click করে নীরবে কিছু না করলে তা dead button। Capability unavailable হলে button disabled হওয়ার কারণ, required permission/plan এবং alternative path দেখাতে হবে। “Deploy”, “Rollback”, “Delete”, “Rotate” action real backend transition ছাড়া success toast দেখাবে না।

### Duplicated categories এবং competing source of truth

Domains যদি একদিকে operational page এবং অন্যদিকে unrelated settings form-এ আলাদা state রাখে, drift হবে। একই resource-এর এক canonical owner থাকবে; shortcut কেবল deep link। `Security`, `Access`, `Settings`-এ একই policy তিনবার না রেখে ownership map স্পষ্ট করতে হবে।

### Unsafe cross-tenant data

Frontend filter দিয়ে tenant isolation করা যাবে না। Cache key-তে workspace/project ID, database predicate, object path, websocket subscription এবং export query—সবখানে scope বাধ্যতামূলক। `404` বনাম `403` response-এ enumeration ঝুঁকি মূল্যায়ন করতে হবে। Audit event-এ অন্য tenant-এর resource name leak করা যাবে না।

### Secret leakage

Secret URL, browser console, analytics payload, log line, error stack, export CSV, screenshot অথবা audit diff-এ plaintext হবে না। One-time reveal-এর পরে rotation path না থাকলে credential flow সম্পূর্ণ নয়। Publishable key, API URL এবং secret key আলাদা label ও policy-তে থাকবে [18] [27]।

### Unsafe asynchronous mutation

Build বা DNS job চলার সময় duplicate submit, stale status, double promotion অথবা retry-তে duplicate record তৈরি করা যাবে না। Idempotency key, job state, cancellation semantics এবং stale response cancellation আবশ্যক।

### Unbounded density এবং inaccessible realtime

অসীম row render, auto-refresh-এ focus হারানো, live mode-এ filter মুছে যাওয়া, color-only status এবং keyboard-অযোগ্য detail pane operational failure তৈরি করবে। Pagination/virtualization, pause control, semantic labels এবং preserved query state বাধ্যতামূলক।

### Provider jargon ও scope ambiguity

“Zone”, “edge”, “function region”, “preview protection” বা “RLS” শব্দের পাশে action-oriented explanation থাকবে। Breadcrumb ছাড়া account/project/resource transition করা যাবে না।

### Unsupported claims

USCS-এর নির্দিষ্ট compliance certification, data residency, billing rules, raw unsampled analytics, exact database, exact cloud provider, uptime target বা enterprise SSO support গবেষণায় পাওয়া যায়নি। এগুলোকে implemented বা guaranteed বলা যাবে না; প্রত্যেকটি `TBD`, `provider-dependent` অথবা `not yet available` হিসেবে চিহ্নিত হবে।

## ১০. ঝুঁকি ও পরবর্তী সিদ্ধান্ত

সবচেয়ে বড় product risk হলো reference platforms-এর breadth দেখে USCS-এর প্রথম release-কে অতিরিক্ত বড় করা। তাই launch scope-এ একটি coherent path থাকবে: project import → preview deploy → logs → environment secret → promote/rollback → domain → audit। Data, Auth, Storage ও Functions-এর প্রথম সংস্করণে security coupling সম্পূর্ণ না হলে তাদের UI সীমিত রাখা হবে।

পরবর্তী architecture review-তে পাঁচটি অনির্ধারিত সিদ্ধান্ত নিতে হবে: target tenant scale, compliance/data-residency requirements, primary cloud/runtime, database/storage provider এবং entitlement/billing model। এই সিদ্ধান্তের আগে open-source option-কে final architecture হিসেবে freeze করা উচিত নয়।

## References

[1]: https://vercel.com/docs/projects "Vercel Projects"
[2]: https://vercel.com/docs/projects/managing-projects "Vercel Managing Projects"
[3]: https://vercel.com/docs/deployments "Vercel Deployments"
[4]: https://vercel.com/docs/project-configuration/project-settings "Vercel Project Settings"
[5]: https://vercel.com/docs/environment-variables "Vercel Environment Variables"
[6]: https://vercel.com/docs/logs/runtime "Vercel Runtime Logs"
[7]: https://vercel.com/docs/domains "Vercel Domains"
[8]: https://vercel.com/docs/analytics "Vercel Analytics"
[9]: https://vercel.com/docs/deployment-protection "Vercel Deployment Protection"
[10]: https://vercel.com/academy/optimize-your-vercel-account/tour-the-dashboard "Vercel Academy: Tour the Dashboard"
[11]: https://supabase.com/docs/guides/database/overview "Supabase Database Overview"
[12]: https://supabase.com/docs/guides/database/tables "Supabase Tables"
[13]: https://supabase.com/docs/guides/database/functions "Supabase Database Functions"
[14]: https://supabase.com/docs/guides/auth/managing-user-data "Supabase Managing User Data"
[15]: https://supabase.com/docs/guides/auth/audit-logs "Supabase Auth Audit Logs"
[16]: https://supabase.com/docs/guides/api "Supabase API"
[17]: https://supabase.com/docs/guides/observability/logs "Supabase Logs"
[18]: https://supabase.com/docs/guides/observability/log-drains "Supabase Log Drains"
[19]: https://supabase.com/docs/guides/functions/quickstart-dashboard "Supabase Edge Functions Dashboard Quickstart"
[20]: https://supabase.com/docs/guides/storage/buckets/creating-buckets "Supabase Creating Storage Buckets"
[21]: https://supabase.com/docs/guides/realtime "Supabase Realtime"
[22]: https://supabase.com/docs/guides/deployment "Supabase Deployment"
[23]: https://developers.cloudflare.com/fundamentals/concepts/accounts-and-zones/ "Cloudflare Accounts and Zones"
[24]: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ "Cloudflare Create API Tokens"
[25]: https://developers.cloudflare.com/fundamentals/api/reference/permissions/ "Cloudflare API Permissions"
[26]: https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/ "Cloudflare Create DNS Records"
[27]: https://developers.cloudflare.com/security/rules/ "Cloudflare Security Rules"
[28]: https://developers.cloudflare.com/workers/get-started/dashboard/ "Cloudflare Workers Dashboard"
[29]: https://developers.cloudflare.com/analytics/account-and-zone-analytics/zone-analytics/ "Cloudflare Zone Analytics"
[30]: https://developers.cloudflare.com/analytics/custom-dashboards/ "Cloudflare Custom Dashboards"
[31]: https://developers.cloudflare.com/fundamentals/manage-members/manage/ "Cloudflare Manage Members"
[32]: https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/ "Cloudflare Audit Logs"
[33]: https://developers.cloudflare.com/changelog/post/2026-05-04-keyboard-shortcuts/ "Cloudflare Keyboard Shortcuts"

> **উদ্ধৃতি ব্যবহারের নোট:** এই blueprint-এ Vercel, Supabase ও Cloudflare-এর authoritative documentation-কে reference model হিসেবে ব্যবহার করা হয়েছে। কোনো proprietary internal implementation, undocumented plan behaviour বা USCS-specific production commitment অনুমান করা হয়নি।
