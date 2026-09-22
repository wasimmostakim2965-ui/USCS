import { Activity, Bot, Flame, Gauge, LockKeyhole, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardBody, CardHead, EmptyState, ErrorState, LoadingBlock, PageHeader, StatusBadge, Tabs } from "@/components/ui-kit";
import { formatDate, toneForStatus, useOrganizationId } from "./shared";

type SecurityTab = "posture" | "firewall" | "waf" | "rate-limiting" | "bot-protection" | "events";
const tabs: SecurityTab[] = ["posture", "firewall", "waf", "rate-limiting", "bot-protection", "events"];
const levels = ["none", "normal", "high", "ultimate"] as const;
type Level = typeof levels[number];

const levelCopy: Record<Level, string> = {
  none: "No edge enforcement. Traffic is passed through unchanged.",
  normal: "Baseline firewall, balanced WAF and standard rate limiting.",
  high: "Strict WAF sensitivity, tighter rate limits and bot challenges.",
  ultimate: "Maximum enforcement, aggressive bot challenges and strict TLS.",
};

export default function Security({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as SecurityTab) ? routeParts![1] as SecurityTab : "posture";
  const { organizationId, organization } = useOrganizationId();
  const [level, setLevel] = useState<Level>("normal");

  const policy = trpc.security.getPolicy.useQuery({ organizationId: organizationId ?? "00000000-0000-0000-0000-000000000000", projectId: null }, { enabled: Boolean(organizationId), retry: false });
  const preview = trpc.security.previewPolicy.useQuery({ level }, { retry: false });
  const edgeEvents = trpc.security.edgeEvents.useQuery({ organizationId: organizationId ?? "00000000-0000-0000-0000-000000000000", projectId: null }, { enabled: Boolean(organizationId), retry: false });

  const setLevelMutation = trpc.security.setLevel.useMutation({
    onSuccess: () => { void policy.refetch(); toast.success("Security level saved"); },
    onError: error => toast.error(error.message),
  });
  const applyPolicy = trpc.security.applyPolicy.useMutation({
    onSuccess: result => { void policy.refetch(); toast[result.status === "applied" ? "success" : "warning"](result.message); },
    onError: error => toast.error(error.message),
  });

  const currentLevel = (policy.data?.policy?.security_level as Level | undefined) ?? "none";

  return <>
    <PageHeader
      title="Security"
      crumb="Workspace / Security"
      description={organization?.name ? `Edge protection policy for ${organization.name}. Nothing is called protected without evidence.` : "Edge protection policy and enforcement history."}
      action={<Button variant="primary" disabled={!organizationId || applyPolicy.isPending} onClick={() => organizationId && applyPolicy.mutate({ organizationId, projectId: null })}><Zap size={14} /> {applyPolicy.isPending ? "Applying…" : "Apply policy"}</Button>}
    />
    <Tabs items={tabs.map(value => ({ label: value.replaceAll("-", " ").replace(/\b\w/g, character => character.toUpperCase()), value }))} active={tab} onChange={value => onNavigate?.(`/dashboard/security/${value}`)} />

    {tab === "posture" ? <>
      <Card style={{ marginBottom: 16 }}>
        <CardHead eyebrow="Enforcement level" title="Protection posture" description="Choose a level to generate a policy preview. Edge enforcement stays off until a real edge adapter is connected." action={<StatusBadge tone={policy.data?.policy?.last_apply_status === "applied" ? "ready" : "neutral"}>{policy.data?.policy?.last_apply_status ?? "Not applied"}</StatusBadge>} />
        <CardBody>
          <div className="ds-security-levels">
            {levels.map(value => (
              <button key={value} className={`ds-level ${currentLevel === value || level === value ? "is-active" : ""}`} onClick={() => setLevel(value)}>
                <span className="ds-level-icon">{value === "none" ? <LockKeyhole size={16} /> : value === "normal" ? <ShieldCheck size={16} /> : value === "high" ? <Flame size={16} /> : <Sparkles size={16} />}</span>
                <strong>{value[0].toUpperCase() + value.slice(1)}</strong>
                <small>{levelCopy[value]}</small>
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <Button variant="primary" disabled={!organizationId || setLevelMutation.isPending} onClick={() => organizationId && setLevelMutation.mutate({ organizationId, projectId: null, level, autoSetup: true })}>Save level</Button>
            <Button disabled={!organizationId || applyPolicy.isPending} onClick={() => organizationId && applyPolicy.mutate({ organizationId, projectId: null })}>Apply to edge</Button>
          </div>
          {preview.data?.config ? <pre className="ds-code">{JSON.stringify(preview.data.config, null, 2)}</pre> : null}
        </CardBody>
      </Card>
      <Card>
        <CardHead eyebrow="History" title="Enforcement events" description="Policy changes are append-only and organization-scoped." />
        {policy.isLoading ? <LoadingBlock rows={3} /> : policy.data?.events?.length ? (
          <div className="ds-list">{policy.data.events.map((event: { id: string; event_type: string; error_message?: string; created_at?: string }) => (
            <div className="ds-row" key={event.id}><span className="ds-row-icon"><Activity size={15} /></span><span className="ds-row-main"><strong>{event.event_type}</strong><small>{event.error_message ?? "No enforcement error"} · {formatDate(event.created_at, true)}</small></span></div>
          ))}</div>
        ) : <EmptyState title="No policy events yet" body="Saving or applying a security level records an event here." />}
      </Card>
    </> : null}

    {tab === "firewall" ? <ConfigPanel title="Firewall" icon={<Flame size={15} />} body={preview.data?.config?.firewall} note="Deny rules and private-network blocks persist in the policy document and are pushed to the edge adapter on apply." /> : null}
    {tab === "waf" ? <ConfigPanel title="WAF" icon={<ShieldCheck size={15} />} body={preview.data?.config?.waf} note="OWASP core rules and sensitivity are stored per level and enforced once the edge adapter is connected." /> : null}
    {tab === "rate-limiting" ? <ConfigPanel title="Rate limiting" icon={<Gauge size={15} />} body={preview.data?.config?.rateLimit} note="Requests per minute and per-path rules are part of the enforcement document." /> : null}
    {tab === "bot-protection" ? <ConfigPanel title="Bot protection" icon={<Bot size={15} />} body={preview.data?.config?.botProtection} note="Challenge thresholds scale with the selected security level." /> : null}

    {tab === "events" ? <Card>
      <CardHead eyebrow="Edge" title="Security edge events" description="Blocked, challenged and allowed requests recorded by the edge adapter." />
      {edgeEvents.isLoading ? <LoadingBlock rows={3} /> : edgeEvents.error ? <ErrorState message={edgeEvents.error.message} /> : edgeEvents.data?.length ? (
        <div className="ds-list">{edgeEvents.data.map((event: { id: string; event_type: string; action?: string; source?: string; path?: string; created_at?: string }) => (
          <div className="ds-row" key={event.id}><span className="ds-row-icon"><Activity size={15} /></span><span className="ds-row-main"><strong>{event.event_type} · {event.action}</strong><small>{event.source ?? "source unknown"} · {event.path ?? "/"} · {formatDate(event.created_at, true)}</small></span><StatusBadge tone={toneForStatus(event.action)}>{event.action}</StatusBadge></div>
        ))}</div>
      ) : <EmptyState title="No edge events" body="Edge events appear once a real security edge adapter emits them. Nothing is fabricated." />}
    </Card> : null}
  </>;
}

function ConfigPanel({ title, icon, body, note }: { title: string; icon: ReactNode; body?: unknown; note: string }) {
  return <Card>
    <CardHead eyebrow="Policy document" title={title} description={note} action={icon} />
    <CardBody>
      {body ? <pre className="ds-code">{JSON.stringify(body, null, 2)}</pre> : <EmptyState title={`${title} preview unavailable`} body="Select a security level on the posture tab to generate a policy preview." />}
    </CardBody>
  </Card>;
}
