# ADR-0015 — AWS hosting: a load-balanced single host, defined as code

- Status: accepted
- Date: 2026-09-25

## Context

Cloud Wai runs on a single host: `infra/deployment/docker-compose.yml` brings up
the dashboard, the API and the worker; the control plane is Supabase and the
engines are external (ADR-0004, ADR-0011). `docs/runbooks/deploy.md` documents
that host by hand.

The brief asks for the software to be hosted on an AWS environment "the way
Vercel hosts on its own infrastructure" — that is, as a managed, reproducible
deployment rather than a machine someone configured. Two things follow: the
host shape has to exist as code someone can review and re-apply, and the manual
step it replaces has to be named, not glossed.

The repository already carries a real deployment bug worth recording: the
`.env.example` template, which the runbook tells an operator to copy to `.env`,
could not be parsed by `docker compose` at all. The per-organization keys were
written as live assignments with `<organizationId>` in the key, and Compose's
dotenv reader rejects `<` in a variable name:

```text
failed to read .env: unexpected character "<" in variable name "COOLIFY_TOKEN__<organizationId>=..."
```

So "follow the runbook and the deployment starts" was false at the first step.
An environment description that cannot be loaded is the same class of error as a
dashboard that reports success for work no engine performed: it asserts a state
that does not hold. This ADR fixes it and adds a check, because the shape of the
mistake (a template that is documentation rather than a loadable file) recurs.

## Decision

1. **`infra/aws/terraform/` describes the host environment.** One module: a
   two-tier VPC, one application host in a private subnet, an ALB with an
   ACM-terminated HTTPS listener, Route 53 records, SSM-held configuration and
   CloudWatch log shipping. It is validated in CI with `terraform fmt -check` and
   `terraform validate`, so a broken reference fails the build rather than a
   deploy.
2. **The application host runs the existing compose file.** The AWS shape and
   the runbook shape are the same topology — dashboard, API, worker on one host,
   Supabase and the engines external — so the two cannot drift into two products.
   A different orchestrator (ECS/Kubernetes) is not introduced, because nothing
   in the product needs it yet and it would fork the deployment.
3. **The origin is private.** The host has no public IP, no internet-gateway
   route and no inbound rule except the ALB on the dashboard port. Gate 6 (deny
   direct origin) becomes a property of the topology: there is no address to
   reach. It still stays **open** in `docs/release-gates.md`, because the gate's
   evidence is an edge-observed denial, and this repository does not delete an
   open gate to make the release look safer.
4. **Access is Session Manager, not SSH.** The instance profile carries
   `AmazonSSMManagedInstanceCore`, the SSM interface endpoints are in the VPC,
   and SSH opens only when an operator supplies both a key and a CIDR list.
   The default posture has no SSH door.
5. **Configuration is a SecureString, not a file in git.** The container
   environment is an SSM parameter written by Terraform and read by the host's
   bootstrap through the instance profile. The per-organization engine keys are
   appended to it after provisioning, because the template cannot express a key
   containing `<organizationId>` (see the bug above) — so the runbook shows the
   `put-parameter` that adds one and re-bootstraps the host.

## Consequences

- **State holds secrets.** The SSM parameter's value is in Terraform state, so
  the state file is as sensitive as `.env`. It is git-ignored, and the runbook
  instructs an encrypted remote backend (`encrypt = true`) before the first real
  apply. A local-only state file on an operator's laptop is not acceptable for a
  production apply, and the runbook says so.
- **One NAT gateway.** The private subnet's egress is a single NAT in the first
  public subnet, so an AZ outage takes egress with it. This is a deliberate cost
  trade for a single-host deployment; the second NAT is the availability upgrade
  and is named in the runbook rather than silently absent.
- **One application host.** The ALB spans two AZs but the target does not, so an
  instance failure is downtime until it is replaced. Scaling to a second host
  needs the control plane's job queue semantics to be revisited first — two
  workers on one queue is fine (the lease is in SQL, gate 3), two APIs are fine
  (they are stateless), but the dashboard's build-on-host bootstrap is not. That
  is recorded here rather than presented as done.
- **Terraform validate is not Terraform apply.** CI proves the configuration is
  coherent; it does not prove an AWS account accepted it. The runbook's first
  apply is the operator's, and the repository must not claim otherwise.
- **A new check exists for the template bug.** `tests/deployment/env-template.test.ts`
  applies a dotenv parser's rule to `.env.example`, so a placeholder written as
  a key fails the suite instead of a host.

## Acceptance evidence

- `infra/aws/terraform/` — `terraform fmt -check` and `terraform validate` pass
  (CI job `terraform`).
- `tests/deployment/env-template.test.ts` — fails on the pre-fix template.
- `docs/runbooks/deploy-aws.md` — the operator path, including the state-backend
  and per-tenant-key steps this ADR names.
- Two real container facts, checked by hand and recorded in the runbook: the API
  image exits `1` with no control plane configured, and the dashboard image
  serves `/healthz` and a deep link without a container rebuild.
