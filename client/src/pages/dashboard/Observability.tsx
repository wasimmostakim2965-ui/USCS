import { useState } from "react";
import { Activity, BellRing, Clock3, FileWarning, Gauge, Search } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Empty, Header, Stat, Status } from "./shared";

type ObserveTab = "logs" | "metrics" | "errors" | "requests" | "alerts";
const tabs: ObserveTab[] = ["logs", "metrics", "errors", "requests", "alerts"];
const categoryFor: Record<Exclude<ObserveTab, "metrics" | "alerts">, "log" | "error" | "request"> = { logs: "log", errors: "error", requests: "request" };

export default function Observability({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as ObserveTab) ? routeParts?.[1] as ObserveTab : "logs";
  const events = trpc.observability.events.useQuery(tab === "metrics" || tab === "alerts" ? undefined : { category: categoryFor[tab as Exclude<ObserveTab, "metrics" | "alerts">] }, { retry: false, enabled: tab !== "alerts" });
  const alerts = trpc.observability.alerts.list.useQuery(undefined, { retry: false, enabled: tab === "alerts" });
  const go = (next: ObserveTab) => onNavigate?.(`/dashboard/observability/${next}`);
  return <><Header title="Observability" /><div className="vc-subtabs">{tabs.map(value => <button key={value} className={tab === value ? "active" : ""} onClick={() => go(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><div className="vc-grid-3"><Stat label="Requests" value={events.data?.filter(event => event.category === "request").length.toString() ?? "—"} /><Stat label="Errors" value={events.data?.filter(event => event.category === "error").length.toString() ?? "—"} /><Stat label="Active alerts" value={alerts.data?.filter(alert => alert.enabled).length.toString() ?? "—"} /></div>{tab === "alerts" ? <AlertPanel data={alerts.data ?? []} /> : tab === "metrics" ? <MetricsPanel events={events.data ?? []} /> : <EventPanel events={events.data ?? []} loading={events.isLoading} category={categoryFor[tab as Exclude<ObserveTab, "metrics" | "alerts">]} />}</>;
}

function EventPanel({ events, loading, category }: { events: Array<{ id: string; category: string; severity: string; message: string; route?: string | null; status_code?: number | null; latency_ms?: number | null; occurred_at: string }>; loading: boolean; category: string }) {
  const [search, setSearch] = useState("");
  const filtered = events.filter(event => `${event.message} ${event.route ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="vc-card"><div className="vc-filterbar"><Search size={14} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={`Search ${category}s`} /></div>{loading ? <div className="vc-loading-row">Loading telemetry…</div> : filtered.length ? filtered.map(event => <div className="vc-list-row" key={event.id}><Activity size={16} /><span><strong>{event.message}</strong><small>{event.route || "No route"} · {event.status_code ?? "—"} · {event.latency_ms ?? "—"}ms · {new Date(event.occurred_at).toLocaleString()}</small></span><Status good={event.severity === "info"}>{event.severity}</Status></div>) : <Empty title={`No ${category} events`} body="Runtime telemetry is not configured, so the control plane will not invent logs, metrics, requests or errors." />}</div>;
}

function MetricsPanel({ events }: { events: Array<{ latency_ms?: number | null; status_code?: number | null }> }) {
  const latencies = events.map(event => event.latency_ms).filter((value): value is number => typeof value === "number");
  const average = latencies.length ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length) : null;
  return <div className="vc-card"><div className="vc-list-row"><Gauge size={16} /><span><strong>Latency summary</strong><small>Computed only from ingested request telemetry.</small></span><Status>{average == null ? "Not configured" : `${average}ms avg`}</Status></div>{events.length ? <div className="vc-list-row"><Clock3 size={16} /><span><strong>Samples</strong><small>{events.length} request samples available</small></span></div> : <Empty title="No metric samples" body="Connect a runtime telemetry source before metrics can be calculated." />}</div>;
}

function AlertPanel({ data }: { data: Array<{ id: string; name: string; metric: string; threshold: number; enabled: boolean; state: string; last_triggered_at?: string | null }> }) {
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const [name, setName] = useState("");
  const [metric, setMetric] = useState<"error_rate" | "latency_p95" | "request_rate" | "uptime">("error_rate");
  const [threshold, setThreshold] = useState("5");
  const create = trpc.observability.alerts.create.useMutation({ onSuccess: () => { toast.success("Alert rule saved"); setName(""); }, onError: error => toast.error(error.message) });
  return <><div className="vc-card vc-settings-editor"><span className="vc-eyebrow">Alerting</span><h3>Create alert rule</h3><p>Rules are persisted now; triggering requires an ingested telemetry source.</p><div className="vc-form-grid"><label>Name<input value={name} onChange={event => setName(event.target.value)} placeholder="High error rate" /></label><label>Metric<select value={metric} onChange={event => setMetric(event.target.value as typeof metric)}><option value="error_rate">Error rate</option><option value="latency_p95">Latency P95</option><option value="request_rate">Request rate</option><option value="uptime">Uptime</option></select></label><label>Threshold<input type="number" value={threshold} onChange={event => setThreshold(event.target.value)} /></label></div><button className="vc-btn primary" disabled={!organizations.data?.[0]?.id || !name || create.isPending} onClick={() => organizations.data?.[0]?.id && create.mutate({ organizationId: organizations.data[0].id, name, metric, threshold: Number(threshold) })}><BellRing size={14} /> Save alert rule</button></div><div className="vc-card">{data.length ? data.map(alert => <div className="vc-list-row" key={alert.id}><FileWarning size={16} /><span><strong>{alert.name}</strong><small>{alert.metric} ≥ {alert.threshold}</small></span><Status good={alert.state === "triggered"}>{alert.state}</Status></div>) : <Empty title="No alert rules" body="Create a rule to persist an explicit threshold. It will remain unknown until telemetry ingestion is connected." />}</div></>;
}
