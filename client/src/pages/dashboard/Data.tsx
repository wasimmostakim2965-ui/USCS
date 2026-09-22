import { useState } from "react";
import { Archive, Database, HardDrive, KeyRound, Plus, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Empty, Header, Stat, Status } from "./shared";

type DataTab = "databases" | "storage-buckets" | "backups" | "connection-details";
const tabs: DataTab[] = ["databases", "storage-buckets", "backups", "connection-details"];

export default function Data({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as DataTab) ? routeParts?.[1] as DataTab : "databases";
  const databases = trpc.data.databaseInstances.list.useQuery(undefined, { retry: false });
  const buckets = trpc.data.storageBuckets.list.useQuery(undefined, { retry: false });
  const backups = trpc.data.backups.list.useQuery(undefined, { retry: false });
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string>();
  const [selectedBucketId, setSelectedBucketId] = useState<string>();
  const selectedDatabase = (databases.data ?? []).find(item => item.id === selectedDatabaseId) ?? databases.data?.[0];
  const selectedBucket = (buckets.data ?? []).find(item => item.id === selectedBucketId) ?? buckets.data?.[0];
  const go = (next: DataTab) => onNavigate?.(`/dashboard/data/${next}`);
  return <><Header title="Data" action={<button className="vc-btn primary" onClick={() => go("databases")}><Plus size={14} /> Add resource</button>} />
    <div className="vc-subtabs">{tabs.map(value => <button key={value} className={tab === value ? "active" : ""} onClick={() => go(value)}>{value.replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase())}</button>)}</div>
    <div className="vc-grid-3"><Stat label="Databases" value={databases.isLoading ? "—" : String(databases.data?.length ?? 0)} /><Stat label="Buckets" value={buckets.isLoading ? "—" : String(buckets.data?.length ?? 0)} /><Stat label="Backups" value={backups.isLoading ? "—" : String(backups.data?.length ?? 0)} /></div>
    {tab === "databases" && <DatabasePanel data={databases.data ?? []} organizationId={organizations.data?.[0]?.id} onRefresh={() => void databases.refetch()} onSelect={setSelectedDatabaseId} />}
    {tab === "storage-buckets" && <BucketPanel data={buckets.data ?? []} organizationId={organizations.data?.[0]?.id} onRefresh={() => void buckets.refetch()} onSelect={setSelectedBucketId} />}
    {tab === "backups" && <BackupPanel data={backups.data ?? []} databases={databases.data ?? []} buckets={buckets.data ?? []} organizationId={organizations.data?.[0]?.id} onRefresh={() => void backups.refetch()} />}
    {tab === "connection-details" && <ConnectionDetails database={selectedDatabase} bucket={selectedBucket} />}
  </>;
}

function DatabasePanel({ data, organizationId, onRefresh, onSelect }: { data: Array<{ id: string; name: string; engine: string; status: string; tenant_identifier?: string | null; adapter_ref?: string | null; error_message?: string | null }>; organizationId?: string; onRefresh: () => void; onSelect: (id: string) => void }) {
  const [name, setName] = useState("");
  const provision = trpc.data.databaseInstances.provision.useMutation({ onSuccess: result => { toast.info(result.configured ? "Database provisioned" : result.reason); setName(""); onRefresh(); }, onError: error => toast.error(error.message) });
  return <><div className="vc-card vc-settings-editor"><span className="vc-eyebrow">PostgreSQL</span><h3>Create database instance</h3><div className="vc-form-grid"><label>Name<input value={name} onChange={event => setName(event.target.value)} placeholder="app-primary" /></label></div><button className="vc-btn primary" disabled={!organizationId || !name || provision.isPending} onClick={() => organizationId && provision.mutate({ organizationId, name })}><Database size={14} /> {provision.isPending ? "Provisioning…" : "Provision database"}</button></div><div className="vc-card">{data.length ? data.map(item => <button className="vc-list-row" key={item.id} onClick={() => onSelect(item.id)}><Database size={16} /><span><strong>{item.name}</strong><small>{item.engine} · {item.tenant_identifier || item.error_message || "Tenant not assigned"}</small></span><Status good={item.status === "ready"}>{item.status}</Status></button>) : <Empty title="No database instances" body="Create a database record to persist the intent. A real Postgres adapter is required before provisioning can succeed." />}</div></>;
}

function BucketPanel({ data, organizationId, onRefresh, onSelect }: { data: Array<{ id: string; name: string; visibility: string; status: string; region?: string | null; error_message?: string | null }>; organizationId?: string; onRefresh: () => void; onSelect: (id: string) => void }) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const provision = trpc.data.storageBuckets.provision.useMutation({ onSuccess: result => { toast.info(result.configured ? "Bucket provisioned" : result.reason); setName(""); onRefresh(); }, onError: error => toast.error(error.message) });
  return <><div className="vc-card vc-settings-editor"><span className="vc-eyebrow">Object storage</span><h3>Create storage bucket</h3><div className="vc-form-grid"><label>Name<input value={name} onChange={event => setName(event.target.value)} placeholder="uploads" /></label><label>Visibility<select value={visibility} onChange={event => setVisibility(event.target.value as typeof visibility)}><option value="private">Private</option><option value="public">Public</option></select></label></div><button className="vc-btn primary" disabled={!organizationId || !name || provision.isPending} onClick={() => organizationId && provision.mutate({ organizationId, name, visibility })}><HardDrive size={14} /> {provision.isPending ? "Provisioning…" : "Provision bucket"}</button></div><div className="vc-card">{data.length ? data.map(item => <button className="vc-list-row" key={item.id} onClick={() => onSelect(item.id)}><HardDrive size={16} /><span><strong>{item.name}</strong><small>{item.visibility} · {item.region || item.error_message || "Region not assigned"}</small></span><Status good={item.status === "ready"}>{item.status}</Status></button>) : <Empty title="No storage resources" body="Create a bucket record to persist the intent. A real MinIO adapter is required before provisioning can succeed." />}</div></>;
}

function BackupPanel({ data, databases, buckets, organizationId, onRefresh }: { data: Array<{ id: string; resource_type: string; status: string; size_bytes?: number | null; error_message?: string | null; created_at: string }>; databases: Array<{ id: string; name: string }>; buckets: Array<{ id: string; name: string }>; organizationId?: string; onRefresh: () => void }) {
  const [resourceType, setResourceType] = useState<"database" | "storage">("database");
  const [resourceId, setResourceId] = useState("");
  const create = trpc.data.backups.create.useMutation({ onSuccess: result => { toast.info(result.configured ? "Backup started" : result.reason); onRefresh(); }, onError: error => toast.error(error.message) });
  const resources = resourceType === "database" ? databases : buckets;
  return <><div className="vc-card vc-settings-editor"><span className="vc-eyebrow">Recovery</span><h3>Create backup</h3><div className="vc-form-grid"><label>Resource type<select value={resourceType} onChange={event => { setResourceType(event.target.value as typeof resourceType); setResourceId(""); }}><option value="database">Database</option><option value="storage">Storage bucket</option></select></label><label>Resource<select value={resourceId} onChange={event => setResourceId(event.target.value)}><option value="">Select a resource</option>{resources.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label></div><button className="vc-btn primary" disabled={!organizationId || !resourceId || create.isPending} onClick={() => organizationId && create.mutate({ organizationId, resourceType, resourceId })}><Archive size={14} /> {create.isPending ? "Starting…" : "Create backup"}</button></div><div className="vc-card">{data.length ? data.map(item => <div className="vc-list-row" key={item.id}><Archive size={16} /><span><strong>{item.resource_type} backup</strong><small>{item.size_bytes ? `${item.size_bytes} bytes` : item.error_message || new Date(item.created_at).toLocaleString()}</small></span><Status good={item.status === "completed"}>{item.status}</Status></div>) : <Empty title="No backups" body="Backups are created against a specific database or bucket and remain failed honestly until the corresponding adapter is configured." />}</div></>;
}

function ConnectionDetails({ database, bucket }: { database?: { name: string; engine: string; status: string; tenant_identifier?: string | null; adapter_ref?: string | null }; bucket?: { name: string; visibility: string; status: string; region?: string | null; adapter_ref?: string | null } }) {
  return <div className="vc-card"><span className="vc-eyebrow">Connection details</span><h3>Provider-safe metadata</h3><p>Secrets and raw connection strings are never stored in resource metadata. This view exposes only tenant identifiers and adapter references returned by a configured provider.</p>{database ? <div className="vc-list-row"><KeyRound size={16} /><span><strong>{database.name}</strong><small>{database.engine} · tenant: {database.tenant_identifier || "not assigned"}</small></span><Status good={database.status === "ready"}>{database.status}</Status></div> : null}{bucket ? <div className="vc-list-row"><Server size={16} /><span><strong>{bucket.name}</strong><small>{bucket.visibility} · region: {bucket.region || "not assigned"} · adapter: {bucket.adapter_ref || "not configured"}</small></span><Status good={bucket.status === "ready"}>{bucket.status}</Status></div> : null}{!database && !bucket && <Empty title="No resource selected" body="Open a database or bucket from its tab to inspect provider-safe connection metadata." />}</div>;
}
