# The router: public hostnames and automatic TLS

This runbook covers `infra/deployment/router-server.mjs` — the deployment's own
front door (ADR-0021). It turns a verified hostname into a reachable HTTPS site
on a single host, with no third-party proxy.

Read it alongside [`deploy.md`](deploy.md) §5, which is where the router is
started during a normal deploy, and [`build-plane.md`](build-plane.md), which
covers the build plane whose artifact the runtime runs.

## What it does, and what it does not

It does exactly three things:

1. **Routes.** It reads the `Host` header and forwards the request to a loopback
   upstream — the dashboard, or one deployed app's port. Routes arrive through a
   token-authenticated admin API bound to `127.0.0.1`, never from the public port.
2. **Terminates TLS.** For a host whose route says `tls: "auto"` it obtains a
   certificate over ACME HTTP-01 and renews it before expiry.
3. **Serves the ACME challenge** on `:80` at
   `/.well-known/acme-challenge/<token>`, redirecting everything else to HTTPS.

It does **not** hold tenant secrets, read the control-plane database, or mount
the Docker socket. Its entire state is `routes.json` and `certs/` on its volume.

## Running it

```bash
docker compose -f infra/deployment/docker-compose.yml --profile edge up -d --build router
```

It shares the host network (`network_mode: host`), for the same reason the
runtime does: the app ports the runtime publishes on `127.0.0.1` must be
addresses the router can reach, and the router's admin API must stay off every
public interface. It binds `:80`, `:443` and `127.0.0.1:8096`.

On a single host, `./infra/deployment/deploy.sh` generates `ROUTER_TOKEN` and
starts it, so the profile is only named by hand when the service is managed
independently.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ROUTER_TOKEN` | — | Shared secret for the admin API. `deploy.sh` generates it. Set it and the runtime will publish routes; unset, the admin API refuses every write. |
| `ROUTER_ACME_EMAIL` | — | The contact address Let's Encrypt records. Set it for automatic issuance; without it the router serves a self-signed certificate and records why. |
| `ROUTER_ADMIN_HOST` | `127.0.0.1` | The interface the admin API binds. Leaving it loopback is what keeps route publishing off the public port. |
| `ROUTER_HTTP_PORT` / `ROUTER_HTTPS_PORT` | `80` / `443` | The public listener ports. |
| `ROUTER_DEFAULT_UPSTREAM` | — | Fallback host upstream (the dashboard) for a name with no app route. |
| `ROUTER_ACME_DIRECTORY` | Let's Encrypt production | Point at the staging directory while testing. |

`ROUTER_URL` (what the runtime publishes to) and `ROUTER_TOKEN` are written to
`.env` by the deploy script; the API and runtime read them from there.

## How a domain becomes reachable

1. In the dashboard, add a domain. The control plane issues a DNS challenge.
2. Point the domain's A/AAAA record at this host. HTTP-01 needs the name
   reachable on `:80`, so the record must resolve to the router's public address.
3. Verify the domain. Two facts are reported separately:
   - the DNS record was confirmed (`domain.verified`), and
   - the route was published — the firewall route (`edge`) and the hosting route
     (`hostingRoute`), each with its own `published`/`reason`.
4. The router issues a certificate on first request and serves the app. From then
   on the name resolves to the deployed container over HTTPS.

A confirmed record whose route did not publish is shown as exactly that, with the
engine's own reason, not as a failed verification and not as a success.

## Certificates

- Issued on first request for a `tls: "auto"` host; renewed before expiry.
- Persisted to the `router-data` volume, so a restart does not re-request and risk
  a rate limit. Delete the volume to force re-issuance.
- On failure the host keeps a self-signed certificate and the route records the
  reason. TLS is never silently absent.

## When not to use it

- **A load balancer terminates TLS upstream.** HTTP-01 is then impossible, so
  leave the router off and let the balancer hold certificates (ADR-0015). The
  runtime still deploys; its domains are reported as not yet routable.
- **A host already runs Coolify.** Coolify's proxy routes and terminates TLS;
  the router is not needed and `ROUTER_URL` stays unset.

## Health and troubleshooting

- `curl -fsS http://127.0.0.1:8096/healthz` — liveness, reveals no configuration.
- `docker compose logs router` — issuance and routing decisions.
- **A domain verifies but the site does not load.** Read `hostingRoute.reason` on
  the verify response; it names the engine's refusal. Common causes: `ROUTER_URL`
  or `ROUTER_TOKEN` not set, or the runtime cannot reach the router's admin API.
- **Issuance fails.** Check the A record resolves to this host and `:80` is
  reachable from the internet; check `ROUTER_ACME_EMAIL` is set; watch for
  Let's Encrypt rate limits (use the staging directory while testing).
- **The router did not become healthy.** `docker compose logs router`; the usual
  cause is `:80`/`:443` already in use by another proxy on the host.
