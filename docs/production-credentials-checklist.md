# Cloud Wai Production Credentials Checklist

This checklist describes **which credentials are needed, where they belong, and what capability each enables**. Do not paste secret values into chat, Git, screenshots, or client-side `VITE_*` variables unless explicitly marked browser-safe.

## 1. Required for the control plane

| Credential/configuration | Where to create/configure | Runtime location | Purpose |
| --- | --- | --- | --- |
| Supabase project URL | Supabase Project Settings → API | `VITE_SUPABASE_URL`, `SUPABASE_URL` | Auth and database endpoint |
| Supabase publishable key | Supabase Project Settings → API | `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PUBLISHABLE_KEY` | Browser-safe Auth/API client key |
| Supabase service-role/secret key | Supabase Project Settings → API | `SUPABASE_SERVICE_ROLE_KEY` server-only | Only for explicitly privileged server jobs; never browser-exposed |
| Public application URL | Production hosting configuration | `CONTROL_PLANE_PUBLIC_URL` | Canonical OAuth callback, links, and webhook return URLs |
| Strong server secret | Secret manager | `JWT_SECRET` if used by server middleware | Cookie/signing material; generate per environment |
| Production `NODE_ENV` and `PORT` | Hosting runtime | server environment | Runtime mode and listener |

## 2. Authentication providers

Cloud Wai currently renders **OAuth-only** sign-in: Google, GitHub, and GitLab. Email/password UI is not present and should remain disabled unless product requirements change.

Configure these in **Supabase Dashboard → Authentication → Providers**, not in the browser bundle:

### Google

- Create an OAuth client in Google Cloud Console.
- Application type: Web application.
- Add the Supabase callback URL shown in Supabase Provider settings.
- Set the client ID and client secret in Supabase.
- Add the Cloud Wai public callback URL to Supabase Auth URL Configuration:
  - `https://YOUR_DOMAIN/auth/callback`
  - local development URL only in development, for example `http://localhost:3000/auth/callback`

### GitHub

- Create a GitHub OAuth App or GitHub App according to the required scopes.
- Set its authorization callback URL to the Supabase callback URL shown by Supabase.
- Store client ID/secret in Supabase Provider settings.
- Request only the scopes needed for identity and later repository integration.

### GitLab

- Create an OAuth application in GitLab.
- Set the redirect URI to the Supabase callback URL shown in Supabase.
- Store application ID/secret in Supabase Provider settings.
- Keep repository access separate from login identity; a later Developer Integration should use a least-privilege Git provider connection.

**Important:** Supabase provider secrets are not Cloud Wai frontend environment variables. The application only needs the Supabase URL and publishable key in the browser.

## 3. Real deployment execution

Required before Cloud Wai can deploy customer applications:

| Credential/configuration | Runtime location | Purpose |
| --- | --- | --- |
| Compute control-plane URL | `COMPUTE_HOST` server-only | Address of the isolated build/deploy API |
| Compute API token | `COMPUTE_API_TOKEN` server-only | Authenticates Cloud Wai to the compute plane |
| Artifact/object-storage endpoint | New server-only adapter configuration | Stores immutable build artifacts and logs |
| Object-storage access key | Secret manager | Artifact upload/read access |
| Object-storage secret key | Secret manager | Artifact upload/read access |
| Object-storage bucket and region | Server configuration | Retention and placement |
| Worker runtime | Separate supervised process/service | Claims deployment jobs and runs adapters |

The compute service must independently enforce tenant isolation, build timeouts, resource limits, image scanning policy, network egress policy, and cleanup. Setting `COMPUTE_HOST` alone does not create a secure deployment plane.

## 4. Git repository connections

For importing and deploying source repositories, configure provider connections separately from login:

- GitHub App ID, private key, webhook secret, and installation mapping.
- GitLab OAuth/application ID, secret, webhook secret, and project access token strategy.
- Optional Bitbucket credentials only if that provider is a committed product requirement.
- Webhook signing secrets must be server-only and verified before accepting deployment events.
- Repository tokens must be encrypted/referenced, scoped to the smallest repository set, and revocable.

Do not reuse OAuth login secrets as repository deployment credentials.

## 5. Domains, DNS, and TLS

Choose a primary DNS provider before production. Then configure:

- DNS provider API token, server-only.
- Account/zone identifier.
- DNS webhook or polling credentials if supported.
- Certificate issuance account or managed TLS integration.
- Domain verification signing secret if Cloud Wai issues verification records.

Required runtime behavior: pending verification, active, misconfigured, provider unavailable, certificate issuing, certificate active, certificate renewal failure, and revoked states. A DNS record control row is not proof that a domain is live.

## 6. Security edge

Only enable this after a real enforcement service exists:

- `EDGE_API_URL` server-only.
- `EDGE_API_TOKEN` server-only.
- `EDGE_HOST` or edge node identity where applicable.
- mTLS certificates/CA if the edge API requires mutual TLS.
- Key rotation and emergency revoke process.

Rendered nginx/Coraza/CrowdSec/nftables configuration is an artifact. The UI must distinguish rendered from accepted and actively enforced.

## 7. Database and storage providers

For managed/self-operated data resources, configure an adapter per provider:

- Database control API URL and token.
- Storage/S3-compatible endpoint, region, bucket, access key, and secret key.
- Backup destination credentials and encryption key reference.
- Restore execution worker credentials.
- KMS/key-management reference if encrypted backups are offered.

Never return raw database passwords or storage secrets in ordinary tRPC list responses. Return references and one-time reveal flows only after authorization.

## 8. Observability and operations

Production operation needs:

- Error tracking DSN or API key, server-only where possible.
- Metrics backend endpoint/token.
- Log retention destination.
- Alert notification credentials: email, Slack, webhook, or PagerDuty as committed channels.
- Incident contact and on-call configuration.
- Health-check and readiness endpoints.

Observability credentials are not a substitute for building the deployment event/log model in Postgres.

## 9. Billing and quotas — postpone until ready

Do not enable payment collection yet. When the product and legal operations are ready, configure:

- Stripe secret key.
- Stripe webhook signing secret.
- Product/price IDs.
- Customer mapping strategy.
- Tax/legal/business identity and refund/support process.
- Usage meter and quota enforcement before checkout.

A billing UI without enforced usage and a tested webhook lifecycle is not production billing.

## 10. Credential handling rules

- Use a real production secret manager; do not store production secrets in GitHub Actions plaintext, screenshots, chat, or `.env` committed files.
- Separate development, staging, and production credentials.
- Rotate all tokens before public launch if they were ever exposed.
- Prefer short-lived tokens and scoped provider applications.
- Log provider name and request correlation ID, never bearer tokens or raw secrets.
- Add secret scanning and dependency/license checks to CI.
- Maintain a credential owner, creation date, rotation date, scope, and emergency revoke procedure.

## Minimum viable production setup

To run one honest end-to-end deployment demo, configure only:

1. Supabase project + Google/GitHub/GitLab providers.
2. Public Cloud Wai URL and callback allowlist.
3. Compute control API + token.
4. Worker process with access to the same database and compute API.
5. Artifact storage + scoped credentials.
6. One Git provider connection + verified webhook secret.
7. TLS and a staging domain.

Everything else should remain visibly `not_configured` until its adapter, credentials, health checks, and failure behavior are tested.
