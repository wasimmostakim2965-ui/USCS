# ADR-0021 — The router: a public hostname and automatic TLS, owned by the deployment

- Status: accepted
- Date: 2026-09-28
- Deciders: Cloud Wai engineering
- Related: ADR-0011, ADR-0015, ADR-0020

## Context

ADR-0020 gave a single host its own container runtime: a commit becomes a running
container, bound to a private loopback port. The runtime is what Coolify supplied
on the execution side, but it deliberately has no public front door — an app's
port is `127.0.0.1:<n>`, reachable only from the host itself.

That left the last mile missing. A domain could be *verified* (the DNS challenge
in `domains.verify`) and recorded, and an app could be *deployed*, but nothing
connected the two: no process turned `app.example.com` into that loopback port,
and nothing terminated TLS for it. On a host without Coolify, a verified domain
was a fact in the database that no browser could reach. Vercel's edge does both
jobs; a self-hostable platform that claims Vercel parity must own them too.

Two constraints shaped the decision:

- The control plane already had a `SecurityEdgeAdapter` port (`publishRoute` /
  `removeRoute`), but for the *firewall* layer — WAF policy, quarantine — which is
  a different concern from "route this hostname to this container and serve it
  over TLS". Merging them would make one adapter answer two unrelated questions.
- A certificate must never be invented. An ACME issuance that fails has to leave
  the host with a self-signed certificate and a recorded reason, never a silent
  plaintext or a fabricated success.

## Decision

Add a **router** — `infra/deployment/router-server.mjs` — as this deployment's
own front door, a separate least-privileged service with three jobs and only
these:

1. **Routing.** It reads the `Host` header and forwards to a loopback upstream:
   the dashboard, or one deployed app's port. A route is published by the control
   plane through a token-authenticated admin API bound to loopback, never by a
   client of the public port.
2. **TLS with automatic certificates.** For a host whose route says `tls: "auto"`,
   it obtains a certificate over ACME HTTP-01 and renews it before expiry. On
   failure the host keeps a self-signed fallback certificate and the route records
   why — reported, never hidden.
3. **The ACME challenge listener on :80.** `/.well-known/acme-challenge/<token>` is
   answered from the in-memory challenge store; every other request is redirected
   to HTTPS.

The pieces are wired as follows:

- `HostingAdapter.setDomains` is added (optional on the port). The runtime
  implements it by publishing each hostname to the router's admin API; Coolify
  omits it, because its own proxy owns hostnames.
- `domains.verify` publishes both facts after the row is written: the firewall
  route through `securityEdge.publishRoute`, and the *hosting* route through
  `hosting.setDomains` when the project has an application. The result carries
  `edge` and `hostingRoute` separately, each with its own `published`/`reason`, so
  a UI can say exactly which layer is not yet serving the hostname.
- The router runs under the `edge` compose profile, persists certificates and the
  ACME account key to a `router-data` volume, and exposes only :80/:443 publicly;
  its admin API is inside the compose network.

## Consequences

- A single Linux host can serve a verified custom domain over real HTTPS with no
  third-party proxy: the domain is reachable the moment its route is published.
- Verification and reachability are separate, reportable facts. A confirmed DNS
  record with an unreachable route is shown as exactly that, not as a failed
  verification in one direction or a false success in the other.
- The router holds no tenant secrets, reads no control-plane database, and mounts
  no Docker socket — its whole state is `routes.json`. It is the one edge service
  that can be reasoned about in isolation.
- HTTP-01 requires the host to be reachable on :80 for each hostname. A deployment
  behind a load balancer that terminates TLS upstream turns the router's ACME off
  and lets the balancer hold certificates (ADR-0015); the router then serves
  routing only.
- Coolify remains unchanged: on a host that runs it, Coolify's proxy routes and
  terminates TLS as before, and the router is not needed.
