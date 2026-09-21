# USCS Information Architecture and Navigation Audit

## Current application map

USCS is a React 19 and Vite frontend with a small Express/tRPC runtime. The landing page and authenticated control plane currently live in `client/src/pages/Home.tsx`. Authentication is provided through the existing `useAuth` hook and server-side OAuth/tRPC contract. The database layer currently contains the platform user model; resource-specific cloud entities are not yet present. Vercel builds with `pnpm build`, serves `dist/public`, and rewrites application routes to `index.html`.

The existing authenticated experience already contains honest, provider-aware surfaces for Overview, Projects, Deployments, Domains, Data, Security, Observability, Developer, Team, Billing, and Settings. These surfaces intentionally show configuration-required or not-connected states rather than fabricated infrastructure data.

## Current navigation audit

The previous navigation exposed a small set of flat buttons grouped under broad labels. It did not express the relationship between a product area and its capabilities, did not preserve expansion state, and could not distinguish implemented destinations from future capability surfaces. It also used local component state instead of a reusable navigation component, so route hierarchy and permission visibility would have been difficult to extend safely.

## Implemented hierarchy

The control plane now uses a compact hierarchical sidebar:

- **Overview**
- **Build**: Projects, Deployments, Domains, and future DNS, Hosting, Functions, Jobs, and Environment Configuration surfaces
- **Data**: Databases, Storage, and future Cache, Queues, Backups, and Data Transfers
- **Security**: Security Overview, Security Center, Security Audit, and future Firewall, WAF, DDoS, Bot, Rate Limiting, Access, Authentication, MFA, and Secrets controls
- **Observe**: Logs, Performance, Alerts, and future Metrics, Errors, Requests, and Uptime
- **Developer**: GitHub, Documentation, and future API Keys, Webhooks, CLI, and API surfaces
- **Workspace**: Team, Billing, and Settings

Implemented surfaces remain connected to the existing page implementations. Future capabilities are visibly marked as planned and show a non-deceptive toast rather than opening an empty page.

## Route architecture

The current runtime retains its safe single-page section navigation so existing functionality is not broken. The intended route contract is documented below for the backend and router phase:

| Area | Target route family | Current frontend surface | Backend requirement |
|---|---|---|---|
| Overview | `/overview` | Implemented | Organization-scoped summary and activity queries |
| Build | `/projects`, `/deployments`, `/domains` | Implemented as sections | Provider adapters, project/deployment/domain models |
| Data | `/data/databases`, `/data/storage` | Implemented as honest empty/provider states | Resource, credential, backup, and policy models |
| Security | `/security` | Implemented as evidence-required state | Policy, finding, threat, and audit models |
| Observe | `/observe/logs` | Implemented as provider-required state | Append-only event ingestion and query APIs |
| Developer | `/developer/github` | Implemented as connection-required state | OAuth connection, repository, webhook, and secret contracts |
| Workspace | `/team`, `/billing`, `/settings` | Implemented as configuration states | Organization membership, billing provider, account settings |

No fake deep-link routes were introduced in this UI-only change. A later routing change should add only routes backed by a real API contract.

## Component architecture

`CloudNavigation` is the single reusable navigation component. It owns hierarchical group rendering, active-parent association, persistent expanded state, keyboard-reachable semantic buttons, mobile drawer behavior, and honest planned-surface handling. The page shell remains responsible for authentication, topbar, command palette, and existing page content.

Global CSS adds the compact child indentation, chevrons, active state, planned state, and responsive behavior. The visual language remains white, restrained, dense, and infrastructure-oriented rather than colorful or card-heavy.

## Permission and multi-tenant model

The current schema does not yet expose organizations, projects, or resource ownership. Before production resource APIs are added, the server contract should enforce `user -> organization -> project/resource` boundaries on every query and mutation. Navigation visibility should be derived from server-provided capabilities, not trusted client state. Billing, security administration, secrets, and team-management controls require explicit organization permissions.

## Backend, database, and audit requirements

The next backend phase should introduce organization membership and role tables, projects, provider connections, domains, DNS records, deployments, data resources, secrets metadata, security policies/findings, observability events, and append-only audit events. Secrets must remain server-side, resource queries must include organization predicates, and sensitive mutations should record actor, timestamp, resource, result, and correlation ID.

## Responsive and accessibility strategy

Desktop uses a persistent compact sidebar with collapsible groups. Mobile uses the existing off-canvas pattern: the sidebar becomes a drawer, the topbar exposes an explicit menu button, and navigation closes after selection. Group headers use `aria-expanded`, navigation lives in a semantic `<nav>`, buttons have labels or titles in collapsed mode, and visible focus styles are preserved.

## Implementation plan

1. Complete server-side organization and capability contracts.
2. Add real URL routes only for implemented page contracts.
3. Replace section state with route state while preserving the navigation component.
4. Add project-scoped sub-navigation after project and resource models exist.
5. Add permission-aware navigation payloads and audit-backed security surfaces.
6. Add integration tests for tenant isolation, permission filtering, mobile navigation, and direct child-route expansion.
