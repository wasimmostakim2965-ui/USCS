import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Bug, Gauge, Plus, Radio, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardBody, CardHead, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Select, Stat, StatusBadge, Tabs } from "@/components/ui-kit";
import { formatDate, toneForStatus, useOrganizationId } from "./shared";

type ObservabilityTab = "logs" | "metrics" | "errors" | "requests" | "alerts";
const tabs: ObservabilityTab[] = ["logs", "metrics", "errors", "requests", "alerts"];
const categoryFor: Record<ObservabilityTab, "log" | "metric" | "error" | "request" | undefined> = { logs: "log", metrics: "metric", errors: "error", requests: "request", alerts: undefined };

export default function Observability({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as ObservabilityTab) ? routeParts![1] as ObservabilityTab : "logs";
  const { organizationId, organization } = useOrganizationId();
  const [live, setLive] = useState(true);

  const events = trpc.observability.events.useQuery(organizationId ? { organizationId, category: categoryFor[tab] } : undefined, { enabled: Boolean(organizationId), retry: false, refetchInterval: live ? 5000 : false });
  const alerts = trpc.observability.alerts.list.useQuery(undefined, { enabled: Boolean(organizationId), retry: false });
  const errorGroups = trpc.observability.errorGroups.list.useQuery(organizationId ? { organizationId } : undefined, { enabled: Boolean(organizationId) && tab === "errors", retry: false });

  useEffect(() => { if (tab === "alerts") setLive(false); }, [tab]);

  return <>
    <PageHeader
      title="Observability"
      crumb="Workspace / Observability"
      description={organization?.name ? `Logs, metrics, errors and alerts for ${organization.name}.` : "Logs, metrics, errors, requests and alerts."}
      action={<Button onClick={() => setLive(value => !value)}><Radio size={14} /> {live ? "Live: on" : "Live: off"}</Button>}
    />
    <Tabs items={tabs.map(value => ({ label: value[0].toUpperCase() + value.slice(1), value }))} active={tab} onChange={value => onNavigate?.(`/dashboard/observability/${value}`)} />

    {tab === "alerts" ? <AlertsPanel organizationId={organizationId} alerts={alerts.data ?? []} refetch={() => void alerts.refetch()} isLoading={alerts.isLoading} error={alerts.error?.message} /> : <>
      <div className="ds-grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Events" value={events.data?.length ?? 0} hint={live ? "Refreshing every 5s" : "Polling paused"} />
        <Stat label="Errors" value={(events.data ?? []).filter((event: { severity?: string }) => event.severity === "error" || event.severity === "critical").length} />
        <Stat label="Average latency" value={averageLatency(events.data ?? [])} />
      </div>
      {tab === "errors" && errorGroups.data?.length ? <Card style={{ marginBottom: 16 }}>
        <CardHead eyebrow="Grouped" title="Error groups" description="Fingerprint-grouped occurrences with first and last seen timestamps." />
        <div className="ds-list">{errorGroups.data.map((group: { id: string; fingerprint?: string; example_message?: string; occurrence_count?: number; status?: string; last_seen_at?: string }) => (
          <div className="ds-row" key={group.id}><span className="ds-row-icon"><Bug size={15} /></span><span className="ds-row-main"><strong>{group.example_message ?? group.fingerprint}</strong><small>{group.occurrence_count} occurrences · last seen {formatDate(group.last_seen_at, true)}</small></span><StatusBadge tone={toneForStatus(group.status)}>{group.status}</StatusBadge></div>
        ))}</div>
      </Card> : null}
      <Card>
        <CardHead eyebrow={live ? "Streaming" : "Static"} title={tab === "logs" ? "Runtime logs" : tab === "metrics" ? "Metrics" : tab === "requests" ? "Requests" : "Errors"} action={<Button size="sm" onClick={() => void events.refetch()}><RefreshCw size={13} /> Refresh</Button>} />
        {events.isLoading ? <LoadingBlock rows={4} /> : events.error ? <ErrorState message={events.error.message} /> : events.data?.length ? (
          <div className="ds-log">{events.data.map((event: { id: string; severity?: string; message?: string; route?: string; status_code?: number; latency_ms?: number; occurred_at?: string }) => (
            <div className="ds-log-row" key={event.id}>
              <time>{formatDate(event.occurred_at, true)}</time>
              <span className={`ds-log-level ${event.severity === "error" || event.severity === "critical" ? "is-error" : event.severity === "warning" ? "is-warn" : "is-info"}`}>{event.severity ?? "info"}</span>
              <span>{event.message}{event.route ? ` — ${event.route}` : ""}{event.status_code ? ` [${event.status_code}]` : ""}{event.latency_ms ? ` ${event.latency_ms}ms` : ""}</span>
            </div>
          ))}</div>
        ) : <EmptyState title="No events yet" body="Append-only events appear once the observability adapter ingests logs, metrics, errors or requests." />}
      </Card>
    </>}
  </>;
}

function averageLatency(events: Array<{ latency_ms?: number }>) {
  const values = events.map(event => event.latency_ms).filter((value): value is number => typeof value === "number");
  if (!values.length) return "—";
  return `${Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)}ms`;
}

function AlertsPanel({ organizationId, alerts, refetch, isLoading, error }: { organizationId?: string; alerts: Array<Record<string, unknown>>; refetch: () => void; isLoading: boolean; error?: string }) {
  const [name, setName] = useState("");
  const [metric, setMetric] = useState<"error_rate" | "latency_p95" | "request_rate" | "uptime">("error_rate");
  const [threshold, setThreshold] = useState(1);
  const create = trpc.observability.alerts.create.useMutation({ onSuccess: () => { refetch(); setName(""); toast.success("Alert created"); }, onError: mutationError => toast.error(mutationError.message) });
  return <>
    <Card style={{ marginBottom: 16 }}>
      <CardHead eyebrow="Threshold" title="New alert" description="Alerts evaluate against real telemetry once the observability adapter is connected." />
      <CardBody>
        <div className="ds-form-grid">
          <Field label="Name"><Input value={name} onChange={event => setName(event.target.value)} placeholder="High error rate" /></Field>
          <Field label="Metric"><Select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}><option value="error_rate">Error rate</option><option value="latency_p95">Latency p95</option><option value="request_rate">Request rate</option><option value="uptime">Uptime</option></Select></Field>
          <Field label="Threshold"><Input type="number" value={threshold} onChange={event => setThreshold(Number(event.target.value) || 0)} /></Field>
        </div>
        <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!organizationId || !name || create.isPending} onClick={() => organizationId && create.mutate({ organizationId, projectId: null, name, metric, threshold })}><Plus size={14} /> Create alert</Button></div>
      </CardBody>
    </Card>
    <Card>
      <CardHead eyebrow="Alerts" title="Configured alerts" />
      {isLoading ? <LoadingBlock rows={3} /> : error ? <ErrorState message={error} /> : alerts.length ? (
        <div className="ds-list">{alerts.map(alert => (
          <div className="ds-row" key={String(alert.id)}>
            <span className="ds-row-icon"><AlertTriangle size={15} /></span>
            <span className="ds-row-main"><strong>{String(alert.name)}</strong><small>{String(alert.metric)} threshold {String(alert.threshold)} · {alert.last_triggered_at ? `last triggered ${formatDate(alert.last_triggered_at as string, true)}` : "never triggered"}</small></span>
            <StatusBadge tone={toneForStatus(String(alert.state))}>{String(alert.state ?? "idle")}</StatusBadge>
          </div>
        ))}</div>
      ) : <EmptyState title="No alerts configured" body="Create a threshold alert to monitor error rate, latency, request rate or uptime." />}
    </Card>
  </>;
}
