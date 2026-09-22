import { useState } from "react";
import { Check, Globe2, LockKeyhole, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ComingSoon, Empty, Header, Stat, Status } from "./shared";

type DomainTab = "my-domains" | "add-domain" | "dns-records" | "nameservers" | "ssl-tls" | "marketplace";
const tabs: DomainTab[] = ["my-domains", "add-domain", "dns-records", "nameservers", "ssl-tls", "marketplace"];

export default function Domains({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as DomainTab) ? routeParts?.[1] as DomainTab : "my-domains";
  const domains = trpc.domains.list.useQuery(undefined, { retry: false });
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const [selectedDomainId, setSelectedDomainId] = useState<string>();
  const selectedDomain = (domains.data ?? []).find(domain => domain.id === selectedDomainId) ?? domains.data?.[0];
  const navigateTab = (next: DomainTab) => onNavigate?.(`/dashboard/domains/${next}`);
  return <><Header title="Domains" action={<button className="vc-btn primary" onClick={() => navigateTab("add-domain")}><Plus size={14} /> Add domain</button>} />
    <div className="vc-subtabs">{tabs.map(value => <button key={value} className={tab === value ? "active" : ""} onClick={() => navigateTab(value)}>{value.replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase())}</button>)}</div>
    {tab === "my-domains" && <DomainList data={domains.data ?? []} loading={domains.isLoading} error={domains.error?.message} onAdd={() => navigateTab("add-domain")} onSelect={setSelectedDomainId} />}
    {tab === "add-domain" && <AddDomain organizationId={organizations.data?.[0]?.id} onCreated={() => { void domains.refetch(); navigateTab("my-domains"); }} />}
    {tab === "dns-records" && <DnsRecords domains={domains.data ?? []} selectedDomain={selectedDomain} onSelect={setSelectedDomainId} />}
    {tab === "nameservers" && <DomainMetadata title="Nameservers" domain={selectedDomain} body="Nameservers are read from the connected registrar. The control plane stores the returned set but will not invent provider values." />}
    {tab === "ssl-tls" && <DomainMetadata title="SSL/TLS" domain={selectedDomain} body="Certificate issuance is provider-gated. A domain can be marked active only after a real edge adapter confirms it." />}
    {tab === "marketplace" && <Marketplace />}
  </>;
}

function DomainList({ data, loading, error, onAdd, onSelect }: { data: Array<{ id: string; hostname: string; status: string; ssl_status: string; dnssec_enabled: boolean }>; loading: boolean; error?: string; onAdd: () => void; onSelect: (id: string) => void }) {
  return <><div className="vc-grid-3"><Stat label="Connected domains" value={loading ? "—" : String(data.length)} /><Stat label="SSL active" value={loading ? "—" : String(data.filter(domain => domain.ssl_status === "active").length)} /><Stat label="DNSSEC" value={loading ? "—" : String(data.filter(domain => domain.dnssec_enabled).length)} /></div><div className="vc-card">{loading ? <div className="vc-loading-row">Loading domains…</div> : error ? <Empty title="Unable to load domains" body={error} /> : data.length ? data.map(domain => <button className="vc-list-row" key={domain.id} onClick={() => onSelect(domain.id)}><Globe2 size={16} /><span><strong>{domain.hostname}</strong><small>{domain.ssl_status === "active" ? "TLS active" : "TLS not configured"}</small></span><Status good={domain.status === "active"}>{domain.status}</Status><span>{domain.dnssec_enabled ? <><Check size={14} /> DNSSEC</> : "DNSSEC off"}</span></button>) : <Empty title="No domains connected" body="Add a domain to save a tenant-scoped record. Live registrar, DNS and TLS state stays not configured until providers are connected." action="Add domain" onAction={onAdd} />}</div></>;
}

function AddDomain({ organizationId, onCreated }: { organizationId?: string; onCreated: () => void }) {
  const [hostname, setHostname] = useState("");
  const create = trpc.domains.create.useMutation({ onSuccess: result => { toast.info(result.reason); onCreated(); }, onError: error => toast.error(error.message) });
  return <div className="vc-card vc-settings-editor"><span className="vc-eyebrow">Tenant domain</span><h3>Add a domain</h3><p>This creates a durable domain record. It does not claim ownership or publish DNS without a configured provider.</p><label>Hostname<input value={hostname} onChange={event => setHostname(event.target.value)} placeholder="app.example.com" /></label><button className="vc-btn primary" disabled={!organizationId || create.isPending} onClick={() => organizationId && create.mutate({ organizationId, hostname })}>{create.isPending ? "Saving…" : "Save domain"}</button>{!organizationId && <small>Sign in to a workspace before adding a domain.</small>}</div>;
}

function DnsRecords({ domains, selectedDomain, onSelect }: { domains: Array<{ id: string; hostname: string }>; selectedDomain?: { id: string; hostname: string }; onSelect: (id: string) => void }) {
  const [type, setType] = useState<"A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS">("A");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const records = trpc.domains.records.list.useQuery({ domainId: selectedDomain?.id ?? "00000000-0000-0000-0000-000000000000" }, { enabled: Boolean(selectedDomain), retry: false });
  const add = trpc.domains.records.create.useMutation({ onSuccess: result => { toast.info(result.reason); setName(""); setValue(""); void records.refetch(); }, onError: error => toast.error(error.message) });
  const remove = trpc.domains.records.delete.useMutation({ onSuccess: result => { toast.info(result.reason); void records.refetch(); }, onError: error => toast.error(error.message) });
  return <><div className="vc-card vc-settings-editor"><label>Domain<select value={selectedDomain?.id ?? ""} onChange={event => onSelect(event.target.value)}>{domains.map(domain => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}</select></label><div className="vc-form-grid"><label>Type<select value={type} onChange={event => setType(event.target.value as typeof type)}>{["A", "AAAA", "CNAME", "TXT", "MX", "NS"].map(value => <option key={value}>{value}</option>)}</select></label><label>Name<input value={name} onChange={event => setName(event.target.value)} placeholder="www" /></label><label>Value<input value={value} onChange={event => setValue(event.target.value)} placeholder="203.0.113.10" /></label></div><button className="vc-btn primary" disabled={!selectedDomain || !name || !value || add.isPending} onClick={() => selectedDomain && add.mutate({ domainId: selectedDomain.id, recordType: type, name, value })}><Plus size={14} /> Add record</button></div><div className="vc-card">{records.isLoading ? <div className="vc-loading-row">Loading DNS records…</div> : records.data?.length ? records.data.map(record => <div className="vc-list-row" key={record.id}><span><strong>{record.record_type} {record.name}</strong><small>{record.value} · TTL {record.ttl}</small></span><Status>{record.priority == null ? "Record" : `Priority ${record.priority}`}</Status><button className="vc-icon-btn" aria-label={`Delete ${record.name}`} onClick={() => remove.mutate({ id: record.id })}><Trash2 size={14} /></button></div>) : <Empty title="No DNS records" body="Records are stored locally until a DNS adapter can publish them." />}</div></>;
}

function DomainMetadata({ title, domain, body }: { title: string; domain?: { id: string; hostname: string; nameservers?: string[]; ssl_status: string; dnssec_enabled: boolean }; body: string }) {
  const dnssec = trpc.domains.updateDnssec.useMutation({ onSuccess: result => toast.info(result.reason), onError: error => toast.error(error.message) });
  return <div className="vc-card"><Header title={title} crumb={domain?.hostname ?? "Select a domain"} /><p>{body}</p>{domain ? <><div className="vc-list-row"><LockKeyhole size={16} /><span><strong>{domain.ssl_status === "active" ? "Active" : "Not configured"}</strong><small>{domain.nameservers?.length ? domain.nameservers.join(", ") : "No provider nameservers returned"}</small></span><Status good={domain.ssl_status === "active"}>{domain.ssl_status}</Status></div><div className="vc-list-row"><span><strong>DNSSEC</strong><small>{domain.dnssec_enabled ? "Metadata enabled" : "Disabled"}</small></span><button className="vc-btn" disabled={dnssec.isPending} onClick={() => dnssec.mutate({ id: domain.id, enabled: !domain.dnssec_enabled })}>{domain.dnssec_enabled ? "Disable" : "Enable"}</button></div><ComingSoon title="Provider action" body="Live registrar and edge adapter credentials are required before this control can make an external change." /></> : <Empty title="Select a domain" body="Choose a domain from My domains before inspecting provider metadata." />}</div>;
}

function Marketplace() {
  const [query, setQuery] = useState("");
  const search = trpc.domains.search.useQuery({ query }, { enabled: query.length > 0, retry: false });
  return <div className="vc-card vc-settings-editor"><span className="vc-eyebrow">Domain marketplace</span><h3>Search availability</h3><p>Search uses the reseller adapter contract. Results remain unknown until a live reseller is configured.</p><input value={query} onChange={event => setQuery(event.target.value)} placeholder="your-brand" />{search.data && <div className="vc-list-row"><Globe2 size={16} /><span><strong>{search.data.results[0]?.domain ?? search.data.query}</strong><small>{search.data.message}</small></span><Status>{search.data.status}</Status></div>}</div>;
}
