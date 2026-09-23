import { useState } from "react";
import { MailPlus, Shield, UserMinus, Users } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardBody, CardHead, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Select, StatusBadge, Tabs } from "@/components/ui-kit";
import { toneForStatus, useOrganizationId } from "./shared";

type TeamTab = "members" | "roles";
const tabs: TeamTab[] = ["members", "roles"];
const roleOptions = ["owner", "admin", "member", "viewer", "billing", "security"] as const;
const roleDescriptions: Record<string, string> = {
  owner: "Full control including billing, members and deletion.",
  admin: "Manage projects, deployments, domains and integrations.",
  member: "Day-to-day work with read and write on projects.",
  viewer: "Read-only access across the workspace.",
  billing: "Manage billing, invoices and payment methods.",
  security: "Manage security policy, firewall and edge controls.",
};

export default function Team({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as TeamTab) ? routeParts![1] as TeamTab : "members";
  const { organizationId, organization } = useOrganizationId();
  const members = trpc.workspace.members.list.useQuery({ organizationId: organizationId ?? "00000000-0000-0000-0000-000000000000" }, { enabled: Boolean(organizationId), retry: false });

  return <>
    <PageHeader
      title="Team"
      crumb="Workspace / Team"
      description={organization?.name ? `Members and roles for ${organization.name}. Access is enforced by organization-scoped RLS.` : "Members and roles for this workspace."}
    />
    <Tabs items={tabs.map(value => ({ label: value[0].toUpperCase() + value.slice(1), value }))} active={tab} onChange={value => onNavigate?.(`/dashboard/team/${value}`)} />

    {tab === "members" ? <MembersPanel organizationId={organizationId} query={members} /> : null}
    {tab === "roles" ? <Card>
      <CardHead eyebrow="Access model" title="Roles and permissions" description="Every mutation resolves the membership role server-side before writing." />
      <div className="ds-list">{roleOptions.map(role => (
        <div className="ds-row" key={role}><span className="ds-row-icon"><Shield size={15} /></span><span className="ds-row-main"><strong>{role[0].toUpperCase() + role.slice(1)}</strong><small>{roleDescriptions[role]}</small></span></div>
      ))}</div>
    </Card> : null}
  </>;
}

function MembersPanel({ organizationId, query }: { organizationId?: string; query: { data?: Array<Record<string, unknown>>; isLoading: boolean; error?: { message: string } | null; refetch: () => unknown } }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "viewer" | "billing" | "security">("member");
  const invite = trpc.workspace.members.invite.useMutation({ onSuccess: () => { void query.refetch(); setEmail(""); toast.success("Invitation intent saved"); }, onError: error => toast.error(error.message) });
  const updateRole = trpc.workspace.members.updateRole.useMutation({ onSuccess: () => { void query.refetch(); toast.success("Role updated"); }, onError: error => toast.error(error.message) });
  const remove = trpc.workspace.members.remove.useMutation({ onSuccess: () => { void query.refetch(); toast.success("Member removed"); }, onError: error => toast.error(error.message) });

  return <>
    <Card style={{ marginBottom: 16 }}>
      <CardHead eyebrow="Invite" title="Invite a member" description="Invitations are persisted with an expiry and audit record. Email delivery requires a mail provider." />
      <CardBody>
        <div className="ds-form-grid">
          <Field label="Email"><Input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="teammate@example.com" /></Field>
          <Field label="Role"><Select value={role} onChange={event => setRole(event.target.value as typeof role)}><option value="member">Member</option><option value="admin">Admin</option><option value="viewer">Viewer</option><option value="billing">Billing</option><option value="security">Security</option></Select></Field>
        </div>
        <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!organizationId || !email || invite.isPending} onClick={() => organizationId && invite.mutate({ organizationId, email, role })}><MailPlus size={14} /> Save invitation</Button></div>
      </CardBody>
    </Card>
    <Card>
      <CardHead eyebrow="Members" title="Workspace members" action={<Users size={15} color="var(--ds-fg-subtle)" />} />
      {query.isLoading ? <LoadingBlock rows={3} /> : query.error ? <ErrorState message={query.error.message} /> : query.data?.length ? (
        <div className="ds-list">{query.data.map(member => {
          const profiles = member.profiles as { display_name?: string; email?: string } | Array<{ display_name?: string; email?: string }> | undefined;
          const profile = Array.isArray(profiles) ? profiles[0] : profiles;
          const memberRole = String(member.role);
          return <div className="ds-row" key={String(member.user_id)}>
            <span className="ds-row-icon"><Shield size={15} /></span>
            <span className="ds-row-main"><strong>{profile?.display_name || profile?.email || String(member.user_id)}</strong><small>{profile?.email ?? "Profile email unavailable"}</small></span>
            <Select value={memberRole} disabled={!organizationId || updateRole.isPending} onChange={event => organizationId && updateRole.mutate({ organizationId, userId: String(member.user_id), role: event.target.value as typeof roleOptions[number] })} style={{ width: 130 }}>
              {roleOptions.map(option => <option key={option} value={option}>{option[0].toUpperCase() + option.slice(1)}</option>)}
            </Select>
            <StatusBadge tone={toneForStatus(memberRole)}>{memberRole}</StatusBadge>
            <Button variant="danger" size="sm" disabled={memberRole === "owner" || remove.isPending} onClick={() => organizationId && remove.mutate({ organizationId, userId: String(member.user_id) })}><UserMinus size={13} /> Remove</Button>
          </div>;
        })}</div>
      ) : <EmptyState title="No members yet" body="Membership appears after Supabase auth provisioning completes for this workspace." />}
    </Card>
  </>;
}
