# The recipe book

How to build a Vercel-class platform, assembled from the real sources rather
than from one vendor's documentation. This is the "one place" that joins the
pieces: the pattern we are copying, what we copied exactly, what we deliberately
did not, what it costs, how to put it on a permanent server, and how to verify
each claim yourself.

Every claim from outside this repository carries a source link. Every claim about
*this* system names the file, migration or test that proves it in the repository
itself. If a thing is not built, it says so and says why — the same rule the rest
of the codebase follows.

Read this with `AGENTS.md` open: that file is the durable record of what changed
and what is still open. This book is the map; `AGENTS.md` is the changelog.

---

## 1. The formula, reduced

A Vercel is five moving parts and one idea:

| Part | What it does | The open pattern |
| --- | --- | --- |
| **Build plane** | Turns a git commit into a runnable artifact | Nixpacks / buildpacks / Dockerfile ([docs](https://nixpacks.com/docs)) |
| **Artifact host** | Runs the built thing and answers HTTP | containers (ECS, Fly, Coolify) or functions (Lambda) |
| **Edge** | Terminates TLS, routes by hostname, caches | CDN + reverse proxy (CloudFront, Traefik, Caddy) |
| **Control plane** | Accounts, projects, domains, deploys, billing | the part that is *yours*; Vercel's is closed |
| **Data plane** | Postgres, storage, queue | managed or self-run |

The idea underneath all of it: **a git push is the interface, and every
deployment is immutable.** Vercel classifies the build output into static assets,
serverless functions and edge functions, deploys the whole set atomically and
switches traffic with no downtime — the Build Output API is a filesystem
contract (`.vercel/output`) that lets any framework target that machinery
([Vercel, Build Output API](https://vercel.com/blog/build-output-api),
[configuration reference](https://vercel.com/docs/build-output-api/configuration)).

We keep the push-to-deploy interface and the immutability. We drive it from our
own control plane, so the router, the security edge and the billing are ours to
change.

## 2. What we copied exactly, and from where

- **Nixpacks, not a bespoke builder.** The build plane is
  `infra/deployment/builder-server.mjs`, a bounded, authenticated HTTP service
  around the pinned Nixpacks binary. Nixpacks detects the language from marker
  files, generates a build plan, and converts it to a Dockerfile it builds with
  BuildKit ([how builds work](https://nixpacks.com/docs/configuration/file)).
  One shared builder is a shared trust boundary — the daemon is shared — which is
  recorded honestly in `AGENTS.md` and `docs/runbooks/build-plane.md`. Do not
  describe it as a hard multi-tenant boundary.
- **A self-hosted runtime for the artifact.** `infra/deployment/runtime-server.mjs`
  clones the source, drives the build plane, runs the image and reports the real
  status, URL and logs, behind the same `HostingAdapter` port a Coolify adapter
  would use (`packages/adapters/src/selfhosted.ts`, ADR-0020). Coolify is the
  proof the pattern works on one box: it is an open-source PaaS that installs on
  a fresh VPS with one command, builds with Nixpacks, and serves HTTPS through
  Traefik ([Coolify install](https://coolify.io/docs/installation)).
- **Route + policy compiled to an edge artifact.** Our differentiator (section
  5): the WAF/deny/allow ladder is compiled by us and shipped to an Envoy edge,
  rather than rented as a black box.
- **Envoy as the edge runtime.** `SECURITY_EDGE_URL` + `EDGE_HOSTNAME` wire a
  real edge through `createEnvoySecurityEdge`; absent, the edge reports the
  honest `not_configured` (`.env.example`, `packages/adapters`).

## 3. What we deliberately did not copy

- **We do not self-build a security edge from config.** It needs resolvers the
  API owns (a route's host, a policy's level), so it is injected, never assumed.
  An absent edge is `not_configured`, never a fake green.
- **We do not fake an engine to make a deployment look healthy.** Every adapter
  defaults to `not_configured` when credentials are absent; the fakes are refused
  in production (`buildEngines({ useFakes: true, nodeEnv: "production" })` throws).
- **We do not terminate tenant TLS in the control plane.** The engine provisions
  it; the control plane records the domain and its state (in-dashboard docs →
  Domains).
- **We do not buy domains yet.** A reseller registration flow is deferred; the
  Domains page carries a search box that answers about the *query*, never invents
  availability (section 7).

## 4. The build engine: the failure we hit, and the exact fix

**Symptom.** A repository whose only directory is `.git` is misdetected by
Nixpacks as `Using subdirectory ".git"` and the build fails. This is a real
Nixpacks 1.41.0 heuristic, confirmed here by a failing build. (A normal repo with
a `package.json` at its root builds fine — a proof deploy of
`heroku/nodejs-getting-started` returned HTTP 200 and the UI showed **Live**.)

**Why it happens.** Nixpacks treats a repo with a single top-level directory as a
monorepo and descends into it; `.git` is the only directory, so it descends into
version control metadata.

**The fix, by shape.** Nixpacks lets a repository own its build plan through
`nixpacks.toml`, merged *over* the auto-detected plan, with `"..."` meaning
"keep the auto-detected values here" ([configuration file reference](https://nixpacks.com/docs/configuration/file),
[configuring builds](https://nixpacks.com/docs/guides/configuring-builds)):

```toml
# Force a plan when detection is wrong. `"..."` extends, it does not discard.
providers = ["...", "node"]

[phases.setup]
nixPkgs = ["...", "nodejs_20"]

[phases.build]
cmds = ["pnpm install --frozen-lockfile", "pnpm build"]

[start]
cmd = "pnpm start"
```

For a **static site**, the honest shape is not a fake server: build with the
static provider and serve the directory, exactly as Coolify/ZaneOps do (a Caddy
on Alpine file-server image with the assets copied in,
[ZaneOps](https://zaneops.dev/knowledge-base/builders/nixpacks-builder)). Our own
web bundle is static and Vercel-shaped (`vercel.json` → `outputDirectory:
apps/web/dist/browser`).

**pnpm-specific trap.** Nixpacks and pnpm disagree on `PNPM_HOME`; the working
value is `/app/.pnpm` ([Sevalla note](https://docs.sevalla.com/applications/build-options/nixpacks)).
Set it in `nixpacks.toml` under `[variables]`.

**What remains (honest).** The builder detects and builds; it does not yet let a
customer *override* the detected plan from the dashboard. A customer who needs a
custom plan must currently ship a `nixpacks.toml`. Making that editable is
untracked work, not a hidden feature.

## 5. The edge: the part Vercel treats as a black box

This is where we can beat the incumbent rather than match it. Vercel sells a
Firewall with a rule count that scales by plan (3 on Hobby, 40 on Pro, 1,000 on
Enterprise, [pricing breakdown](https://www.stackscored.com/pricing/dev-hosting/vercel)).
We own the compiler, so the policy is not a plan-tier limit.

What is real here:

- A policy is saved, compiled and distributed. `security.policy.distribute` is a
  durable job; the worker executes it off the request path.
- The allow ladder leads the compiled rules: a forward-confirmed bot, an internal
  request and a trusted address are exempted before deny, rate-limit and
  challenge steps — so a crawler or a webhook sender is not collateral damage.
  The exact ordering, and the three cases where "allow" must also defeat a deny
  rule, are in `AGENTS.md` and pinned by tests.
- A refused distribution opens a `security_incident` through the service role, so
  an operator sees a case to close rather than a log line (`0019`, `24_incident_probe.sql`).
- The last mile that is **not** done: an Envoy host must read the compiled
  fragment's `skipChallengeAddresses` / `skipChallengeForVerifiedBots` /
  `protection` fields and act on them. Until it does, turning attack mode on
  still challenges a customer's own webhook sender. Recorded in `AGENTS.md`; do
  not claim the edge is complete.

The claim we can make honestly to an investor: **the security posture is
compiled by us and portable, not a rented black box** — and we say exactly which
piece still needs a live host.

## 6. Renting a real server

Three shapes, from cheapest to most managed. This is the "deep" deployment the
product is built for.

### Shape A — one VPS (fastest to a public URL)

A single box runs the whole product: Postgres, the API, the worker, the edge and
the gateway. Real entry prices, from the providers' own pages:

| Provider | Plan | Spec | Price |
| --- | --- | --- | --- |
| DigitalOcean | Basic Droplet | 1 vCPU / 1 GiB / 1 TB | $6/mo ([pricing](https://www.digitalocean.com/pricing/droplets)) |
| DigitalOcean | Basic Droplet | 2 vCPU / 4 GiB / 4 TB | $24/mo (same page) |
| Hetzner | CPX22 | 2 vCPU / 4 GiB / 20 TB | €7.99/mo, ~$9.49 ([comparison](https://betterstack.com/community/guides/web-servers/digitalocean-vs-hetzner)) |
| Hetzner | CAX11 (ARM) | 2 vCPU / 4 GiB | ~$4.35/mo ([VPS survey](https://shattered.io/cheapest-cloud-vps-2026-provider-comparison)) |
| Vultr | Cloud Compute | 1 GiB | $5/mo (same survey) |

Coolify itself wants ~750 MB–1.2 GB of RAM before your app, so a 2 GB box is the
practical floor and 4 GB is the comfortable one; Coolify's own install guide is
the source for the requirements ([Coolify installation](https://coolify.io/docs/installation)).
Our own stack is heavier (Supabase + worker + edge), so **4–8 GB** is the honest
recommendation for Shape A.

### Shape B — AWS, as code

`infra/aws/terraform/` is the environment as code: a VPC, a private host, an ALB
with ACM, Route 53, SSM config and CloudWatch. The compute host defaults to
`t3.small` (`variables.tf`), which is 2 vCPU / 2 GiB at **$0.0209/hr on-demand**
([AWS T3 instance types](https://aws.amazon.com/ec2/instance-types/t3)) — about
$15/month if left running. Real AWS notes:

- **Free tier:** 750 hours/month of `t2.micro`, or `t3.micro` where `t2.micro` is
  unavailable, for 12 months; usage is shared across all instances and EBS beyond
  30 GB is billed ([EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand),
  [free-tier traps](https://oneuptime.com/blog/post/2026-02-12-use-aws-free-tier-effectively/view)).
  `t3.micro` at 1 GiB will not run the full stack comfortably; treat it as a
  smoke test, not production.
- **Billing** is per-second for Linux, from launch to terminate. Reserved
  instances cut the rate roughly in half and spot to about 40% of on-demand
  ([Vantage t3.micro](https://instances.vantage.sh/aws/ec2/t3.micro)); spot can
  be reclaimed, so it is wrong for a control plane.
- Read `docs/runbooks/deploy-aws.md` and ADR-0015 before changing the AWS shape.
  Both shapes run the same `infra/deployment/docker-compose.yml`, so they cannot
  drift into two products.

### Shape C — split, for scale

The AWS-native version of Vercel, assembled from primitives: builds on
CodeBuild/CodePipeline, static output on S3, global delivery and cache on
CloudFront, dynamic routes on Lambda or ECS behind an ALB, images optimised at
the edge ([a worked Next.js-on-AWS architecture](https://www.oshyn.com/blog/netlify-vercel-alternatives),
[ECS + CloudFront pattern](https://www.reddit.com/r/aws/comments/1lb6yan/is_it_possible_to_selfhost_a_nextjs_app_on_aws)).
SST is the closest off-the-shelf "Vercel DX on your own AWS account" framework
([SST/Ion overview](https://use-apify.com/blog/vercel-alternatives-2026)).
This shape is a scale decision, not a launch requirement.

## 7. The domain public step (DNS + TLS)

Making the system public is three moves: point DNS, get a certificate, route the
hostname. The three places this can live:

1. **On the box (Shape A).** Caddy obtains and renews Let's Encrypt certificates
   by default, with no separate ACME config ([Caddy vs Traefik](https://dokploy.com/blog/caddy-vs-traefik-vs-nginx));
   Traefik does the same through a certificate resolver. Certbot still works but
   is the manual route. This is the shortest path to a public HTTPS host.
2. **On AWS (Shape B).** Route 53 holds the record, ACM issues the certificate,
   the ALB terminates TLS. `infra/aws/terraform/tls.tf` is this, in code.
3. **In front (either).** Cloudflare's free plan issues an unshared Universal SSL
   certificate covering the apex and first-level subdomains once the record is
   proxied, and renews it automatically
   ([Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl),
   [enable it](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/enable-universal-ssl)).
   Proxy only A/AAAA/CNAME that serve web traffic
   ([proxy status](https://developers.cloudflare.com/dns/proxy-status)).

The Vercel pattern we mirror: adding a domain shows the DNS records to create,
verifies once they propagate, and then issues a certificate; a domain bought
through the platform is configured automatically
([working with domains](https://vercel.com/docs/domains/working-with-domains),
[SSL](https://vercel.com/docs/domains/working-with-ssl)). Our Domains page does
the first half honestly — it shows the record, verification is a real DNS check,
and an unverified domain is a pending step, not an error. Buying a domain is the
deferred reseller flow.

**Browser-bundle trap (verified here, 2026-09-28).** The web bundle bakes
`VITE_SUPABASE_URL` at build time. A loopback value makes the dashboard hang on
"Connecting to Cloud Wai…" because the browser cannot resolve it. Rebuild with
the public origin before you expose the host (`AGENTS.md`, "Single-host deploy").

## 8. The business logic and the money

Vercel's model, from its own changelog and third-party breakdowns: a per-seat fee
plus granular usage meters. Pro is **$20/seat/month**, bundling 1 TB bandwidth,
10 M edge requests and a $20 usage credit; overages are roughly $0.15/GB
bandwidth, $2 per 1 M edge requests, and function invocations billed per unit at
$0.0000006 each ([Vercel changelog](https://vercel.com/changelog/function-invocations-now-billed-per-unit),
[plan breakdown](https://www.stackscored.com/pricing/dev-hosting/vercel),
[cost scenarios](https://deploywise.dev/blog/vercel-pricing-explained)).

**Why a team leaves.** Bandwidth is the cliff: a 4-person team at ~1.5 TB/month
lands near **$286/month**, where the same traffic on a $10 Hetzner VPS is ~$10
([cost scenarios](https://deploywise.dev/blog/vercel-pricing-explained)). Vercel's
own plan structure caps firewall rules and custom environments by tier, pushing
security features to Enterprise ([plan breakdown](https://www.stackscored.com/pricing/dev-hosting/vercel)).

**The position that follows for us.** The whole point of Cloud Wai is software
that *is* the business — you can operate it, and it meters providers the same way
`packages/database` meters engines. What is real here:

- **Budgets with a hard cap.** `hardCapRefusal` (`apps/api/src/procedures/billing.ts`)
  gates *every* trigger that builds: `deployments.create`, `deployments.rollback`
  and the git webhook all refuse with `budget_exceeded` (402) before a row or job
  exists; `data.backup` calls the same helper for the `backups` metric. A soft
  budget blocks nothing anywhere. The cap is a property of the organization's
  work, not of one button.
- **Usage is metered per dimension**, the same shape Vercel bills in, so a
  per-seat + usage model is a pricing decision on top of real numbers, not a
  number we invent.

**What remains.** We do not have a card-on-file/payment integration, and there is
no claim of one. Budgets and the hard cap are real; collecting money is not
built. Say that plainly.

## 9. Verify it yourself

The commands that keep this book honest — run them, do not trust the prose:

```sh
pnpm install
pnpm verify            # build + typecheck + tests (no Docker needed)
pnpm verify:all        # adds the RLS isolation probe; needs Docker
pnpm format:check

# The build-engine claim (section 4), end to end:
#   a repo with only .git fails detection; one with package.json at the root succeeds.

# The domain publish / TLS claim:
./infra/deployment/deploy.sh deploy   # ends by probing dashboard/api/gateway, printing 200
```

Tests that pin the claims in this book, by section:

- Build-plane bounds and the Docker-socket restriction: `tests/deployment/build-plane.test.ts`
  (gate 15) and `docs/runbooks/build-plane.md`.
- Engine honesty and the one-port/two-engines rule: `tests/engines/wiring.test.ts`.
- The hard cap on every trigger: `apps/api/src/procedures/billing.ts` and its tests.
- Incident lifecycle, database side and procedure side:
  `tests/isolation/rls/24_incident_probe.sql`, `tests/isolation/data-security-writes.test.ts`.
- The in-dashboard docs map to real routes and menu: `tests/web/dashboard.e2e.test.tsx`
  ("the in-dashboard documentation").
- Sign-in provider honesty: `tests/web/login-providers.test.tsx`.

## 10. Source index

Vercel: [Build Output API](https://vercel.com/blog/build-output-api) ·
[Build Output configuration](https://vercel.com/docs/build-output-api/configuration) ·
[domains](https://vercel.com/docs/domains/working-with-domains) ·
[SSL](https://vercel.com/docs/domains/working-with-ssl) ·
[function-invocation pricing](https://vercel.com/changelog/function-invocations-now-billed-per-unit)

Nixpacks: [config file](https://nixpacks.com/docs/configuration/file) ·
[configuring builds](https://nixpacks.com/docs/guides/configuring-builds) ·
[2.0 discussion](https://github.com/railwayapp/nixpacks/discussions/888)

Self-hosting: [Coolify installation](https://coolify.io/docs/installation) ·
[Coolify on a VPS, step by step](https://massivegrid.com/blog/how-to-install-coolify-on-vps) ·
[ZaneOps nixpacks builder](https://zaneops.dev/knowledge-base/builders/nixpacks-builder) ·
[Sevalla nixpacks notes](https://docs.sevalla.com/applications/build-options/nixpacks)

AWS: [EC2 on-demand pricing](https://aws.amazon.com/ec2/pricing/on-demand) ·
[T3 instance types](https://aws.amazon.com/ec2/instance-types/t3) ·
[EC2 FAQs](https://aws.amazon.com/ec2/faqs) ·
[free-tier traps](https://oneuptime.com/blog/post/2026-02-12-use-aws-free-tier-effectively/view) ·
[Next.js on AWS](https://www.oshyn.com/blog/netlify-vercel-alternatives)

TLS/DNS: [Caddy vs Traefik](https://dokploy.com/blog/caddy-vs-traefik-vs-nginx) ·
[Cloudflare Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl) ·
[Cloudflare proxy status](https://developers.cloudflare.com/dns/proxy-status)

Cost/positioning: [plan breakdown](https://www.stackscored.com/pricing/dev-hosting/vercel) ·
[cost scenarios](https://deploywise.dev/blog/vercel-pricing-explained) ·
[pricing history](https://usagepricing.com/blueprint/vercel) ·
[provider comparison](https://betterstack.com/community/guides/web-servers/digitalocean-vs-hetzner) ·
[VPS survey](https://shattered.io/cheapest-cloud-vps-2026-provider-comparison)
