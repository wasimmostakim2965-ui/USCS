# API contract map and operation state machines

- Status: initial
- Date: 2026-09-23

## Contract map

The browser calls only the Cloud Wai API. Each route below is a typed procedure
that resolves a principal, resolves organization membership server-side, checks a
capability, and then reads the control plane or enqueues a command.

| Route (UI) | Procedure | Capability | Backing store / engine |
|---|---|---|---|
| `/dashboard` | `overview.get` | `org:read` | control plane aggregate |
| `/dashboard/projects` | `projects.list` | `project:read` | `projects` |
| `/dashboard/projects/:id` | `projects.get` | `project:read` | `projects` + provider ref |
| `/dashboard/projects/:id/deployments` | `deployments.list` | `deployment:read` | `deployments` |
| `…/deployments/:deploymentId` | `deployments.get` | `deployment:read` | `deployments` + HostingAdapter |
| `…/deployments/:id/logs` | `deployments.logs` | `deployment:read` | HostingAdapter `getLogs` |
| `…/deployments/:id/rollback` | `deployments.rollback` | `deployment:rollback` | enqueue → HostingAdapter |
| `…/domains` | `domains.list` | `domain:read` | `domains` |
| `…/data` | `dataResources.list` | `data:read` | `data_resources` |
| `…/data/:id/backup` | `dataResources.backup` | `data:backup` | enqueue → Database/StorageAdapter |
| `…/security` | `security.policies` | `security:read` | `security_policies` |
| `…/security/:id` | `security.update` | `security:update` | enqueue → SecurityEdgeAdapter |
| `/dashboard/settings/organization` | `orgs.get` / `orgs.update` | `org:read` / `org:update` | `organizations` |
| `/dashboard/settings/api-keys` | `apiKeys.list/create/revoke` | `apikey:*` | `api_keys` (hashed) |
| `/dashboard/settings/audit-logs` | `audit.list` | `audit:read` | `audit_logs` |
| `/dashboard/settings/members` | `members.list/invite/remove` | `member:*` | `organization_members` |

## Deployment state machine

```text
queued ──▶ running ──▶ succeeded
   │           │
   │           ├──▶ failed        (engine reported failure)
   │           ├──▶ degraded      (partial: e.g. build ok, health check failed)
   │           └──▶ not_configured(no engine bound to this project)
   │
   └──▶ cancelled
```

Rules:

- Only `succeeded` is success. `not_configured`, `failed` and `degraded` are
  never rendered or stored as success.
- Replaying the same idempotency key returns the existing operation, it does not
  start a second deployment.
- `cancelDeployment` on a terminal operation is a no-op, not an error.
- `rollback` creates a new deployment that references a previous successful one.

## Data resource state machine

```text
provisioning ──▶ ready ──▶ (backup) ──▶ restoring ──▶ ready
      │                              │
      └──▶ not_configured            └──▶ failed
```

`provision`/`restore` are only `ready` after a real connectivity check against the
tenant resource succeeds. A backup is recorded only after the adapter returns a
real backup reference with a size and timestamp.

## Policy publication state machine

```text
draft ──▶ compiled(version n) ──▶ distributed ──▶ active
                    │                    │
                    └──▶ rejected        └──▶ degraded (edge stale)
```

The edge rejects a version lower than the one it already has, so policy cannot
silently roll backwards.

## Events (audit + telemetry)

Event names are `resource.action` with the Cloud Wai organization id attached by
the server, never by the client:

`org.created`, `member.invited`, `member.removed`, `project.created`,
`deployment.requested`, `deployment.started`, `deployment.succeeded`,
`deployment.failed`, `deployment.cancelled`, `deployment.rollback_requested`,
`data.provision_requested`, `data.ready`, `data.backup_completed`,
`data.restore_requested`, `domain.added`, `domain.verified`,
`policy.compiled`, `policy.distributed`, `policy.rejected`,
`apikey.created`, `apikey.revoked`, `job.enqueued`, `job.completed`, `job.failed`.
