-- ---------------------------------------------------------------------------
-- 0016 — trusted source addresses (matrix X13 / audit B7)
--
-- The deny list in `0010` answers "what must the edge block". This migration is
-- the other half of the same question, and the one the master plan names
-- explicitly: an operator's own webhook senders and CI runners must not be
-- challenged or blocked when attack mode is up.
--
-- Why a separate table rather than a new `kind` on `security_rules`: the two
-- carry opposite intent. A `security_rules` row is a *deny*, and its RLS grants
-- and compiler path say so. A trusted source is an *allow*; folding it into the
-- deny table would make "list the deny list" ambiguous and put an allow in the
-- path of the deny compiler. One table, one concept.
--
-- It deliberately stores address literals only (`ip` / `cidr`), never a
-- hostname. A name would have to be resolved, and the DNS answer is
-- attacker-influenced, so trusting a name would make the allow-list forgeable.
-- An address cannot be spoofed the same way for a TCP connection the edge
-- terminates. The grammar is enforced at the API boundary, again in the
-- compiler, and as a backstop here.
--
-- The compiled ladder emits these *before* the deny list (see
-- `packages/adapters/src/security-edge.ts`), so a trusted address is allowed
-- even while attack mode is challenging browser traffic.
-- ---------------------------------------------------------------------------

create table if not exists security_trusted_sources (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  kind            text not null check (kind in ('ip', 'cidr')),
  -- A plain address or CIDR. The grammar is enforced at the API and the
  -- compiler; this check is the backstop that keeps a multi-line value out of
  -- the table even if a procedure is bypassed.
  value           text not null
                    check (length(value) between 1 and 18)
                    check (value ~ '^[0-9.]+(/[0-9]{1,2})?$'),
  note            text check (note is null or length(note) <= 200),
  created_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),
  unique (organization_id, kind, value)
);

create index if not exists security_trusted_sources_org_idx
  on security_trusted_sources (organization_id, created_at desc);

alter table security_trusted_sources enable row level security;

create policy security_trusted_sources_select on security_trusted_sources for select to authenticated
using (public.is_org_member(organization_id));

-- Only an admin may add a trusted source, and it is always attributed. This is
-- the same threshold the deny list sets: a trusted source is a security-policy
-- change, and a trusted address that an attacker could add is a bypass.
create policy security_trusted_sources_insert on security_trusted_sources for insert to authenticated
with check (public.role_at_least(organization_id, 'admin') and created_by = auth.uid());

create policy security_trusted_sources_delete on security_trusted_sources for delete to authenticated
using (public.role_at_least(organization_id, 'admin'));

-- No UPDATE policy: a source is add-or-remove, never silently edited, so an
-- audit reader can trust that the address that was allowed is the address that
-- was recorded.
