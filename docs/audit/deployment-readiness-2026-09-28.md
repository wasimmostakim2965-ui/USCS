# USCS / Cloud Wai — Production Readiness Audit

**Audit date:** 2026-09-28  
**Repository:** `wasimmostakim2965-ui/USCS`  
**Audited ref:** `main` at `1904e40` (`style: format builder server`)  
**Auditor:** Manus AI

## Executive verdict

USCS-এর control-plane core এখন **technically coherent এবং launchable as a dashboard/API product**। Fresh clone-এ TypeScript build এবং typecheck সফল হয়েছে। Build-এর পরে পুরো test suite-এ **52 test files এবং 898 tests পাস** করেছে। Repository-তে tenant isolation, honest engine states, idempotent jobs, secret redaction, audit logging, Supabase RLS এবং an AWS/Terraform deployment shape-এর বাস্তব implementation আছে।

তবে এটিকে এখনই **Vercel-এর মতো অন্য system deploy করানোর production platform** বলা নিরাপদ নয়। কারণ deployment orchestration-এর কয়েকটি execution engine intentionally unconfigured, builder service-এর production topology অসম্পূর্ণ, এবং AWS Terraform configuration application runtime-এর সব প্রয়োজনীয় secret/configuration সরবরাহ করে না।

সুতরাং বর্তমান status:

> **Dashboard/API: release candidate.**  
> **External deployment platform: pre-production; real engine validation এখনও বাকি।**

## What is proven

### 1. Repository integrity

- `pnpm build` — **pass**
- `pnpm check` — **pass**
- `pnpm test` — **52 files, 898 tests, all pass**
- `pnpm format:check` — **pass**
- Working tree audit-এর সময় clean ছিল; local changes ছিল না।

প্রথমে build না করে clean checkout-এ test চালালে workspace package-এর `dist` entrypoint না পাওয়ার error হয়। CI workflow এই dependency সঠিকভাবে মেনে আগে `pnpm build`, পরে `pnpm test` চালায়। তাই এটি source defect নয়, কিন্তু standalone `pnpm test` command-টি clean checkout-এ self-contained নয়।

### 2. Control-plane architecture

সিস্টেমের প্রধান boundary সঠিকভাবে আলাদা করা হয়েছে:

```text
Browser
  -> Web dashboard
  -> Cloud Wai API/BFF
  -> Supabase control-plane PostgreSQL
  -> durable worker queue
  -> external execution engines
```

Browser সরাসরি Coolify, database, MinIO/S3, security edge বা host firewall-এ কথা বলে না। API server-side membership দিয়ে organization scope resolve করে। URL-এর organization ID authorization-এর source নয়। এই নকশাটি `apps/api/src/bootstrap.ts`, `apps/api/src/server.ts`, `packages/auth`, `packages/authorization` এবং `packages/database`-এ বাস্তবভাবে wired।

### 3. Honest-state behavior

Engine না থাকলে UI/API fake success দেখায় না। Deployment, database, storage, domain verification এবং security edge-এর জন্য `not_configured`, `pending`, `failed` এবং `degraded` state আলাদা রাখা হয়েছে। এটি গুরুত্বপূর্ণ, কারণ বর্তমানে Coolify, MinIO/S3, Lambda/build এবং live security edge-এর credentials একটি production environment-এ অবশ্যই provision করতে হবে।

### 4. Security baseline

বর্তমান codebase-এ শক্তিশালী baseline আছে:

- Supabase Auth session verification
- API-তে bearer token only
- request body size cap
- explicit CORS allow-list; wildcard নয়
- service-role key browser-এ যায় না
- API key hash client-readable নয়
- environment/webhook secrets encrypted-at-rest path-এ রাখা
- idempotency এবং durable queue lease/reap
- append-only audit model
- RLS এবং engine-observed column guards
- secret/token/cookie/origin log redaction
- default AWS shape-এ private application subnet এবং Session Manager access

এগুলো production quality-এর ভালো ভিত্তি, কিন্তু live infrastructure test ছাড়া এগুলো deployment platform-এর সম্পূর্ণ প্রমাণ নয়।

## Critical gaps before calling it production-ready

### P0 — AWS Terraform environment incomplete for application features

> **সমাধান হয়েছে (2026-09-28).** এই অনুচ্ছেদের দুইটি gap পরে বন্ধ করা হয়েছে:
> `infra/aws/terraform/variables.tf`-এ `cloud_wai_secret_encryption_key`
> (`sensitive = true`, 43-char validation) এবং `public_supabase_url` দুটি variable
> যোগ হয়েছে, এবং `infra/aws/terraform/compute.tf`-এর SSM environment template
> এখন `CLOUD_WAI_SECRET_ENCRYPTION_KEY`, `PUBLIC_SUPABASE_URL` ও `VITE_SUPABASE_URL`
> inject করে। Environment parameter অবশ্যই `SecureString` (`aws_ssm_parameter.env`)।
> নিচের বর্ণনা ঐতিহাসিক; current state-এর জন্য `compute.tf` ও `variables.tf` পড়ুন।
> Per-tenant Coolify/storage/edge token এখনও operator-এর post-provision
> append (এটি আলাদা, ইচ্ছাকৃত সীমা)।

`infra/aws/terraform/compute.tf`-এর generated SSM environment-এ Supabase URL/key, Coolify URL এবং edge/storage settings আছে; কিন্তু application-এর বাস্তব feature path-এর জন্য প্রয়োজনীয় কিছু configuration সেখানে নেই:

- `CLOUD_WAI_SECRET_ENCRYPTION_KEY` নেই। ফলে project environment variables এবং Git webhook secret path production-এ `engine_unavailable` থাকবে।
- Per-organization Coolify token/project/server/environment values Terraform variables দিয়ে provision করা যায় না; runbook অনুযায়ী apply-এর পরে SSM parameter manually append করতে হবে।
- Per-organization edge tokens-ও একই manual post-provision step-এর ওপর নির্ভর করছে।
- `PUBLIC_SUPABASE_URL` নেই। Bootstrap বর্তমানে browser bundle-এ `SUPABASE_URL` export করে। Hosted Supabase URL হলে এটি কাজ করতে পারে, কিন্তু আলাদা public gateway/self-hosted Supabase origin হলে documented topology এবং actual bundle behavior এক নয়।

**রায়:** Terraform apply সফল হলেও environment variables না পূরণ করলে dashboard উঠবে, কিন্তু Git/env/deployment/security flows আংশিক unavailable থাকবে। Terraform output-কে “platform ready” বলা যাবে না।

**প্রয়োজনীয় সংশোধন:** secret encryption key-কে AWS Secrets Manager/SSM SecureString থেকে explicit input হিসেবে inject করা, public Supabase origin আলাদা variable করা, এবং per-tenant engine credential management-কে manual append-এর বদলে encrypted operator workflow বা control-plane onboarding flow-তে আনা।

### P0 — External deployment engine topology নেই

অন্য system deploy করানোর জন্য Cloud Wai-এর worker যে execution engines-এ call করে সেগুলো external:

- Coolify hosting engine
- MinIO/S3-compatible storage
- security edge / Envoy/Coraza
- database engine
- serverless/Lambda path
- build plane / Railpack-compatible builder

Repository-তে adapter contracts এবং conformance tests আছে, কিন্তু fresh deployment-এ এগুলোর real credentials বা reachable services নেই। `docs/release-gates.md` নিজেই gates 6–9 open রেখেছে।

**রায়:** control-plane UI-তে deployment request তৈরি হওয়া এবং worker job record হওয়া সম্ভব; কিন্তু user-এর repository সত্যিই build/deploy হয়েছে—এমন production proof নেই যতক্ষণ না Coolify/build/runtime engine provision করে end-to-end smoke test চালানো হয়।

### P0 — Builder service deploy stack-এ অন্তর্ভুক্ত নয় — **সমাধান হয়েছে (2026-09-28)**

`infra/deployment/builder-server.mjs` একটি বাস্তব Nixpacks-driven builder, যেটি authenticated এবং Docker socket ব্যবহার করে। audit-এর সময় এটি production topology-তে চালু করার কোনো পথ ছিল না। এখন যোগ/ঠিক করা হয়েছে:

- `infra/deployment/builder.Dockerfile` — Nixpacks binary version ও digest পিন করা, Docker CLI এবং buildx plugin ইনস্টল (buildx ছাড়া Nixpacks build ব্যর্থ হয়)।
- `docker-compose.yml`-এ `builder` service — `build` profile-এ opt-in, শুধু loopback-এ `127.0.0.1:8090`, শুধুমাত্র এটিকেই Docker socket দেওয়া; healthcheck সহ।
- `deploy.sh`-এ `ensure_builder` — token generate, service start, health check, এবং প্রতিটি বিদ্যমান organization-কে wire করা।
- `.env.example`, Terraform `variables.tf`/`compute.tf` SSM template এবং AWS bootstrap-এ builder keys।
- Bounds: `BUILDER_CONCURRENCY`, `BUILDER_BUILD_TIMEOUT_MS`, `BUILDER_MAX_LOG_LINES`, `BUILDER_JOB_TTL_MS` — concurrency, timeout, log truncation, retention; cancel বাস্তবভাবে কাজ করে।
- দুইটি আসল bug ঠিক হয়েছে: `docker run <nixpacks-image> build` (প্রতিটি build-এ ব্যর্থ হতো `executable file not found`) → pinned binary; এবং framework detection `plan.providers[0]` (সবসময় `null`) → `plan.variables.NIXPACKS_METADATA`। দুটোই live build দিয়ে যাচাই করা হয়েছে।
- Operator path ও trust shapes: `docs/runbooks/build-plane.md`; ADR-0018-এ implementation note।

**অবশিষ্ট (সৎ সীমা):** image এখনো local daemon-এ tag হয়, registry push নয়; প্রতি-build CPU/memory limit এই layer-এ নেই (host-এ cgroup বা per-tenant builder দিয়ে enforce করতে হবে); cross-build cache নেই; multi-tenant hardening-এর জন্য builder-per-tenant shape প্রস্তাবিত। বিস্তারিত `docs/runbooks/build-plane.md`-এ।

### P1 — AWS host builds from `main` on the instance

Terraform bootstrap host-এ repository clone করে সেখানে Docker image build করে। এটি শুরু করার জন্য সহজ, কিন্তু production release mechanism হিসেবে দুর্বল:

- immutable image artifact নেই;
- build failure বা partial restart-এর atomic rollback নেই;
- `repo_ref` default `main` drift করতে পারে;
- এক host নষ্ট হলে service downtime;
- ALB দুই AZ-তে থাকলেও application target একটিই;
- NAT gateway-ও single-AZ।

Runbook এই সীমাগুলো honest ভাবে উল্লেখ করেছে, তাই এটি hidden bug নয়। কিন্তু Vercel-grade deployment control plane-এর জন্য release artifact, health-gated rollout, previous-version rollback এবং at least a documented recovery procedure প্রয়োজন।

### P1 — Terraform validation local sandbox-এ সম্পূর্ণ চালানো যায়নি — **এখন locally যাচাই করা হয়েছে**

> **আপডেট (2026-09-28, follow-up pass)।** এবার `terraform` (1.9.8) ইনস্টল করে
> `infra/aws/terraform`-এ **`terraform fmt -check -recursive` (clean)** এবং
> **`terraform init -backend=false` + `terraform validate`
> (`Success! The configuration is valid.`)** চালানো হয়েছে, আর
> `infra/deployment/docker-compose.yml`-এর জন্য **`docker compose config -q`**
> পাস করেছে। অর্থাৎ configuration coherence আর শুধু CI evidence-এর ওপর নির্ভরশীল
> নয় — locally পুনরুৎপাদিত। `terraform apply` এবং live container boot এখনও
> operator-এর AWS account-এ চালাতে হবে; এটা open রয়ে গেছে।

এই audit sandbox-এ `terraform` এবং `docker` CLI ইনস্টল ছিল না। ফলে local `terraform fmt`, `terraform init/validate` এবং `docker compose config` চালিয়ে পুনরায় যাচাই করা যায়নি। Repository CI-তে Terraform job আছে এবং source-level configuration coherent দেখাচ্ছে, কিন্তু এই audit-এর ফল **CI evidence-এর ওপর নির্ভরশীল**। AWS account-এ `terraform apply` বা live container boot এখানে প্রমাণিত হয়নি।

## UI and route coverage assessment

বর্তমান web app আগের inherited summary-এর চেয়ে আলাদা monorepo implementation ব্যবহার করছে। প্রধান route surface বর্তমানে:

- workspace: Projects, Activity, Observability, Billing, API keys, Settings
- project: Overview, Deployments, Domains, Git, Environment, Database, Security, Settings
- database drill-in: Overview, Table Editor, SQL Editor, Authentication, Storage, API, Roles & Extensions, Logs, Settings

Route model URL-driven এবং database drill-in sidebar replace করে, যা Vercel/Supabase-style scope transition-এর সঙ্গে সামঞ্জস্যপূর্ণ। Page implementations `apps/web/src/pages/pages.tsx` এবং `apps/web/src/pages/database.tsx`-এ বাস্তবভাবে আছে। Test suite routes, loading/error/empty state, project scoping, deployment actions, database operations, Git linking, security policy writes, billing and observability reads কভার করে।

তবুও blueprint-এর full surface-এর সঙ্গে তুলনা করলে এখনও product-level differences আছে:

1. Security policy schema এখনও organization-scoped; project navigation-এ Security থাকলেও policy নিজে project-scoped নয়। UI এটি বলে, যা honest, কিন্তু blueprint-এর project security model পুরোপুরি মেলে না।
2. Observability বর্তমানে job throughput/failure/latency এবং recorded logs-এর ওপর নির্ভরশীল; Vercel-style request traces, runtime metrics, long-retention log search বা external drains-এর full platform নেই।
3. Billing usage surface আছে, কিন্তু payment/subscription lifecycle নয়। এটি deliberate এবং নিরাপদ—fake billing যোগ করা উচিত নয়।
4. Domains page domain resource manage করে, কিন্তু registrar/DNS provider execution এবং certificate lifecycle-এর real engine validation ছাড়া complete নয়।
5. Functions/jobs, analytics এবং richer project settings blueprint-এ যতটা বিস্তৃত, current route model-এ ততটা আলাদা first-class surface নয়। এগুলোকে Coming Soon বা Not configured state হিসেবে স্পষ্ট রাখাই সঠিক হবে।

## Recommended release order

### Phase A — Make the AWS deployment path reproducible

1. Add a production `terraform.tfvars` contract that explicitly requires the encryption key source and public Supabase origin.
2. Move secret material out of Terraform state where practical; if SSM value remains in state, enforce encrypted remote backend and restricted state access before apply.
3. Decide whether Supabase is hosted or self-hosted. Do not mix hosted control-plane URLs with a private gateway assumption.
4. Add a deployment smoke test that boots the API, web proxy, worker and health checks on a disposable environment.
5. Pin `repo_ref` to an immutable commit/tag for production.

### Phase B — Make one real deployment path work end to end

1. Provision one Coolify team/resource for a throwaway organization.
2. Configure per-organization Coolify token, project, server and environment.
3. Configure the builder path, or explicitly make Coolify the sole build engine.
4. Deploy a small real Git repository.
5. Verify build output, deployment URL, logs, redeploy, promote and rollback.
6. Record evidence in `docs/release-gates.md`; do not change an open gate to enforced without a failing live-system probe.

### Phase C — Close runtime/security gates

1. Provision real MinIO/S3 and run backup/restore against a disposable tenant resource.
2. Provision the real security edge with a private origin.
3. Run direct-origin denial and CRS attack fixture probes.
4. Verify tenant network/filesystem isolation with real runtime containers.
5. Add external log retention/alerting and an incident drill.

### Phase D — Improve release operations

1. Replace host-side build-from-main with immutable image build and deployment.
2. Add health-gated rollout and rollback.
3. Add a second worker/API host only after queue lease, duplicate execution and shared storage behavior are validated.
4. Add AWS cost and availability decisions for NAT, ALB, EC2 and Supabase.

## Final opinion

কাজটি “শুধু UI বানানো” পর্যায়ে নেই। Architecture, API contracts, RLS, adapter boundaries, worker queue, honest states, tests এবং deployment IaC যথেষ্ট serious ভিত্তি তৈরি করেছে। এই কারণে এটিকে demo বা template বলা ঠিক হবে না।

কিন্তু একই কারণে production claim-এ আরও কঠোর হতে হবে। **আজকের codebase দিয়ে dashboard/API deploy করা সম্ভব; আজকের default infrastructure দিয়ে Vercel-এর মতো arbitrary repository build এবং deploy করানো প্রমাণিত নয়।** সবচেয়ে জরুরি কাজ হলো নতুন UI নয়—একটি throwaway tenant-এর জন্য Coolify/build/runtime path end-to-end সত্যি চালানো, AWS Terraform environment gaps বন্ধ করা, এবং সেই evidence release gates-এ সংরক্ষণ করা।

এই audit অনুযায়ী আমি এখনই বড় frontend rewrite করার পরামর্শ দিচ্ছি না। পরবর্তী engineering milestone হওয়া উচিত **one real deployment path, one real engine, one real rollback, one real backup restore**। এগুলো সফল হলে platform-এর বাকি breadth যুক্ত করা নিরাপদ হবে।

### Follow-up pass (2026-09-28)

এই audit-এর পরের pass-এ নিচের কাজ সম্পন্ন, এবং সব evidence `pnpm verify`
(916 tests / 54 files, green) ও live host-এ পুনরুৎপাদিত:

- **AWS Terraform environment gaps বন্ধ** — `cloud_wai_secret_encryption_key`
  (`sensitive`, 43-char validation) ও `public_supabase_url` variable যোগ, এবং
  `compute.tf`-এর SSM template-এ `CLOUD_WAI_SECRET_ENCRYPTION_KEY`,
  `PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL` inject (`SecureString`)।
- **Builder service deploy stack-এ** — pinned Nixpacks builder image, opt-in
  compose profile, `deploy.sh` wiring, এবং দুইটি আসল build bug fix।
- **CI-gate regression** — four unformatted files (format:check failure) fix।
- **Terraform + compose locally যাচাই** — `terraform fmt -check -recursive`
  clean, `terraform validate` success, `docker compose config -q` pass
  (উপরে P1 আপডেট দ্রষ্টব্য)।
- **Deploy-script reliability bugs (D10, D11)** — pidfile ভুল pid ধরত (setsid
  parent), তাই `status` একটা চলমান service-কে "down" দেখাত এবং `down`/restart
  সেটা বন্ধ করতে পারত না; এখন wrapper নিজের pid লেখে ও service `exec` করে।
  দ্বিতীয়ত, `status`-এর `kill -0` liveness test একটা zombie-কে "up" দেখাত
  (exit করা কিন্তু reaped না হওয়া process); এখন `/proc/<pid>/stat`-এর `Z` state
  down হিসেবে গণ্য হয়। live host-এ verified (api/worker/edge/gateway সব up,
  dashboard/api/gateway 200)।
- **Test count** — 910/53 থেকে 916/54 (`tests/deployment/deploy-script.test.ts`
  যোগ হয়েছে)।

অপরিবর্তিত open gate: live external engine validation (Coolify/MinIO/edge/
runtime) — gate 6–9, অর্থাৎ `terraform apply` ও one real deployment path এখনও
operator-এর AWS account-এ চালাতে হবে।


## References

[1]: https://github.com/wasimmostakim2965-ui/USCS "USCS / Cloud Wai source repository"
[2]: https://github.com/wasimmostakim2965-ui/USCS/blob/main/docs/release-gates.md "Cloud Wai release gate evidence"
[3]: https://github.com/wasimmostakim2965-ui/USCS/blob/main/docs/runbooks/deploy-aws.md "Cloud Wai AWS deployment runbook"
[4]: https://github.com/wasimmostakim2965-ui/USCS/blob/main/infra/aws/terraform/compute.tf "Cloud Wai AWS compute and environment Terraform"
[5]: https://github.com/wasimmostakim2965-ui/USCS/blob/main/infra/deployment/builder-server.mjs "Cloud Wai builder service"
[6]: https://github.com/wasimmostakim2965-ui/USCS/blob/main/apps/api/src/bootstrap.ts "Cloud Wai API production bootstrap"
[7]: https://github.com/wasimmostakim2965-ui/USCS/blob/main/apps/web/src/navigation.ts "Cloud Wai web navigation model"
