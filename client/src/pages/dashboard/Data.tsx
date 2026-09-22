import { Database, HardDrive, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardBody, CardHead, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Select, StatusBadge, Tabs } from "@/components/ui-kit";
import { formatDate, toneForStatus, useOrganizationId } from "./shared";

type DataTab = "databases" | "storage-buckets" | "backups";
const tabs: DataTab[] = ["databases", "storage-buckets", "backups"];

type QueryLike = { data?: Array<Record<string, unknown>>; isLoading: boolean; error?: { message: string } | null; refetch: () => unknown };

export default function Data({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as DataTab) ? routeParts![1] as DataTab : "databases";
  const { organizationId, organization } = useOrganizationId();

  const databaseInstances = trpc.data.databaseInstances.list.useQuery(organizationId ? { organizationId } : undefined, { enabled: Boolean(organizationId), retry: false });
  const storageBuckets = trpc.data.storageBuckets.list.useQuery(organizationId ? { organizationId } : undefined, { enabled: Boolean(organizationId), retry: false });
  const backups = trpc.data.backups.list.useQuery(organizationId ? { organizationId } : undefined, { enabled: Boolean(organizationId), retry: false });

  return <>
    <PageHeader
      title="Data"
      crumb="Workspace / Data"
      description={organization?.name ? `Databases, storage and backups scoped to ${organization.name}.` : "Databases, storage buckets and backups."}
    />
    <Tabs items={tabs.map(value => ({ label: value.replaceAll("-", " ").replace(/\b\w/g, character => character.toUpperCase()), value }))} active={tab} onChange={value => onNavigate?.(`/dashboard/data/${value}`)} />
    {tab === "databases" ? <DatabasesPanel organizationId={organizationId} query={databaseInstances} /> : null}
    {tab === "storage-buckets" ? <BucketsPanel organizationId={organizationId} query={storageBuckets} /> : null}
    {tab === "backups" ? <BackupsPanel organizationId={organizationId} query={backups} /> : null}
  </>;
}

function DatabasesPanel({ organizationId, query }: { organizationId?: string; query: QueryLike }) {
  const [name, setName] = useState("");
  const provision = trpc.data.databaseInstances.provision.useMutation({
    onSuccess: result => { void query.refetch(); setName(""); toast[result.configured ? "success" : "warning"](result.configured ? "Database provisioned" : result.reason); },
    onError: error => toast.error(error.message),
  });
  return <>
    <Card style={{ marginBottom: 16 }}>
      <CardHead eyebrow="Provision" title="New database instance" description="Provisioning is delegated to the data adapter. The record is saved honestly even when no adapter is configured." />
      <CardBody>
        <div className="ds-form-grid">
          <Field label="Instance name"><Input value={name} onChange={event => setName(event.target.value)} placeholder="primary-postgres" /></Field>
        </div>
        <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!organizationId || !name || provision.isPending} onClick={() => organizationId && provision.mutate({ organizationId, projectId: null, name })}><Plus size={14} /> Provision database</Button></div>
      </CardBody>
    </Card>
    <Card>
      <CardHead eyebrow="Instances" title="Database instances" />
      {query.isLoading ? <LoadingBlock rows={3} /> : query.error ? <ErrorState message={query.error.message} /> : query.data?.length ? (
        <div className="ds-list">{query.data.map(instance => (
          <div className="ds-row" key={String(instance.id)}>
            <span className="ds-row-icon"><Database size={15} /></span>
            <span className="ds-row-main"><strong>{String(instance.name)}</strong><small>{String(instance.engine ?? "Engine not configured")} · {String(instance.error_message ?? instance.tenant_identifier ?? "Provider reference not assigned")}</small></span>
            <StatusBadge tone={toneForStatus(String(instance.status))}>{String(instance.status)}</StatusBadge>
          </div>
        ))}</div>
      ) : <EmptyState title="No databases yet" body="Provision a database to store a control-plane record. Live provisioning stays not configured until the data adapter is connected." />}
    </Card>
  </>;
}

function BucketsPanel({ organizationId, query }: { organizationId?: string; query: QueryLike }) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const provision = trpc.data.storageBuckets.provision.useMutation({
    onSuccess: result => { void query.refetch(); setName(""); toast[result.configured ? "success" : "warning"](result.configured ? "Bucket provisioned" : result.reason); },
    onError: error => toast.error(error.message),
  });
  return <>
    <Card style={{ marginBottom: 16 }}>
      <CardHead eyebrow="Provision" title="New storage bucket" description="Buckets are private by default and remain behind an explicit access boundary." />
      <CardBody>
        <div className="ds-form-grid">
          <Field label="Bucket name"><Input value={name} onChange={event => setName(event.target.value)} placeholder="assets" /></Field>
          <Field label="Visibility"><Select value={visibility} onChange={event => setVisibility(event.target.value as typeof visibility)}><option value="private">Private</option><option value="public">Public</option></Select></Field>
        </div>
        <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!organizationId || !name || provision.isPending} onClick={() => organizationId && provision.mutate({ organizationId, projectId: null, name, visibility })}><Plus size={14} /> Provision bucket</Button></div>
      </CardBody>
    </Card>
    <Card>
      <CardHead eyebrow="Buckets" title="Storage buckets" />
      {query.isLoading ? <LoadingBlock rows={3} /> : query.error ? <ErrorState message={query.error.message} /> : query.data?.length ? (
        <div className="ds-list">{query.data.map(bucket => (
          <div className="ds-row" key={String(bucket.id)}>
            <span className="ds-row-icon"><HardDrive size={15} /></span>
            <span className="ds-row-main"><strong>{String(bucket.name)}</strong><small>{String(bucket.visibility)} · {String(bucket.region ?? "Region not configured")} · {String(bucket.error_message ?? "Provider reference not assigned")}</small></span>
            <StatusBadge tone={toneForStatus(String(bucket.status))}>{String(bucket.status)}</StatusBadge>
          </div>
        ))}</div>
      ) : <EmptyState title="No buckets yet" body="Provision a bucket to store objects. Uploads are delegated to the storage adapter." />}
    </Card>
  </>;
}

function BackupsPanel({ organizationId, query }: { organizationId?: string; query: QueryLike }) {
  const restore = trpc.data.backups.restore.useMutation({ onSuccess: result => { void query.refetch(); toast[result.configured ? "success" : "warning"](result.reason); }, onError: error => toast.error(error.message) });
  const createBackup = trpc.data.backups.create.useMutation({ onSuccess: result => { void query.refetch(); toast[result.configured ? "success" : "warning"](result.configured ? "Backup created" : result.reason); }, onError: error => toast.error(error.message) });
  const [resourceType, setResourceType] = useState<"database" | "storage">("database");
  const [resourceId, setResourceId] = useState("");
  return <Card>
    <CardHead eyebrow="Recovery" title="Backups" description="Backup and restore operations are delegated to the data adapter and recorded in the audit log." />
    <CardBody>
      <div className="ds-form-grid">
        <Field label="Resource type"><Select value={resourceType} onChange={event => setResourceType(event.target.value as typeof resourceType)}><option value="database">Database</option><option value="storage">Storage</option></Select></Field>
        <Field label="Resource ID"><Input value={resourceId} onChange={event => setResourceId(event.target.value)} placeholder="00000000-0000-0000-0000-000000000000" /></Field>
      </div>
      <div style={{ marginTop: 12 }}><Button size="sm" disabled={!organizationId || !resourceId || createBackup.isPending} onClick={() => organizationId && createBackup.mutate({ organizationId, resourceType, resourceId })}>Create backup</Button></div>
    </CardBody>
    {query.isLoading ? <LoadingBlock rows={3} /> : query.error ? <ErrorState message={query.error.message} /> : query.data?.length ? (
      <div className="ds-list">{query.data.map(backup => (
        <div className="ds-row" key={String(backup.id)}>
          <span className="ds-row-icon"><RotateCcw size={15} /></span>
          <span className="ds-row-main"><strong>{String(backup.resource_type)} backup</strong><small>{String(backup.error_message ?? backup.adapter_ref ?? "Provider reference not assigned")} · {formatDate(backup.created_at as string, true)}</small></span>
          <StatusBadge tone={toneForStatus(String(backup.status))}>{String(backup.status)}</StatusBadge>
          <Button size="sm" disabled={restore.isPending} onClick={() => restore.mutate({ id: String(backup.id) })}>Restore</Button>
        </div>
      ))}</div>
    ) : <EmptyState title="No backups yet" body="Create database or storage backups to see them here with the adapter result and size." />}
  </Card>;
}
