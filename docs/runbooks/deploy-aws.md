# Deploying Cloud Wai on AWS

This runbook takes the repository to a running, internet-reachable deployment on
AWS with a load-balanced HTTPS entry point. It is the AWS form of
`docs/runbooks/deploy.md`; the host it provisions runs the *same* compose file,
so the two runbooks describe one product, not two.

Read `docs/adr/0015-aws-hosting.md` first — it records why the shape is what it
is, and what it deliberately does not do (no autoscaling, one NAT, one host).

Nothing here claims a release gate the repository cannot prove. Gates 6–9 stay
**open** until a real engine closes them (see `docs/release-gates.md`). The
private-subnet topology is evidence *toward* gate 6, not the gate itself: the
gate's proof is an edge-observed denial.

## 0. What you need

- An AWS account and credentials that can create VPC, EC2, ELB, ACM, Route 53,
  IAM, S3, CloudWatch and SSM resources.
- A domain name. If it lives in Route 53 in this account, pass
  `route53_zone_id` and DNS is wired automatically. If not, create the
  certificate validation records by hand (Terraform waits for validation).
- A Supabase project (the control plane). Apply `supabase/migrations/*.sql` to
  it in numeric order first — see step 3 of `deploy.md` — and keep the anon and
  service-role keys.
- Terraform >= 1.6 and the AWS provider (CI pins the provider to `~> 5.60`).

## 1. Remote state, before anything else

The state file contains the SSM parameter value, which contains the service-role
key. Do not apply against local state for a real environment.

```bash
# A one-time bucket for state, encrypted and versioned.
aws s3api create-bucket --bucket "$TF_STATE_BUCKET" --region "$AWS_REGION" \
  --create-bucket-configuration LocationConstraint="$AWS_REGION"
aws s3api put-bucket-versioning --bucket "$TF_STATE_BUCKET" \
  --versioning-configuration Status=Enabled
```

Then add a backend block to a new file `infra/aws/terraform/backend.tf`:

```hcl
terraform {
  backend "s3" {
    bucket       = "REPLACE-with-your-state-bucket"
    key          = "cloud-wai/prod/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
```

`backend.tf` is intentionally not committed: the bucket name is account-specific,
and a wrong default is worse than a required edit.

## 2. Values

Create `infra/aws/terraform/terraform.tfvars` (git-ignored — it holds keys):

```hcl
project     = "cloud-wai"
environment = "prod"
region      = "us-east-1"

domain_name     = "app.example.com"
route53_zone_id = "Z0123456789ABCDEFGHIJ"   # empty if DNS lives elsewhere

instance_type = "t3.small"

supabase_url              = "https://<project>.supabase.co"
supabase_anon_key         = "<anon key>"
supabase_service_role_key = "<service-role key>"

# Engines are optional. An empty value leaves that engine not_configured, which
# the dashboard shows honestly. Set one to close its gate, not to fill the UI.
coolify_url       = ""
storage_endpoint  = ""
# The edge needs both the admin URL and the private origin it forwards to; a URL
# alone stays not_configured, because the origin is what the edge exists to hide.
security_edge_url    = ""
security_edge_origin = ""   # private address, e.g. "http://10.0.1.20:8080"
edge_hostname        = ""

# SSH is off by default; Session Manager is the access path.
ssh_public_key   = ""
admin_cidr_blocks = []
```

## 3. Apply

```bash
cd infra/aws/terraform
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

The apply ends with the outputs you need:

```text
dashboard_url     = "https://app.example.com"
load_balancer_dns = "cloud-wai-prod-1234567890.us-east-1.elb.amazonaws.com"
instance_id       = "i-0123456789abcdef0"
env_parameter_name = "/cloud-wai/prod/env"
```

If DNS is not in Route 53 in this account, point `domain_name` at
`load_balancer_dns` with a CNAME at your provider, and create ACM's validation
records by hand.

## 4. Watch the first boot

The host installs Docker, reads its environment from SSM, clones the repository
at `repo_ref`, builds and starts the compose stack. Its log is on the instance:

```bash
aws ssm start-session --target "$(terraform output -raw instance_id)"
# on the host:
sudo tail -f /var/log/cloud-wai-bootstrap.log
sudo docker compose -f /opt/cloud-wai/repo/infra/deployment/docker-compose.yml ps
```

The bootstrap **fails closed**: if the SSM parameter is missing or has no
`SUPABASE_URL`, it exits before starting containers, so the load balancer never
marks a do-nothing host healthy.

## 5. Configure per-organization engines

The template cannot express `COOLIFY_TOKEN__<organizationId>` as a key — Compose
and dotenv reject `<` in a variable name (that bug is why
`tests/deployment/env-template.test.ts` exists). Append real keys to the SSM
parameter instead, then re-bootstrap:

```bash
# Read the current value, append the tenant's keys, write it back.
aws ssm get-parameter --name /cloud-wai/prod/env --with-decryption \
  --query Parameter.Value --output text > /tmp/cw-env
cat >> /tmp/cw-env <<'ENV'
COOLIFY_URL=https://coolify.example.com
COOLIFY_TOKEN__f1a2b3c4=<team-scoped token>
COOLIFY_PROJECT_UUID__f1a2b3c4=<project uuid>
COOLIFY_SERVER_UUID__f1a2b3c4=<server uuid>
STORAGE_ENDPOINT=https://minio.example.com
STORAGE_ACCESS_KEY__f1a2b3c4=<access key>
STORAGE_SECRET_KEY__f1a2b3c4=<secret key>
SECURITY_EDGE_TOKEN__f1a2b3c4=<edge admin token for this tenant>
ENV
aws ssm put-parameter --name /cloud-wai/prod/env --type SecureString \
  --overwrite --value "file:///tmp/cw-env"
rm /tmp/cw-env

# Re-run the bootstrap so the containers pick the change up.
aws ec2 reboot-instances --instance-ids "$(terraform output -raw instance_id)"
```

### The edge's obligation to the verified-bot allow

The compiled policy allows a crawler only when **two** conditions hold: the
`User-Agent` matches, and `tx.cloud_wai_bot_confirm` ends with the operator's
suffix **at a DNS label boundary**. Coraza cannot do a reverse-DNS lookup, so the
edge host must populate that variable before the WAF runs, and it must do it
honestly:

1. Reverse-resolve `REMOTE_ADDR` and require the PTR name to sit under the
   operator's suffix **at a DNS label boundary** (so `googlebot.com.attacker.net`
   and `evilgooglebot.com` both fail).
2. Forward-resolve that exact PTR name and require it to return the original
   address. A PTR record alone is trivially forged; this second step is what
   makes the claim trustworthy.
3. Only then set `tx.cloud_wai_bot_confirm` to the **forward-confirmed hostname**
   (e.g. `crawl-66-249-66-1.googlebot.com`), not to the suffix.

Step 3 matters as much as the rest: the compiled member matches the variable as a
label-boundary suffix (`@rx (^|\.)googlebot\.com$`), because the confirmed name is
always longer than the suffix the operator configured. Setting the variable to
the bare suffix would still match, but recording the actual confirmed hostname is
what makes the decision auditable.

Set it from the DNS answer, **never** from an inbound header: a header is
attacker-controlled, and a value the attacker chooses would make the second
condition tautological and reopen the `User-Agent: Googlebot` bypass the chain
exists to close. If the lookup fails or times out, leave the variable unset — the
chain then does not match, no allow is granted, and the request falls through to
the challenge and the WAF. Fail closed.

Because the allow is a real Coraza chain, a deployment that sets nothing keeps
the SEO behaviour only if it also keeps attack mode off. Turning attack mode on
without this step challenges every crawler. That is why it is written down here
rather than left to the operator to infer.

### The edge's obligation to the challenge skip

Attack mode is enforced by Envoy, which serves the interstitial. Envoy runs
*before* the WAF, so the Coraza markers (`tx.cloud_wai_trusted`,
`tx.cloud_wai_bot`) cannot tell it whom to skip — they are set too late. Each
route fragment therefore names the exemptions directly:

- `skipChallengeAddresses` — the validated address literals the customer trusts
  (their webhook senders and CI runners). Match these against the connection's
  remote address, exactly as the WAF does. Without this, turning attack mode on
  locks out the customer's own integrations.
- `skipChallengeForVerifiedBots` — a flag, not a list. When true, the edge must
  skip the interstitial for a request whose crawler identity it has itself
  confirmed by the reverse-then-forward DNS check above. Do **not** substitute a
  `User-Agent` pattern here: Envoy cannot do the DNS confirmation, so a UA match
  alone would let a scraper that sets `User-Agent: Googlebot` skip the
  interstitial — the bypass the WAF chain exists to close.

Both fields are emitted in every mode (the address list is populated whenever
trusted sources exist), so a fragment is self-describing even when
`challengeBrowsers` is false.

### The edge's obligation to the WAF threshold

The compiled WAF rule reads `TX:BLOCKING_INBOUND_ANOMALY_SCORE` and compares it
to `tx.inbound_anomaly_score_threshold`, which the same artifact sets in phase 1
from the customer's risk level. Two things the edge host must get right, or the
rule is inert and the customer's "block" does not block:

1. **Run the directives after the CRS files that accumulate the score.** The
   accumulator is written by the CRS rules in phase 2 (`REQUEST-9xx`), and the
   CRS's own `REQUEST-949-BLOCKING-EVALUATION.conf` is what normally consumes it.
   This artifact's phase-2 rule must be included after those, so the score is
   populated when it runs. Include the CRS first, then the policy artifact; a
   policy included before the rules it scores sees an empty variable and never
   matches.
2. **Do not rename the variables.** They are the CRS 4 names, and the pinned
   ruleset is CRS 4.30.0-dev (ADR-0007). `tx.anomaly_score` is a derived value
   CRS 4 sets in phase 5, after phase 2 — reading it here is the mistake this
   contract exists to prevent, and it silently disables the rule rather than
   failing loudly. The phase-1 `SecAction` overrides the CRS default threshold of
   5, so the customer's chosen sensitivity wins; a deployment that strips it gets
   the default, not the customer's value.

If the compiled rule does not fire, an operator sees attacks allowed and the
customer's action ignored — with no error anywhere. Verify it the way gate 7
will: send a CRS fixture and confirm the deny, rather than assuming the include
order is right.

### The edge's obligation to the ASN deny

A deny rule of kind `asn` compiles to `SecRule TX:CLOUD_WAI_ASN "@streq AS15169"`,
because Coraza has no way to map a source address to the network announcing it.
The edge host must resolve `REMOTE_ADDR` to an ASN and set `TX:CLOUD_WAI_ASN`
before the deny rules run. Like the bot confirmation, this is a value Coraza
cannot produce itself, and like it, an unset variable is not an error: the rule
simply does not match, and an ASN block the customer configured silently blocks
nothing. Set it from the edge's own resolver, never from a header. The IP and
CIDR kinds need none of this — they match `REMOTE_ADDR` directly.

## 6. Verify the deployment

1. **Liveness, through the load balancer:**
   `curl -fsS https://app.example.com/healthz` returns
   `{"ok":true,"status":200,"data":{"service":"api"}}`.
2. **The load balancer agrees:** the target group shows the instance `healthy`.
   Its health check is this same `/healthz` path, so the two statements cannot
   disagree.
3. **The origin is not reachable directly.** The instance has no public IP:
   `aws ec2 describe-instances --instance-ids <id> --query 'Reservations[].Instances[].PublicIpAddress'`
   returns `null`. This is topology, not the gate — record it as evidence toward
   gate 6, and leave the gate open until an edge denial is observed.
4. **Sign-up and sign-in** work in the dashboard; the session is Supabase's.
5. **Tenant isolation (gate 1):** create a second account. It must see **zero**
   organizations, projects, deployments and API keys.
6. **Engines:** Security → Engine status reads "Not configured" for every engine
   you left unset. That is correct.
7. **Logs:** CloudWatch → `/cloud-wai/prod/containers` shows the containers'
   output; ALB access logs are in the logs bucket.

## 7. Operating it

- **A new release:** set `repo_ref` to a tag and re-apply, or run the bootstrap
  steps by hand over Session Manager. The bootstrap is idempotent.
- **Rotation:** change the SSM parameter, then reboot the instance.
- **Rollback:** point `repo_ref` at the previous tag and re-apply.
- **Backups, incidents, SLOs:** `docs/runbooks/backup-and-dr.md`,
  `incident-response.md`, `slos.md`.
- **Cost:** the NAT gateway and the ALB are the standing charges; the instance
  and its 30 GiB gp3 volume are the rest. `terraform destroy` removes all of it.

## What this deployment does not prove

- **No autoscaling.** One host behind the ALB. An instance failure is downtime,
  and a second host needs the two-worker question answered first (ADR-0015).
- **Gates 6–9 stay open.** A private subnet is not an edge-observed denial; a
  configured Coraza is. Do not describe this host as passing those gates.
- **`terraform validate` is not `terraform apply`.** CI proves the configuration
  is coherent. It does not prove your account accepted it; step 3 does.
