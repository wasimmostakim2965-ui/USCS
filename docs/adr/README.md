# Architecture decision records

| ADR | Title | Status |
|---|---|---|
| [0001](0001-adapter-integration-over-engine-embedding.md) | Adopt Cloud Wai-owned adapters over engine embedding | accepted |
| [0002](0002-coolify-adapter-not-fork.md) | Coolify: version-pinned adapter, not an embedded fork | accepted |
| [0003](0003-threat-model.md) | Threat model — Cloud Wai control plane | living |
| [0004](0004-control-plane-erd-rls.md) | Control-plane ERD and RLS / authorization matrix | initial |
| [0005](0005-api-contracts-and-state-machines.md) | API contract map and operation state machines | initial |
| [0006](0006-phased-plan-and-acceptance-tests.md) | Phased implementation plan and acceptance tests | accepted |
| [0007](0007-engine-source-maps.md) | Engine source-tree maps | initial |
| [0008](0008-adapter-conformance-and-job-semantics.md) | Adapter conformance, honest states and durable job semantics | accepted |
| [0009](0009-real-engine-adapters.md) | Real engine adapters: per-tenant credentials and one wiring point | accepted |
| [0010](0010-dashboard-honesty.md) | Dashboard: URL-driven routes and an honesty-in-the-type view model | accepted |

Source of truth for this project:

- [`DEV_AGENT_BLUEPRINT.md`](../../DEV_AGENT_BLUEPRINT.md) — architecture, rules, repo layout
- [`DEV_AGENT_REPOSITORY_MAP.md`](../../DEV_AGENT_REPOSITORY_MAP.md) — canonical engine inventory
- [`LICENSES/third-party-inventory.md`](../../LICENSES/third-party-inventory.md) — pinned versions and licenses

Engine source is inspected under the git-ignored `engines-src/`; it is never
committed here.
