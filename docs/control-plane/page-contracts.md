# USCS Control Plane: Page Contracts

## উদ্দেশ্য

এই নথি USCS dashboard-এর প্রতিটি section-এর জন্য **কী দেখাবে, কেন দেখাবে, কোন data ব্যবহার করবে এবং user action-এর পরে কী হবে**—তার source-of-truth। কোনো page এই contract ছাড়া implement করা যাবে না। Page-এর visual language Vercel-এর project model থেকে অনুপ্রাণিত হবে, কিন্তু data এবং actions সবসময় USCS-এর বাস্তব tRPC ও Supabase contract থেকে আসবে। Vercel একটি project-এর মধ্যে deployments, domains, environment variables, build/runtime settings, integrations, security controls এবং observability একত্র করে [1]।

## Global rules

প্রতিটি page একই পাঁচটি state পরিচালনা করবে: loading, loaded, empty, error এবং not configured। Backend থেকে data না এলে placeholder number, fake chart বা fake success দেখানো যাবে না। কোনো action বাস্তব mutation চালাবে, একটি real panel খুলবে, অথবা disabled অবস্থায় কারণ দেখাবে।

প্রতিটি route URL-driven হবে। Refresh, browser back এবং deep-link একই context বজায় রাখবে। Workspace route এবং project route কখনো একই query scope ব্যবহার করবে না। Project route-এ সব resource query-তে `projectId` থাকবে; workspace route-এ organization membership scope ব্যবহার হবে।

প্রতিটি page-এ header-এর নিচে একটি সংক্ষিপ্ত explanation থাকবে। User যেন বুঝতে পারে page-টি কী নিয়ন্ত্রণ করে এবং অন্য page-এর তুলনায় কেন আলাদা।

## Context model

### Workspace context

Workspace context পুরো organization-এর aggregate view দেখায়। এখানে user বোঝে কোন project, deployment, domain, database, storage এবং security resource তার workspace-এ আছে। Workspace context-এর route `/dashboard/...`।

### Project context

Project context একটি নির্দিষ্ট project-এর operational surface। Project নির্বাচন করলে sidebar project menu-তে বদলাবে এবং breadcrumb হবে `Workspace / Project / Section`। Project context-এর route `/dashboard/projects/:projectId/...`। Vercel-এ project নির্বাচন করলে project dashboard-এ deployments, configuration এবং settings আলাদা scope-এ দেখা যায় [1]।

## Workspace pages

### Overview

**কেন আছে:** Workspace-এর প্রথম screen হিসেবে user-কে দ্রুত health এবং activity বুঝতে সাহায্য করে। এটি কোনো single resource management page নয়।

**কী দেখাবে:** Project count, deployment count, latest deployment status, latest deployment metadata, recent workspace activity এবং একটি clear path to Projects। Deployment status না থাকলে `No deployment data` দেখাবে।

**কীভাবে দেখাবে:** উপরে page title এবং short description। তার নিচে ছোট summary cards। এরপর latest deployment বা empty state। নিচে recent activity timeline আসবে যখন audit data wired থাকবে।

**User flow:** User card বা `View projects` click করলে Projects page-এ যাবে। Latest deployment click করলে deployment detail খুলবে। কোনো card শুধু decorative হলে click করা যাবে না।

**Data:** `workspace.projects.list`, `deployments.list` এবং পরে `workspace.audit`।

### Projects

**কেন আছে:** Workspace-এর project boundary নির্ধারণ করে। Project-এ click করলেই user project-specific system-এ ঢোকে।

**কী দেখাবে:** Search, scope tabs, project cards এবং project metadata। Card-এ project name, slug, latest deployment summary, repository বা explicit unavailable state থাকবে।

**কীভাবে দেখাবে:** Vercel-style compact cards বা table। Search শুধু loaded real projects filter করবে। Empty state-এ project তৈরির action থাকবে।

**User flow:** Card click করলে `/dashboard/projects/:id`। Add New click করলে organization selection এবং project name dialog। Successful create-এর পরে list refresh এবং নতুন project context-এ যাওয়ার option।

**Data:** `workspace.organizations`, `workspace.projects.list`, `workspace.projects.create`।

### Deployments

**কেন আছে:** Workspace-এর সব deployment lifecycle এক জায়গায় দেখা এবং environment অনুযায়ী filter করার জন্য।

**কী দেখাবে:** Production, preview এবং development deployment list। Status, environment, branch, commit, repository, URL এবং created time দেখাবে।

**কীভাবে দেখাবে:** Search, environment filter এবং status filter-এর নিচে table। Row click করলে detail drawer। Drawer-এ deployment metadata এবং recorded logs থাকবে।

**User flow:** Row click → detail drawer। Detail থেকে logs দেখা যাবে। Rollback বা redeploy কেবল backend action এবং permission contract পাওয়ার পরে active হবে। Adapter configured না থাকলে action disabled এবং reason visible থাকবে।

**Data:** `deployments.list`, `deployments.get`।

### Logs

**কেন আছে:** Deployment list operational summary; Logs page troubleshooting surface। দুইটি page এক নয়।

**কী দেখাবে:** Runtime logs এবং build/deployment logs। Time range, severity, source, project এবং deployment filter থাকবে।

**কীভাবে দেখাবে:** Dense monospace log stream, sticky filter bar, empty এবং no-results states। Long stream pagination বা bounded loading ব্যবহার করবে।

**User flow:** Deployment detail থেকে Logs page-এ গেলে deployment filter preselected থাকবে। Log row click করলে metadata drawer খুলবে।

**Data:** Existing `deployments.get(... includeLogs: true)` এবং available deployment log procedures। Dedicated global stream না থাকলে page-এ honest not-configured state থাকবে।

### Analytics

**কেন আছে:** User traffic এবং product usage বোঝার জন্য। এটি operational error monitoring নয়।

**কী দেখাবে:** Page views, visitors, top paths এবং time range comparison—শুধুমাত্র real analytics provider থাকলে।

**কীভাবে দেখাবে:** Time-range selector, summary cards এবং charts। Provider না থাকলে chart আঁকা যাবে না; `Analytics is not configured` এবং setup path দেখাবে।

**User flow:** Enable বা configure action কেবল real provider flow থাকলে active হবে।

**Data:** Existing router-এ analytics procedure না থাকলে এই page deliberately gated থাকবে।

### Observability

**কেন আছে:** Runtime health বোঝার জন্য। Logs-এর মতো raw event নয়; metrics এবং error trends-এর page।

**কী দেখাবে:** Requests, errors, latency এবং alert summary।

**কীভাবে দেখাবে:** Time range, project/environment scope, metric cards এবং trend charts। Data না থাকলে no telemetry state।

**User flow:** Error বা request summary click করলে filtered Logs অথবা deployment detail-এ যাবে।

**Data:** Existing observability router coverage অনুযায়ী। Procedure না থাকলে explicit not-configured state।

### Domains

**কেন আছে:** Project বা workspace-এর public hostname, DNS এবং SSL/TLS configuration পরিচালনা করতে।

**কী দেখাবে:** Domain list, verification status, target project, DNS/SSL status এবং add/search action।

**কীভাবে দেখাবে:** Domain table; status badge; domain detail drawer-এ DNS instructions।

**User flow:** Search domain → result select → attach/configuration panel। Adapter unavailable হলে reseller/provider reason দেখাবে।

**Data:** `domains.search` এবং existing domain adapter contract। Domain list procedure না থাকলে search-only এবং not-configured state দেখাতে হবে; fake domain count নয়।

### Storage

**কেন আছে:** Object buckets এবং backup resource আলাদা করে পরিচালনা করতে। Storage database নয়; তাই তার নিজের lifecycle থাকবে।

**কী দেখাবে:** Bucket name, visibility, region, status, adapter reference এবং backup summary।

**কীভাবে দেখাবে:** Bucket cards/table; bucket detail-এ objects/backup tabs। Objects browser backend support না করলে disabled explanation।

**User flow:** Create bucket → real provisioning mutation → configured বা not-configured result। Backup create action-এর পরে audit result দেখাবে।

**Data:** `data.storageBuckets.list/provision`, `data.backups.list/create`।

### Database

**কেন আছে:** USCS-এর প্রথম-class differentiator। Deployment database এবং managed infrastructure একই page নয়।

**কী দেখাবে:** Database instance name, engine, status, tenant identifier, project scope এবং adapter state।

**কীভাবে দেখাবে:** Instance cards/table। Detail view-এ `Connection details`, `Backups` এবং `Tables / SQL` tabs থাকবে। Tables/SQL browser backend না থাকলে Coming soon state থাকবে।

**User flow:** Create database → engine/name form → provision mutation → configured বা honest not-configured result। Backup tab থেকে list/create।

**Data:** `data.databaseInstances.list/provision`, `data.backups.list/create`।

### Security

**কেন আছে:** Cloudflare-style edge controls এবং USCS custom security posture এক parent section-এ রাখার জন্য। Security আলাদা আলাদা scattered menu হবে না।

**কী দেখাবে:** Current security level, adapter status, enabled controls, policy preview এবং event/history। Level: `none`, `normal`, `high`, `ultimate`।

**কীভাবে দেখাবে:** চারটি level card। Selected level-এর `What this enables` comparison। Apply করার আগে diff view। Adapter pending হলে prominent `Edge not configured` banner।

**User flow:** Level select → `previewPolicy` → preview comparison → optional auto-setup → Apply → `setLevel` then `applyPolicy` → result and audit event। Failure কখনো success হিসেবে দেখানো যাবে না।

**Data:** `security.previewPolicy`, `security.getPolicy`, `security.setLevel`, `security.applyPolicy`।

### Connect

**কেন আছে:** Git repositories, webhooks এবং provider connections-এর configuration surface। এটি Deployments page নয়।

**কী দেখাবে:** Connected providers, repositories, webhook status এবং connection actions।

**কীভাবে দেখাবে:** Provider cards এবং connection detail panel। Adapter না থাকলে configuration reason।

**Data:** Existing developer/integration router coverage। Missing procedure থাকলে visible not-configured page।

### Usage

**কেন আছে:** Workspace resource consumption এবং billing relationship দেখাতে। Usage operational logs নয়।

**কী দেখাবে:** Billing period, deploy minutes, storage, bandwidth, estimated amount এবং invoice status।

**কীভাবে দেখাবে:** Period selector, summary cards, usage table এবং invoice list।

**Data:** `billing.status`, `billing.usage`, `billing.invoices`। Billing adapter বা data না থাকলে explicit empty state।

### Settings

**কেন আছে:** Workspace identity, members, notifications, connected accounts এবং audit configuration আলাদা করে পরিচালনা করতে।

**কীভাবে দেখাবে:** Settings index-এর পরিবর্তে secondary navigation বা tabs: General, Members & Roles, Notifications, Connected Accounts, Audit Log।

**Data:** `workspace.organizations`, members procedures, audit procedure এবং account procedures। Permission-sensitive actions server-side role gate অনুসরণ করবে।

## Project pages

Project context-এর pages workspace-এর একই label ব্যবহার করতে পারে, কিন্তু content সবসময় project-scoped হবে। Project Overview-তে aggregate workspace metrics দেখানো যাবে না। Project Deployments-এ `deployments.list({ projectId })` বাধ্যতামূলক। Project Database এবং Storage একই resource procedure-এ `projectId` পাঠাবে।

Project-এর `Environment Variables` page-এ production, preview এবং development scope আলাদা থাকবে। Backend procedure না থাকলে UI form বানানো যাবে না; শুধু not-configured contract থাকবে। Project Settings-এ general configuration, Git/deployment settings, domains, environment variables এবং access controls আলাদা tabs হবে। Vercel project settings-এ build/deployment, domains, functions, integrations, Git, environment variables, deployment protection এবং security আলাদা configuration areas হিসেবে থাকে [2]।

## Implementation order

প্রথমে navigation এবং page contract স্থির থাকবে। তারপর Project Overview, Deployments, Logs, Domains, Database, Storage এবং Security ক্রমানুসারে বাস্তব data flow দিয়ে তৈরি হবে। Analytics, Observability, Connect এবং Environment Variables-এর procedure coverage সম্পূর্ণ না হওয়া পর্যন্ত এগুলোতে fake charts বা fake controls যোগ হবে না।

প্রতিটি phase-এ `pnpm build`, `pnpm check`, `pnpm test` এবং `git diff --check` বাধ্যতামূলক। Phase শেষে আলাদা commit এবং push হবে।

## References

[1]: https://vercel.com/docs/projects "Projects overview"
[2]: https://vercel.com/docs/project-configuration/project-settings "Project settings"
