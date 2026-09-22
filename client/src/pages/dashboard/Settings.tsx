import { useState } from "react";
import { Bell, ClipboardList, Link2, Settings2, Shield } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardBody, CardHead, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Select, StatusBadge, Tabs } from "@/components/ui-kit";
import { formatDate, toneForStatus, useOrganizationId } from "./shared";

type SettingsTab = "workspace" | "notifications" | "connected-accounts" | "audit";
const tabs: SettingsTab[] = ["workspace", "notifications", "connected-accounts", "audit"];

export default function Settings({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as SettingsTab) ? routeParts![1] as SettingsTab : "workspace";
  const { organizationId, organization } = useOrganizationId();
  const account = trpc.account.me.useQuery(undefined, { retry: false });

  return <>
    <PageHeader title="Settings" crumb="Workspace / Settings" description="Workspace identity, notification preferences, connections and the audit log." />
    <Tabs items={tabs.map(value => ({ label: value.replaceAll("-", " ").replace(/\b\w/g, character => character.toUpperCase()), value }))} active={tab} onChange={value => onNavigate?.(`/dashboard/settings/${value}`)} />

    {tab === "workspace" ? <>
      <Card style={{ marginBottom: 16 }}>
        <CardHead eyebrow="Identity" title={organization?.name ?? "Workspace"} description="Organization-scoped Supabase RLS with role-aware mutations." action={<StatusBadge tone="ready">Protected</StatusBadge>} />
        <div className="ds-list">
          <div className="ds-row"><span className="ds-row-icon"><Settings2 size={15} /></span><span className="ds-row-main"><strong>Workspace slug</strong><small className="ds-mono">{organization?.slug ?? "Not resolved"}</small></span></div>
          <div className="ds-row"><span className="ds-row-icon"><Shield size={15} /></span><span className="ds-row-main"><strong>Your role</strong><small>{organization?.role ?? "member"}</small></span><StatusBadge>{organization?.role ?? "member"}</StatusBadge></div>
        </div>
      </Card>
      <Card>
        <CardHead eyebrow="Account" title="Signed-in identity" />
        {account.isLoading ? <LoadingBlock rows={2} /> : account.error ? <ErrorState message={account.error.message} /> : <div className="ds-list">
          <div className="ds-row"><span className="ds-row-main"><strong>{account.data?.name || "Account"}</strong><small>{account.data?.email ?? "Email unavailable"}</small></span></div>
          <div className="ds-row"><span className="ds-row-main"><strong>Sign-in method</strong><small>{account.data?.loginMethod ?? "unknown"}</small></span></div>
          <div className="ds-row"><span className="ds-row-main"><strong>Account ID</strong><small className="ds-mono">{account.data?.id ?? "—"}</small></span></div>
        </div>}
      </Card>
    </> : null}

    {tab === "notifications" ? <NotificationPanel organizationId={organizationId} /> : null}

    {tab === "connected-accounts" ? <Card>
      <CardHead eyebrow="OAuth" title="Connected accounts" description="Provider connection management renders once a connection contract is configured." />
      <div className="ds-list">
        <div className="ds-row"><span className="ds-row-icon"><Link2 size={15} /></span><span className="ds-row-main"><strong>Git providers</strong><small>Manage GitHub, GitLab and Bitbucket from Developer → Git connections.</small></span><StatusBadge>Not configured</StatusBadge></div>
      </div>
    </Card> : null}

    {tab === "audit" ? <AuditPanel /> : null}
  </>;
}

type PreferenceKey = "deploymentFailures" | "securityEvents" | "billingUpdates" | "observabilityAlerts";
type PreferenceState = Record<PreferenceKey, boolean>;

function NotificationPanel({ organizationId }: { organizationId?: string }) {
  const preferences = trpc.workspace.notifications.get.useQuery({ organizationId: organizationId ?? "00000000-0000-0000-0000-000000000000" }, { enabled: Boolean(organizationId), retry: false });
  const [draft, setDraft] = useState<PreferenceState | null>(null);
  const value: PreferenceState = draft ?? {
    deploymentFailures: preferences.data?.deployment_failures ?? true,
    securityEvents: preferences.data?.security_events ?? true,
    billingUpdates: preferences.data?.billing_updates ?? true,
    observabilityAlerts: preferences.data?.observability_alerts ?? true,
  };
  const update = trpc.workspace.notifications.update.useMutation({ onSuccess: () => toast.success("Notification preferences saved"), onError: error => toast.error(error.message) });
  const toggle = (key: PreferenceKey) => setDraft({ ...value, [key]: !value[key] });
  return <Card>
    <CardHead eyebrow="Notifications" title="Workspace alerts" description="Preferences are stored per organization and applied to alert delivery once a destination is configured." />
    {preferences.isLoading ? <LoadingBlock rows={3} /> : (
      <div className="ds-list">{(Object.entries(value) as Array<[PreferenceKey, boolean]>).map(([key, enabled]) => (
        <div className="ds-row" key={key}><span className="ds-row-icon"><Bell size={15} /></span><span className="ds-row-main"><strong>{key.replace(/([A-Z])/g, " $1").replace(/^./, character => character.toUpperCase())}</strong><small>Organization notification preference</small></span><Button size="sm" onClick={() => toggle(key)}><StatusBadge tone={enabled ? "ready" : "neutral"}>{enabled ? "Enabled" : "Disabled"}</StatusBadge></Button></div>
      ))}</div>
    )}
    <CardBody><Button variant="primary" disabled={!organizationId || update.isPending} onClick={() => organizationId && update.mutate({ organizationId, ...value })}>Save preferences</Button></CardBody>
  </Card>;
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
    const csv = ["created_at,action,result,resource_type,resource_id", ...events.map((event: { created_at?: string; action?: string; result?: string; resource_type?: string; resource_id?: string }) => [event.created_at, event.action, event.result, event.resource_type, event.resource_id].map(escape).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "cloud-wai-audit-log.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return <Card>
    <CardHead eyebrow="Governance" title="Audit log" description="Administrative actions recorded with actor, resource and result." action={<Button size="sm" disabled={!events.length} onClick={exportCsv}>Export CSV</Button>} />
    <CardBody>
      <div className="ds-form-grid">
        <Field label="Search action"><Input value={action} onChange={event => { setAction(event.target.value); setOffset(0); }} placeholder="deployment.rollback" /></Field>
        <Field label="Result"><Select value={result} onChange={event => { setResult(event.target.value as typeof result); setOffset(0); }}><option value="all">All results</option><option value="success">Success</option><option value="failure">Failure</option></Select></Field>
      </div>
    </CardBody>
    {audit.isLoading ? <LoadingBlock rows={4} /> : audit.error ? <ErrorState message={audit.error.message} /> : events.length ? (
      <div className="ds-list">{events.map((event: { id: string; action?: string; result?: string; resource_type?: string; created_at?: string }) => (
        <div className="ds-row" key={event.id}><span className="ds-row-icon"><ClipboardList size={15} /></span><span className="ds-row-main"><strong>{event.action}</strong><small>{event.resource_type ?? "workspace"} · {formatDate(event.created_at, true)}</small></span><StatusBadge tone={toneForStatus(event.result)}>{event.result}</StatusBadge></div>
      ))}</div>
    ) : <EmptyState title="No audit events" body="Administrative actions appear here for authorized workspace roles." />}
    <CardBody>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "var(--ds-fg-muted)", fontSize: 12 }}>Showing {events.length ? offset + 1 : 0}–{offset + events.length}</span>
        <div style={{ display: "flex", gap: 8 }}>
          <Button size="sm" disabled={offset === 0 || audit.isFetching} onClick={() => setOffset(value => Math.max(0, value - limit))}>Previous</Button>
          <Button size="sm" disabled={events.length < limit || audit.isFetching} onClick={() => setOffset(value => value + limit)}>Next</Button>
        </div>
      </div>
    </CardBody>
  </Card>;
}
