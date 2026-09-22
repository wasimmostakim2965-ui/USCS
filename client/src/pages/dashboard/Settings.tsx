import { useState } from "react";
import { Bell, ClipboardList, MailPlus, Settings2, Shield, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ComingSoon, Empty, Header, Status } from "./shared";

type SettingsTab = "workspace" | "team" | "notifications" | "connected-accounts" | "audit";
const tabs: SettingsTab[] = ["workspace", "team", "notifications", "connected-accounts", "audit"];

export default function Settings({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as SettingsTab) ? routeParts?.[1] as SettingsTab : "workspace";
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const organization = organizations.data?.[0];
  const go = (next: SettingsTab) => onNavigate?.(`/dashboard/settings/${next}`);
  return <><Header title="Settings" /><div className="vc-subtabs">{tabs.map(value => <button key={value} className={tab === value ? "active" : ""} onClick={() => go(value)}>{value.replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase())}</button>)}</div>{!organization ? <Empty title="Workspace required" body="Sign in to a workspace to manage settings." /> : tab === "workspace" ? <WorkspacePanel organization={organization} /> : tab === "team" ? <TeamPanel organizationId={organization.id} /> : tab === "notifications" ? <NotificationPanel organizationId={organization.id} /> : tab === "connected-accounts" ? <ComingSoon title="Connected accounts" body="OAuth connection management will appear after a provider connection contract is configured." /> : <AuditPanel />}</>;
}

function WorkspacePanel({ organization }: { organization: { id: string; name: string; slug: string; role?: string } }) {
  return <div className="vc-card"><span className="vc-eyebrow">Workspace identity</span><h3>{organization.name}</h3><div className="vc-list-row"><Settings2 size={16} /><span><strong>Slug</strong><small>{organization.slug}</small></span><Status>{organization.role ?? "member"}</Status></div><div className="vc-list-row"><Shield size={16} /><span><strong>Access model</strong><small>Organization-scoped Supabase RLS with role-aware mutations.</small></span><Status>Protected</Status></div></div>;
}

function TeamPanel({ organizationId }: { organizationId: string }) {
  const members = trpc.workspace.members.list.useQuery({ organizationId }, { retry: false });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "viewer" | "billing" | "security">("member");
  const invite = trpc.workspace.members.invite.useMutation({ onSuccess: () => { setEmail(""); toast.success("Invitation intent saved"); void members.refetch(); }, onError: error => toast.error(error.message) });
  const updateRole = trpc.workspace.members.updateRole.useMutation({ onSuccess: () => { toast.success("Role updated"); void members.refetch(); }, onError: error => toast.error(error.message) });
  const remove = trpc.workspace.members.remove.useMutation({ onSuccess: () => { toast.success("Member removed"); void members.refetch(); }, onError: error => toast.error(error.message) });
  return <><div className="vc-card vc-settings-editor"><span className="vc-eyebrow">Team access</span><h3>Invite a member</h3><p>Invitations are persisted with an expiry and audit record. Email delivery is not claimed until a mail provider is configured.</p><div className="vc-form-grid"><label>Email<input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="teammate@example.com" /></label><label>Role<select value={role} onChange={event => setRole(event.target.value as typeof role)}><option value="member">Member</option><option value="admin">Admin</option><option value="viewer">Viewer</option><option value="billing">Billing</option><option value="security">Security</option></select></label></div><button className="vc-btn primary" disabled={!email || invite.isPending} onClick={() => invite.mutate({ organizationId, email, role })}><MailPlus size={14} /> Save invitation</button></div><div className="vc-card"><span className="vc-eyebrow">Members</span><h3>Workspace members</h3>{members.data?.length ? members.data.map(member => { const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles; return <div className="vc-list-row" key={member.user_id}><Shield size={16} /><span><strong>{profile?.display_name || profile?.email || member.user_id}</strong><small>{profile?.email || "Profile email unavailable"}</small></span><select value={member.role} onChange={event => updateRole.mutate({ organizationId, userId: member.user_id, role: event.target.value as "owner" | "admin" | "member" | "viewer" | "billing" | "security" })}><option value="owner">Owner</option><option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option><option value="billing">Billing</option><option value="security">Security</option></select><button className="vc-btn" disabled={member.role === "owner"} onClick={() => remove.mutate({ organizationId, userId: member.user_id })}><UserMinus size={14} /> Remove</button></div>; }) : <Empty title="No members" body="Workspace membership will appear after Supabase auth provisioning." />}</div></>;
}

type PreferenceKey = "deploymentFailures" | "securityEvents" | "billingUpdates" | "observabilityAlerts";
type PreferenceState = Record<PreferenceKey, boolean>;

function NotificationPanel({ organizationId }: { organizationId: string }) {
  const preferences = trpc.workspace.notifications.get.useQuery({ organizationId }, { retry: false });
  const [draft, setDraft] = useState<PreferenceState | null>(null);
  const value: PreferenceState = draft ?? { deploymentFailures: preferences.data?.deployment_failures ?? true, securityEvents: preferences.data?.security_events ?? true, billingUpdates: preferences.data?.billing_updates ?? true, observabilityAlerts: preferences.data?.observability_alerts ?? true };
  const update = trpc.workspace.notifications.update.useMutation({ onSuccess: () => toast.success("Notification preferences saved"), onError: error => toast.error(error.message) });
  const toggle = (key: PreferenceKey) => setDraft({ ...value, [key]: !value[key] });
  return <div className="vc-card"><span className="vc-eyebrow">Notifications</span><h3>Workspace alerts</h3>{(Object.entries(value) as Array<[PreferenceKey, boolean]>).map(([key, enabled]) => <div className="vc-list-row" key={key}><Bell size={16} /><span><strong>{key.replace(/([A-Z])/g, " $1")}</strong><small>Organization notification preference</small></span><button className="vc-btn" onClick={() => toggle(key)}><Status good={enabled}>{enabled ? "Enabled" : "Disabled"}</Status></button></div>)}<button className="vc-btn primary" disabled={update.isPending} onClick={() => update.mutate({ organizationId, ...value })}>Save preferences</button></div>;
}

function AuditPanel() {
  const [action, setAction] = useState("");
  const [result, setResult] = useState<"success" | "failure" | "all">("all");
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const audit = trpc.workspace.audit.useQuery({ action: action.trim() || undefined, result: result === "all" ? undefined : result, limit, offset }, { retry: false });
  const events = audit.data ?? [];
  const exportCsv = () => {
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = ["created_at,action,result,resource_type,resource_id", ...events.map(event => [event.created_at, event.action, event.result, event.resource_type, event.resource_id].map(escape).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "cloud-wai-audit-log.csv"; link.click(); URL.revokeObjectURL(url);
  };
  return <div className="vc-card"><div className="vc-card-heading"><div><span className="vc-eyebrow">Governance</span><h3>Audit log</h3></div><button className="vc-btn" disabled={!events.length} onClick={exportCsv}>Export CSV</button></div><div className="vc-form-grid"><label>Search action<input value={action} onChange={event => { setAction(event.target.value); setOffset(0); }} placeholder="deployment.rollback" /></label><label>Result<select value={result} onChange={event => { setResult(event.target.value as typeof result); setOffset(0); }}><option value="all">All results</option><option value="success">Success</option><option value="failure">Failure</option></select></label></div>{events.length ? events.map(event => <div className="vc-list-row" key={event.id}><ClipboardList size={16} /><span><strong>{event.action}</strong><small>{event.resource_type || "workspace"} · {new Date(event.created_at).toLocaleString()}</small></span><Status good={event.result === "success"}>{event.result}</Status></div>) : <Empty title="No audit events" body="Administrative actions will appear here for authorized workspace roles." />}<div className="vc-card-heading"><span className="vc-eyebrow">Showing {offset + 1}–{offset + events.length}</span><div><button className="vc-btn" disabled={offset === 0 || audit.isFetching} onClick={() => setOffset(value => Math.max(0, value - limit))}>Previous</button><button className="vc-btn" disabled={events.length < limit || audit.isFetching} onClick={() => setOffset(value => value + limit)}>Next</button></div></div></div>;
}
