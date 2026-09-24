# Control-plane ERD and RLS / authorization matrix

- Status: initial
- Date: 2026-09-23

## Entity relationships

```text
profiles (1) ────< organization_members >──── (1) organizations
                                                      |
                                                      +────< projects
                                                      |          |
                                                      |          +────< environments
                                                      |          |
                                                      |          +────< deployments
                                                      |          |
                                                      |          +────< data_resources
                                                      |          |
                                                      |          +────< domains
                                                      |
                                                      +────< security_policies
                                                      +────< api_keys
                                                      +────< orchestration_jobs
                                                      +────< usage_records
                                                      +────< audit_logs
```

Every child row carries `organization_id`. `organization_members` is the only
place a user's role in an organization is stored. Provider identifiers are
stored as reference columns (`provider`, `provider_resource_id`) next to the
Cloud Wai ids — never as the scope.

## RLS matrix

RLS is enabled on every table. The predicate is always resolved from the
authenticated Supabase principal, never from a request parameter.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `profiles` | self or co-member of a shared org | self only | self only | — |
| `organizations` | member | authenticated user (becomes owner) | owner/admin | owner |
| `organization_members` | co-members of my orgs | owner/admin | owner/admin (role changes) | owner/admin |
| `projects` | org member | member+ | member+ | owner/admin |
| `environments` | org member | member+ | member+ | owner/admin |
| `deployments` | org member | member+ | service only | owner/admin |
| `data_resources` | org member | member+ | member+ (engine columns excepted) | owner/admin |
| `domains` | org member | member+ (unverified) | member+ (engine columns excepted) | owner/admin |
| `security_policies` | org member | admin+ | admin+ | owner |
| `api_keys` | owner/admin (`read:sensitive`) | service only | service only (revoke) | — |
| `orchestration_jobs` | org member | service only | service only | — |
| `usage_records` | org member (`billing:read`) | service only | service only | — |
| `audit_logs` | org member (`audit:read`) | service only (append) | — | — |

Notes:

- `audit_logs` is append-only: no UPDATE or DELETE policy exists, so those
  operations are denied for every role, including owners.
- `orchestration_jobs` and `usage_records` are written by the service role only;
  a normal user session cannot insert or mutate them.
- API keys are stored hashed. The plaintext is returned exactly once at creation
  and never selectable afterwards. Key rows are written by the service role only
  (`createApiKey` / `revokeApiKey`): issuing narrows the requested scopes to the
  caller's role, so no client INSERT/UPDATE policy exists. Letting a client write
  the row directly would let it store a scope its role never had, bypassing that
  bounding. Migration `0007_api_key_scope_guard.sql` drops those policies; proved
  by `tests/isolation/rls/13_api_key_scope_probe.sql`.
- Engine-observed columns are not client-writable, on INSERT or UPDATE. The
  `UPDATE` column above is the *row* permission; it does not mean every column
  in the row is the customer's to set. `domains.verified`, `domains.verified_at`,
  `domains.verification_token`, `data_resources.state`,
  `security_policies.state`, and the `provider` / `provider_resource_id` pairs on
  `domains`, `data_resources` and `projects` are the engine's answers. Migration
  `0006_engine_column_guards.sql` enforces that with a guard trigger: a change is
  accepted only in a session that already bypasses RLS (the service role, or a
  superuser). `deployments` expresses the same rule more simply, by having no
  client-facing UPDATE policy at all. Proved by
  `tests/isolation/rls/12_domain_verification_probe.sql`.

## Mapping capability → RLS

The TypeScript matrix in `@cloud-wai/authorization` and the SQL policies here must
agree. `tests/isolation` asserts the TypeScript side; the SQL side is asserted by
migration tests once Supabase is configured.

| Capability | SQL predicate basis |
|---|---|
| `org:read` | `is_org_member(organization_id)` |
| `project:create` | `role_in(organization_id) in ('owner','admin','member')` |
| `project:delete` | `role_in(organization_id) in ('owner','admin')` |
| `org:delete` | `role_in(organization_id) = 'owner'` |
| `billing:manage` | `role_in(organization_id) = 'owner'` |
| `security:update` | `role_in(organization_id) in ('owner','admin')` |
| `audit:read` | `is_org_member(organization_id)` |

The membership predicate is a `security definer` function over
`organization_members`, so a policy on any table costs one indexed lookup and
cannot recurse into itself.
