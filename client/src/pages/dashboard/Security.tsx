import { useState } from "react";
import { Plus, ShieldCheck, TriangleAlert, Zap } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Empty, Header, Stat, Status } from "./shared";

type SecurityTab = "overview" | "security-level" | "waf" | "custom-firewall" | "rate-limiting" | "bot-protection" | "ddos-events" | "ssl-tls" | "security-events";
const tabs: SecurityTab[] = ["overview", "security-level", "waf", "custom-firewall", "rate-limiting", "bot-protection", "ddos-events", "ssl-tls", "security-events"];
const zeroUuid = "00000000-0000-0000-0000-000000000000";
type PolicyConfig = { level?: "none" | "normal" | "high" | "ultimate"; firewall?: { enabled?: boolean; denyPrivateNetworks?: boolean; rules?: Array<{ field: "ip" | "country" | "path"; operator: "equals" | "contains" | "in"; value: string; action: "allow" | "deny" }> }; waf?: { enabled?: boolean; owaspCoreRules?: boolean; sensitivity?: string }; rateLimit?: { enabled?: boolean; requestsPerMinute?: number; rules?: Array<{ path: string; method: "ANY" | "GET" | "POST" | "PUT" | "DELETE"; threshold: number; windowSeconds: number; action: "throttle" | "block" }> }; botProtection?: { enabled?: boolean; challengeThreshold?: string }; tls?: { minimumVersion?: string; hsts?: boolean; securityHeaders?: boolean } };

export default function Security({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as SecurityTab) ? routeParts?.[1] as SecurityTab : "overview";
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const organizationId = organizations.data?.[0]?.id ?? zeroUuid;
  const policy = trpc.security.getPolicy.useQuery({ organizationId }, { enabled: Boolean(organizations.data?.[0]), retry: false });
  const setLevel = trpc.security.setLevel.useMutation({ onSuccess: () => { void policy.refetch(); toast.success("Security level saved"); }, onError: error => toast.error(error.message) });
  const updateConfig = trpc.security.updateConfig.useMutation({ onSuccess: () => { void policy.refetch(); toast.success("Security controls saved"); }, onError: error => toast.error(error.message) });
  const apply = trpc.security.applyPolicy.useMutation({ onSuccess: result => { void policy.refetch(); toast.info(result.message); }, onError: error => toast.error(error.message) });
  const preview = trpc.security.previewPolicy.useQuery({ level: policy.data?.policy?.security_level ?? "normal" }, { enabled: tab === "overview" || tab === "security-level", retry: false });
  const navigate = (next: SecurityTab) => onNavigate?.(`/dashboard/security/${next}`);
  const currentLevel = policy.data?.policy?.security_level ?? "normal";
  const config = (policy.data?.policy?.desired_config ?? {}) as PolicyConfig;
  return <><Header title="Security" action={<button className="vc-btn primary" disabled={!policy.data?.policy || apply.isPending} onClick={() => apply.mutate({ organizationId })}><Zap size={14} /> {apply.isPending ? "Applying…" : "Apply policy"}</button>} />
    <div className="vc-subtabs">{tabs.map(value => <button key={value} className={tab === value ? "active" : ""} onClick={() => navigate(value)}>{value.replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase())}</button>)}</div>
    {!organizations.data?.length ? <Empty title="Workspace required" body="Sign in to a workspace to inspect security policy state." /> : policy.isLoading ? <div className="vc-loading-row">Loading policy…</div> : policy.error ? <Empty title="Unable to load security policy" body={policy.error.message} /> : <>
      {tab === "overview" && <Overview level={currentLevel} status={policy.data?.policy?.last_apply_status ?? "not_applied"} config={config} events={policy.data?.events ?? []} preview={preview.data?.config} />}
      {tab === "security-level" && <LevelPanel organizationId={organizationId} level={currentLevel} pending={setLevel.isPending} onChange={level => setLevel.mutate({ organizationId, level, autoSetup: true })} preview={preview.data?.config} />}
      {(["waf", "custom-firewall", "rate-limiting", "bot-protection", "ssl-tls"] as SecurityTab[]).includes(tab) && <ConfigPanel tab={tab} config={config} onSave={next => updateConfig.mutate({ organizationId, config: next as never })} />}
      {tab === "ddos-events" && <EdgeEvents organizationId={organizationId} eventType="ddos" title="DDoS events" />}
      {tab === "security-events" && <><Events events={policy.data?.events ?? []} /><EdgeEvents organizationId={organizationId} title="Edge security events" /></>}
    </>}
  </>;
}

function Overview({ level, status, config, events, preview }: { level: string; status: string; config: PolicyConfig; events: Array<{ id: string; event_type: string; error_message?: string | null; created_at: string }>; preview?: unknown }) {
  return <><div className="vc-grid-3"><Stat label="Security level" value={level} /><Stat label="Enforcement" value={status} /><Stat label="Policy events" value={String(events.length)} /></div><div className="vc-card"><div className="vc-card-heading"><div><span className="vc-eyebrow">Policy posture</span><h3>Concrete edge controls</h3></div><Status good={status === "applied"}>{status}</Status></div><div className="vc-list-row"><ShieldCheck size={16} /><span><strong>WAF</strong><small>{config.waf?.sensitivity ?? "not configured"} sensitivity · OWASP CRS {config.waf?.owaspCoreRules ? "enabled" : "disabled"}</small></span><Status good={Boolean(config.waf?.enabled)}>{config.waf?.enabled ? "Enabled" : "Off"}</Status></div><div className="vc-list-row"><ShieldCheck size={16} /><span><strong>Rate limiting</strong><small>{config.rateLimit?.requestsPerMinute ?? "—"} requests/minute ceiling</small></span><Status good={Boolean(config.rateLimit?.enabled)}>{config.rateLimit?.enabled ? "Enabled" : "Off"}</Status></div><div className="vc-list-row"><ShieldCheck size={16} /><span><strong>TLS</strong><small>{config.tls?.minimumVersion ?? "—"} · HSTS {config.tls?.hsts ? "on" : "off"}</small></span><Status good={Boolean(config.tls?.securityHeaders)}>{config.tls?.securityHeaders ? "Hardened" : "Review"}</Status></div></div><div className="vc-card"><span className="vc-eyebrow">Preview contract</span><p>Preview renders OpenResty, Coraza, CrowdSec, nftables, rate-limit and mTLS tunnel artifacts before remote mutation.</p><small>{preview ? "Artifacts generated for the current policy." : "Preview unavailable until a workspace policy exists."}</small></div></>;
}

function LevelPanel({ organizationId, level, pending, onChange, preview }: { organizationId: string; level: string; pending: boolean; onChange: (level: "none" | "normal" | "high" | "ultimate") => void; preview?: unknown }) {
  return <div className="vc-card vc-settings-editor"><span className="vc-eyebrow">Security posture</span><h3>Choose enforcement level</h3><p>Changing the level updates desired configuration. It does not claim remote enforcement until Apply policy succeeds.</p><label>Level<select value={level} disabled={pending || organizationId === zeroUuid} onChange={event => onChange(event.target.value as "none" | "normal" | "high" | "ultimate")}><option value="none">None</option><option value="normal">Normal</option><option value="high">High</option><option value="ultimate">Ultimate</option></select></label><div className="vc-list-row"><TriangleAlert size={16} /><span><strong>{preview ? "Preview ready" : "No preview"}</strong><small>Generated artifacts remain a dry-run until policy application is confirmed.</small></span></div></div>;
}

function ConfigPanel({ tab, config, onSave }: { tab: SecurityTab; config: PolicyConfig; onSave: (config: PolicyConfig) => void }) {
  const key = tab === "custom-firewall" ? "firewall" : tab === "rate-limiting" ? "rateLimit" : tab === "bot-protection" ? "botProtection" : tab === "ssl-tls" ? "tls" : "waf";
  const value = (key === "firewall" ? config.firewall : key === "rateLimit" ? config.rateLimit : key === "botProtection" ? config.botProtection : key === "tls" ? config.tls : config.waf) as Record<string, unknown> | undefined;
  const toggle = (name: string) => value && onSave({ ...config, [key]: { ...value, [name]: !value[name] } });
  const [ruleValue, setRuleValue] = useState("");
  const addRule = () => {
    if (!ruleValue) return;
    if (key === "firewall") onSave({ ...config, firewall: { ...config.firewall, rules: [...(config.firewall?.rules ?? []), { field: "path", operator: "contains", value: ruleValue, action: "deny" }] } });
    if (key === "rateLimit") onSave({ ...config, rateLimit: { ...config.rateLimit, rules: [...(config.rateLimit?.rules ?? []), { path: ruleValue, method: "ANY", threshold: config.rateLimit?.requestsPerMinute ?? 60, windowSeconds: 60, action: "throttle" }] } });
    setRuleValue("");
  };
  const rules = key === "firewall" ? config.firewall?.rules ?? [] : config.rateLimit?.rules ?? [];
  return <div className="vc-card"><span className="vc-eyebrow">Desired configuration</span><h3>{tab.replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase())}</h3><p>Controls update the persisted desired policy. Enforcement remains separate until the edge adapter confirms apply.</p>{value ? Object.entries(value).filter(([name]) => name !== "rules").map(([name, setting]) => <div className="vc-list-row" key={name}><span><strong>{name.replaceAll(/([A-Z])/g, " $1")}</strong></span><button className="vc-btn" onClick={() => toggle(name)}><Status good={setting === true || typeof setting === "number"}>{String(setting)}</Status></button></div>) : <Empty title="Not configured" body="Choose a security level to generate this policy section." />}{(key === "firewall" || key === "rateLimit") && <><div className="vc-form-grid"><label>{key === "firewall" ? "Path match" : "Rate-limit path"}<input value={ruleValue} onChange={event => setRuleValue(event.target.value)} placeholder={key === "firewall" ? "/admin" : "/api/login"} /></label></div><button className="vc-btn" disabled={!ruleValue} onClick={addRule}><Plus size={14} /> Add rule</button>{rules.map((rule, index) => <div className="vc-list-row" key={index}><ShieldCheck size={16} /><span><strong>{key === "firewall" ? (rule as { value: string }).value : (rule as { path: string }).path}</strong><small>{key === "firewall" ? `${(rule as { action: string }).action} · ${(rule as { operator: string }).operator}` : `${(rule as { method: string }).method} · ${(rule as { threshold: number }).threshold}/${(rule as { windowSeconds: number }).windowSeconds}s`}</small></span><Status>{key === "firewall" ? "Custom rule" : "Limiter"}</Status></div>)}</>}</div>;
}

function EdgeEvents({ organizationId, projectId, eventType, title }: { organizationId: string; projectId?: string; eventType?: "waf" | "firewall" | "rate_limit" | "bot" | "ddos" | "tls"; title: string }) {
  const query = trpc.security.edgeEvents.useQuery({ organizationId, projectId, eventType }, { retry: false });
  return <div className="vc-card"><span className="vc-eyebrow">Telemetry</span><h3>{title}</h3>{query.data?.length ? query.data.map(event => <div className="vc-list-row" key={event.id}><ShieldCheck size={16} /><span><strong>{event.event_type} · {event.action}</strong><small>{event.path || "No path"} · {new Date(event.created_at).toLocaleString()}</small></span><Status>{event.source}</Status></div>) : <Empty title={`No ${eventType ?? "edge"} events`} body="The connected edge adapter has not emitted telemetry for this scope." />}</div>;
}

function Events({ events }: { events: Array<{ id: string; event_type: string; error_message?: string | null; created_at: string }> }) {
  return <div className="vc-card">{events.length ? events.map(event => <div className="vc-list-row" key={event.id}><ShieldCheck size={16} /><span><strong>{event.event_type}</strong><small>{event.error_message || "Policy event recorded"} · {new Date(event.created_at).toLocaleString()}</small></span><Status good={event.event_type === "applied"}>{event.event_type}</Status></div>) : <Empty title="No security events" body="Policy previews and applies will appear here with desired/applied configuration metadata." />}</div>;
}
