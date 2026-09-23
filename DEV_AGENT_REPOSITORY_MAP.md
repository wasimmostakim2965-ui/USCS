# Cloud Wai — Dev Agent Repository and Tool Integration Brief

## Mission

Use this document together with `DEV_AGENT_BLUEPRINT.md`. Before implementation, inspect the source tree, build system, runtime model, public APIs, database schema, permission boundaries, security model, test suite, dependency licenses, and operational assumptions of every repository listed below. Do not infer architecture from README text alone.

The objective is not to paste unrelated repositories into one folder. The objective is to understand the original systems deeply, preserve their legal and upgrade boundaries, and combine them through Cloud Wai-owned contracts, adapters, policy, orchestration, and user experience.

## Canonical component inventory

| Component | Role in Cloud Wai | Canonical repository or source | Integration rule |
|---|---|---|---|
| Cloud Wai control plane | Product-owned dashboard, API, identity mapping, organizations, billing, audit, policies | Current USCS repository | This is the source of truth for customer identity and commercial state. |
| Supabase | Control-plane authentication, PostgreSQL, migrations, RLS, storage primitives where appropriate | [supabase/supabase](https://github.com/supabase/supabase) | Use as the permanent control-plane foundation. Do not confuse it with customer tenant databases. Inspect Auth, Postgres, Realtime, Storage, migrations, local development, and self-hosting boundaries. |
| Coolify | Deployment and hosting execution engine | [coollabsio/coolify](https://github.com/coollabsio/coolify) | Connect through a versioned `HostingAdapter`. Inspect teams, projects, environments, API, jobs, Docker/SSH operations, server destinations, secrets, logs, backups, webhooks, and cross-team tests. Do not make Coolify the Cloud Wai identity source. |
| PostgreSQL | Relational database engine for control plane and self-operated data plane | [postgres/postgres](https://github.com/postgres/postgres) | Operate through managed or self-operated instances. Define separate credentials, networks, backups, encryption and tenant lifecycle for control-plane and customer databases. |
| Valkey | Low-latency cache, rate-limit state, queue support and ephemeral coordination | [valkey-io/valkey](https://github.com/valkey-io/valkey) | Use only for data that can be rebuilt or for explicitly designed coordination. Never make it the sole source of billing, identity or audit truth. |
| MinIO or another S3-compatible store | Object storage for backups, build artifacts and customer storage | [minio/minio](https://github.com/minio/minio) | Review current license and deployment model before adoption. Hide provider details behind `StorageAdapter`; isolate buckets, credentials and tenant prefixes. |
| Envoy Proxy | Edge routing, TLS, load balancing, filters and service-to-service policy hooks | [envoyproxy/envoy](https://github.com/envoyproxy/envoy) | Use as a data-plane edge candidate. Inspect external authorization, rate limiting, TLS/mTLS, retries, circuit breakers, access logs and xDS/config distribution. Do not query the control-plane database per request. |
| HAProxy | Alternative high-performance edge/load-balancing engine | [haproxy/haproxy](https://github.com/haproxy/haproxy) | Keep as an optional provider behind `SecurityEdgeAdapter`; select one primary edge implementation after benchmarks. |
| OWASP Coraza | Web Application Firewall engine | [corazawaf/coraza](https://github.com/corazawaf/coraza) | Integrate as Envoy/sidecar/proxy WAF. Inspect connectors, rule execution, body limits, logging, anomaly scoring, failure modes and performance. |
| OWASP Core Rule Set | Generic WAF detection rules for common web attacks | [coreruleset/coreruleset](https://github.com/coreruleset/coreruleset) | Pin a reviewed version. Maintain false-positive exclusions, regression fixtures and rule update procedures. Never claim it detects every business-logic vulnerability. |
| CrowdSec | Behavioral detection, remediation and threat-intelligence integration | [crowdsecurity/crowdsec](https://github.com/crowdsecurity/crowdsec) | Use as an additional signal and remediation layer, not as a substitute for WAF, origin protection or runtime isolation. Review its data flow and privacy implications. |
| nftables | Host firewall and network policy enforcement | [netfilter/nftables](https://git.netfilter.org/nftables/) | Generate narrow, atomic rules from a privileged security service. Never allow customer input to become shell commands or unrestricted firewall rules. |
| containerd | Container lifecycle runtime | [containerd/containerd](https://github.com/containerd/containerd) | Use only if the deployment runtime requires direct container orchestration beyond the provider. Inspect namespaces, images, snapshots, runtime events and privilege boundaries. |
| runc | OCI container runtime | [opencontainers/runc](https://github.com/opencontainers/runc) | Track security advisories and runtime version. Enforce non-root, seccomp, capabilities, read-only filesystem and resource limits. |
| CNI | Container networking plugins and conventions | [containernetworking/cni](https://github.com/containernetworking/cni) | Use for isolated networks and explicit egress policy. Test tenant-to-tenant, tenant-to-host and metadata-service access. |
| Open Policy Agent | Policy evaluation for authorization and infrastructure decisions | [open-policy-agent/opa](https://github.com/open-policy-agent/opa) | Use for compiled policy decisions where appropriate. Keep Cloud Wai policy entities and audit state in the control plane. Define fail-open/fail-closed behavior per policy. |
| Trivy | Vulnerability and secret scanning for images, filesystems and repositories | [aquasecurity/trivy](https://github.com/aquasecurity/trivy) | Run asynchronously in build/security pipelines. Define severity thresholds and a documented exception workflow. |
| Syft | SBOM generation | [anchore/syft](https://github.com/anchore/syft) | Produce an SBOM for every release image and retain it with build provenance. |
| Cosign | Container/image signing and verification | [sigstore/cosign](https://github.com/sigstore/cosign) | Require signature verification for trusted deployment paths. Protect signing keys and document key rotation. |
| OpenTelemetry Collector | Metrics, logs and traces pipeline | [open-telemetry/opentelemetry-collector](https://github.com/open-telemetry/opentelemetry-collector) | Keep telemetry asynchronous and redact secrets, tokens, cookies, credentials and tenant-sensitive payloads. |
| Prometheus | Metrics collection and alerting foundation | [prometheus/prometheus](https://github.com/prometheus/prometheus) | Track latency, throughput, queue depth, WAF decisions, provider health, resource saturation and security incidents. |
| Grafana | Operator-facing dashboards and visualization | [grafana/grafana](https://github.com/grafana/grafana) | Use for internal observability or a carefully isolated customer metrics surface. Review its license and plugin security before redistribution. |

## Repository inspection protocol

For each repository, the Dev agent must complete the following audit before selecting code or calling an API:

1. Record the exact upstream URL, commit/tag, license, copyright notices, trademarks and third-party dependency licenses.
2. Draw its source-tree map. Identify entry points, server processes, workers, migrations, configuration, UI, API routes, data models, security middleware and tests.
3. Run the project’s documented checks where feasible: install, build, typecheck/compile, lint, unit tests, integration tests and security checks.
4. Identify the trust boundary. State which process can access databases, Docker, SSH, host files, secrets, network devices and customer data.
5. Identify whether it is a library, a daemon, a complete application, an operator, a CLI, a policy engine or a data-plane component. Do not treat all repositories as packages.
6. Check how authentication, authorization, tenant scope, secrets, rate limits, retries, timeouts, logging and failure recovery work.
7. Document the public API or configuration contract. Add a Cloud Wai adapter only after the contract is understood.
8. Record upstream upgrade strategy, security advisory process, breaking-change risk and patch ownership.
9. Add an SPDX entry in `LICENSES/` and a `docs/adr/` decision for every adopted component.
10. Add contract tests and isolation tests around every integration. A successful HTTP response alone is not an integration test.

## How the systems connect

```text
Cloud Wai Web
  -> Cloud Wai API/BFF
      -> Supabase Auth/session resolution
      -> Cloud Wai authorization + RLS
      -> Cloud Wai orchestration job
          -> HostingAdapter -> Coolify API/runtime
          -> DatabaseAdapter -> PostgreSQL/tenant data service
          -> StorageAdapter -> MinIO/S3-compatible storage
          -> SecurityEdgeAdapter -> Envoy/HAProxy + Coraza/CRS
          -> SecurityControl -> CrowdSec/OPA/nftables policies
      -> OpenTelemetry -> Collector -> metrics/logs/traces
```

The browser talks only to Cloud Wai APIs. It must not call Coolify, Docker, PostgreSQL, MinIO, Envoy admin APIs, CrowdSec or host firewalls directly. The control plane creates a command, authorizes it, records an idempotency key, queues it, and lets a worker execute it through an adapter.

## Data and identity boundaries

Supabase is the control-plane identity and operational database. PostgreSQL instances provisioned for customers are tenant data-plane resources. Coolify may store its own operational metadata, but it must not become the canonical user, organization, billing or audit database for Cloud Wai.

Every external reference must be stored as a provider reference alongside the Cloud Wai organization, project and resource IDs. Never use a provider ID alone as a tenant boundary. Provider credentials must be encrypted, scoped, rotated and excluded from logs.

## Security-specific integration rules

The edge must protect origin services by default. Customer origins should not expose public inbound management or application ports. Edge-to-origin communication should use private connectivity, mTLS or an equivalent authenticated tunnel. Envoy/HAProxy performs routing and connection controls. Coraza and CRS perform selective WAF inspection. CrowdSec contributes behavioral signals. nftables and container policy enforce host and runtime boundaries. OPA may evaluate compiled decisions. OpenTelemetry records security events without retaining secrets.

Use a fast path for safe cached/static traffic and a deeper path for login, upload, admin, mutation and suspicious traffic. Do not make every request wait for a control-plane database query. Compile and cache policy at the edge, distribute updates with versions, and define fail-open or fail-closed behavior explicitly for every rule class.

## License policy

Do not assume that “open source” means that every repository has the same terms. Coolify is Apache-2.0 at its root. Supabase contains multiple components and dependencies. PostgreSQL, Valkey, Envoy, Coraza, CrowdSec, OPA, Prometheus and OpenTelemetry each have their own licensing and attribution requirements. MinIO and Grafana require special license review before redistribution or commercial embedding.

The agent must produce a license matrix before code is copied or forked. If a component is used as an independently deployed service, retain its notices and document the deployment boundary. If source code is modified or redistributed, comply with that component’s source, notice, trademark and attribution obligations. Do not copy a repository’s brand, proprietary assets, closed source modules or restricted features into Cloud Wai.

## Required first report

Before writing implementation code, return a report with:

- A source-tree diagram for every repository selected.
- A component decision: adopt, wrap, fork, or reject.
- Exact version/commit and license for every dependency.
- Trust-boundary and data-flow diagram.
- Organization/project/resource authorization matrix.
- API and event contract map.
- Runtime and deployment topology.
- Security path with latency budget.
- Upgrade and patch strategy.
- Test plan for isolation, failure, performance, WAF behavior and recovery.
- List of unknowns that require investigation rather than assumption.

Do not begin with a cosmetic dashboard. First establish the control-plane contract, provider adapters, policy boundaries, source-tree understanding, license matrix and acceptance tests. The final product must feel unified in the UI while remaining modular and replaceable internally.

## References

[1]: https://github.com/supabase/supabase "Supabase source repository"
[2]: https://github.com/coollabsio/coolify "Coolify source repository"
[3]: https://github.com/postgres/postgres "PostgreSQL source repository"
[4]: https://github.com/valkey-io/valkey "Valkey source repository"
[5]: https://github.com/minio/minio "MinIO source repository"
[6]: https://github.com/envoyproxy/envoy "Envoy Proxy source repository"
[7]: https://github.com/haproxy/haproxy "HAProxy source repository"
[8]: https://github.com/corazawaf/coraza "OWASP Coraza source repository"
[9]: https://github.com/coreruleset/coreruleset "OWASP Core Rule Set source repository"
[10]: https://github.com/crowdsecurity/crowdsec "CrowdSec source repository"
[11]: https://git.netfilter.org/nftables/ "nftables source repository"
[12]: https://github.com/containerd/containerd "containerd source repository"
[13]: https://github.com/opencontainers/runc "runc source repository"
[14]: https://github.com/containernetworking/cni "Container Network Interface source repository"
[15]: https://github.com/open-policy-agent/opa "Open Policy Agent source repository"
[16]: https://github.com/aquasecurity/trivy "Trivy source repository"
[17]: https://github.com/anchore/syft "Syft source repository"
[18]: https://github.com/sigstore/cosign "Cosign source repository"
[19]: https://github.com/open-telemetry/opentelemetry-collector "OpenTelemetry Collector source repository"
[20]: https://github.com/prometheus/prometheus "Prometheus source repository"
[21]: https://github.com/grafana/grafana "Grafana source repository"

This is an engineering integration brief. It is not a claim that any single component provides absolute security or that source inspection alone proves production readiness.
