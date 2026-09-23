import { useState } from "react";
import { Globe2, LockKeyhole, Plus, Search, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardBody, CardHead, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Select, StatusBadge, Tabs } from "@/components/ui-kit";
import { formatDate, toneForStatus, useOrganizationId } from "./shared";

type DomainTab = "my-domains" | "add-domain" | "dns-records" | "nameservers" | "ssl-tls";
const tabs: DomainTab[] = ["my-domains", "add-domain", "dns-records", "nameservers", "ssl-tls"];

export default function Domains({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as DomainTab) ? routeParts![1] as DomainTab : "my-domains";
  const { organizationId, organization } = useOrganizationId();
  const domains = trpc.domains.list.useQuery(organizationId ? { organizationId } : undefined, { enabled: Boolean(organizationId), retry: false });
  const [selectedId, setSelectedId] = useState<string>();
  const [hostname, setHostname] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const createDomain = trpc.domains.create.useMutation({
    onSuccess: result => { void domains.refetch(); setHostname(""); toast.info(result.reason); },
    onError: error => toast.error(error.message),
  });
  const search = trpc.domains.search.useQuery({ query: searchQuery }, { enabled: false, retry: false });

  const selected = (domains.data ?? []).find((domain: { id: string }) => domain.id === selectedId) ?? domains.data?.[0];
  const go = (next: DomainTab) => onNavigate?.(`/dashboard/domains/${next}`);

  return <>
    <PageHeader
      title="Domains"
      crumb="Workspace / Domains"
      description={organization?.name ? `Domains scoped to ${organization.name}.` : "Domains, DNS records and TLS status."}
      action={<Button variant="primary" onClick={() => go("add-domain")}><Plus size={14} /> Add domain</Button>}
    />
    <Tabs items={tabs.map(value => ({ label: value.replaceAll("-", " ").replace(/\b\w/g, character => character.toUpperCase()), value }))} active={tab} onChange={value => go(value as DomainTab)} />

    {tab === "my-domains" ? <Card>
      <CardHead eyebrow="Registry" title="My domains" description="Registrar, DNS and TLS state for every connected domain." />
      {domains.isLoading ? <LoadingBlock rows={3} /> : domains.error ? <ErrorState message={domains.error.message} /> : domains.data?.length ? (
        <div className="ds-list">{domains.data.map((domain: { id: string; hostname: string; status?: string; ssl_status?: string; dnssec_enabled?: boolean; created_at?: string }) => (
          <button className="ds-row" key={domain.id} onClick={() => { setSelectedId(domain.id); go("dns-records"); }}>
            <span className="ds-row-icon"><Globe2 size={15} /></span>
            <span className="ds-row-main"><strong>{domain.hostname}</strong><small>SSL {domain.ssl_status ?? "not configured"} · DNSSEC {domain.dnssec_enabled ? "on" : "off"} · added {formatDate(domain.created_at)}</small></span>
            <StatusBadge tone={toneForStatus(domain.status)}>{domain.status}</StatusBadge>
          </button>
        ))}</div>
      ) : <EmptyState title="No domains yet" body="Add a domain to persist a registry record. Live DNS stays off until a DNS adapter is configured." action={<Button variant="primary" onClick={() => go("add-domain")}><Plus size={14} /> Add domain</Button>} />}
    </Card> : null}

    {tab === "add-domain" ? <>
      <Card style={{ marginBottom: 16 }}>
        <CardHead eyebrow="New domain" title="Search and register" description="Search availability, then persist a registry record for this workspace." />
        <CardBody>
          <div style={{ display: "flex", gap: 8 }}>
            <div className="ds-search" style={{ flex: 1 }}><Search size={15} /><Input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="example.com" /></div>
            <Button disabled={searchQuery.trim().length < 3} onClick={() => void search.refetch()}>Search</Button>
          </div>
          {search.data ? <div className="ds-callout" style={{ marginTop: 14 }}><div style={{ minWidth: 0 }}><strong>Registrar result</strong><p>{(search.data as { message?: string })?.message ?? JSON.stringify(search.data)}</p></div></div> : null}
        </CardBody>
      </Card>
      <Card>
        <CardHead eyebrow="Persist" title="Add to workspace" description="The record is saved honestly; no live DNS is claimed while the provider is disconnected." />
        <CardBody>
          <div className="ds-form-grid">
            <Field label="Hostname"><Input value={hostname} onChange={event => setHostname(event.target.value.toLowerCase())} placeholder="example.com" /></Field>
          </div>
          <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!organizationId || !hostname || createDomain.isPending} onClick={() => organizationId && createDomain.mutate({ organizationId, hostname })}>Save domain</Button></div>
        </CardBody>
      </Card>
    </> : null}

    {tab === "dns-records" ? <DnsRecords domainId={selected?.id} domains={(domains.data ?? []) as Array<{ id: string; hostname: string }>} selectedId={selected?.id} onSelect={setSelectedId} /> : null}

    {tab === "nameservers" ? <Card>
      <CardHead eyebrow="Delegation" title="Nameservers" description="Delegation targets are published by the DNS provider once connected." />
      {selected ? <div className="ds-list">
        <div className="ds-row"><span className="ds-row-main"><strong>{selected.hostname}</strong><small>DNSSEC {selected.dnssec_enabled ? "enabled" : "disabled"}</small></span>
          <Button size="sm" onClick={() => toast.info("Nameservers are populated by the DNS adapter once configured.")}>Refresh</Button>
        </div>
        <DnssecToggle domainId={selected.id} enabled={Boolean(selected.dnssec_enabled)} />
      </div> : <EmptyState title="No domain selected" body="Add a domain to inspect nameserver delegation." />}
    </Card> : null}

    {tab === "ssl-tls" ? <Card>
      <CardHead eyebrow="Transport" title="SSL / TLS" description="Certificate state for the selected domain." action={<StatusBadge tone={selected?.ssl_status === "active" ? "ready" : "neutral"}>{selected?.ssl_status ?? "Not configured"}</StatusBadge>} />
      {selected ? <CardBody>
        <div className="ds-callout"><div className="ds-callout-icon"><ShieldCheck size={18} /></div><div><strong>{selected.hostname}</strong><p>Certificates are issued by the edge adapter. Until it is connected, TLS provisioning stays not configured rather than pretending to be secure.</p></div></div>
      </CardBody> : <EmptyState title="No domain selected" body="Add a domain to inspect TLS state." />}
    </Card> : null}
  </>;
}

function DnssecToggle({ domainId, enabled }: { domainId: string; enabled: boolean }) {
  const mutation = trpc.domains.updateDnssec.useMutation({ onSuccess: result => toast.info(result.reason), onError: error => toast.error(error.message) });
  return <div className="ds-row"><span className="ds-row-main"><strong>DNSSEC</strong><small>Publish a DS record through the DNS provider.</small></span><Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate({ id: domainId, enabled: !enabled })}>{enabled ? "Disable" : "Enable"}</Button></div>;
}

function DnsRecords({ domainId, domains, selectedId, onSelect }: { domainId?: string; domains: Array<{ id: string; hostname: string }>; selectedId?: string; onSelect: (id: string) => void }) {
  const records = trpc.domains.records.list.useQuery({ domainId: domainId ?? "00000000-0000-0000-0000-000000000000" }, { enabled: Boolean(domainId), retry: false });
  const [recordType, setRecordType] = useState<"A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS">("A");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [ttl, setTtl] = useState(3600);

  const create = trpc.domains.records.create.useMutation({
    onSuccess: result => { void records.refetch(); setName(""); setValue(""); toast.info(result.reason); },
    onError: error => toast.error(error.message),
  });
  const remove = trpc.domains.records.delete.useMutation({ onSuccess: () => { void records.refetch(); toast.success("DNS record removed"); }, onError: error => toast.error(error.message) });

  if (!domains.length) return <Card><EmptyState title="No domains yet" body="Add a domain before managing DNS records." /></Card>;

  return <>
    <Card style={{ marginBottom: 16 }}>
      <CardHead eyebrow="Zone" title="DNS records" description="Records are stored per domain and pushed to the DNS adapter when connected." action={<Select value={selectedId ?? domainId} onChange={event => onSelect(event.target.value)} style={{ minWidth: 180 }}>{domains.map(domain => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}</Select>} />
      {records.isLoading ? <LoadingBlock rows={3} /> : records.data?.length ? (
        <div className="ds-list">{records.data.map((record: { id: string; record_type: string; name: string; value: string; ttl: number }) => (
          <div className="ds-row" key={record.id}>
            <span className="ds-row-icon">{record.record_type}</span>
            <span className="ds-row-main"><strong className="ds-mono">{record.name}</strong><small className="ds-mono">{record.value}</small></span>
            <span style={{ color: "var(--ds-fg-muted)", fontSize: 12 }}>TTL {record.ttl}</span>
            <Button variant="danger" size="sm" onClick={() => remove.mutate({ id: record.id })}><Trash2 size={13} /></Button>
          </div>
        ))}</div>
      ) : <EmptyState title="No DNS records" body="Add A, AAAA, CNAME, TXT, MX or NS records. They are pushed to the provider when one is connected." />}
    </Card>

    <Card>
      <CardHead eyebrow="Add record" title="New record" action={<LockKeyhole size={15} color="var(--ds-fg-subtle)" />} />
      <CardBody>
        <div className="ds-form-grid">
          <Field label="Type"><Select value={recordType} onChange={event => setRecordType(event.target.value as typeof recordType)}>{["A", "AAAA", "CNAME", "TXT", "MX", "NS"].map(type => <option key={type} value={type}>{type}</option>)}</Select></Field>
          <Field label="Name"><Input value={name} onChange={event => setName(event.target.value)} placeholder="@" /></Field>
          <Field label="Value"><Input value={value} onChange={event => setValue(event.target.value)} placeholder="76.76.21.21" /></Field>
          <Field label="TTL"><Input type="number" value={ttl} onChange={event => setTtl(Number(event.target.value) || 3600)} min={60} max={86400} /></Field>
        </div>
        <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!domainId || !name || !value || create.isPending} onClick={() => domainId && create.mutate({ domainId, recordType, name, value, ttl })}><Plus size={14} /> Add record</Button></div>
      </CardBody>
    </Card>
  </>;
}
