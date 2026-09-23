import { useState } from "react";
import { ArrowLeft, GitBranch, LockKeyhole, Rocket, RotateCcw, TerminalSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardBody, CardHead, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Select, Stat, StatusBadge, Tabs } from "@/components/ui-kit";
import { formatDate, toneForStatus } from "./shared";

type Environment = "production" | "preview" | "development";
type DeploymentTab = "summary" | "build-logs" | "source" | "rollback-history";

const environments = ["all", "production", "preview", "development"] as const;
const environmentTabs = ["all", "production", "preview", "development"] as const;
const isUuid = (value?: string) => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));

export default function Deployments({ routeParts, onNavigate, onOpen }: { routeParts?: string[]; onNavigate?: (href: string) => void; onOpen?: (id?: string) => void }) {
  const deploymentId = routeParts?.[1];
  if (isUuid(deploymentId)) return <DeploymentDetail id={deploymentId!} tab={(routeParts?.[2] as DeploymentTab | undefined) ?? "summary"} onNavigate={onNavigate} />;
  return <DeploymentList selectedEnvironment={routeParts?.[1]} onOpen={onOpen} onNavigate={onNavigate} />;
}

function DeploymentList({ selectedEnvironment, onOpen, onNavigate }: { selectedEnvironment?: string; onOpen?: (id?: string) => void; onNavigate?: (href: string) => void }) {
  const environment = environments.includes(selectedEnvironment as typeof environments[number]) ? selectedEnvironment! : "all";
  const query = trpc.deployments.list.useQuery(undefined, { retry: false });
  const items = (query.data ?? []).filter((item: { environment?: string }) => environment === "all" || item.environment === environment);
  const all = query.data ?? [];
  return <>
    <PageHeader
      title="Deployments"
      crumb="Workspace / Deployments"
      description="Every deployment record is organization-scoped and audited."
      action={<Button variant="primary" onClick={() => onNavigate?.("/dashboard/developer/git-connections")}><Rocket size={14} /> New deployment</Button>}
    />
    <Tabs items={environmentTabs.map(value => ({ label: value[0].toUpperCase() + value.slice(1), value }))} active={environment} onChange={value => onNavigate?.(`/dashboard/deployments/${value}`)} />
    <div className="ds-grid-3" style={{ marginBottom: 16 }}>
      <Stat label="Visible deployments" value={query.isLoading ? "—" : items.length} />
      <Stat label="Production" value={query.isLoading ? "—" : all.filter((item: { environment?: string }) => item.environment === "production").length} />
      <Stat label="Ready" value={query.isLoading ? "—" : all.filter((item: { status?: string }) => item.status === "ready").length} />
    </div>
    <Card>
      <CardHead eyebrow="Deployment log" title={environment === "all" ? "All environments" : environment} description="Ordered by most recent first." />
      {query.isLoading ? <LoadingBlock rows={4} /> : query.error ? <ErrorState message={query.error.message} /> : items.length ? (
        <div className="ds-list">{items.map((item: { id: string; status?: string; environment?: string; source_branch?: string; source_repository?: string; commit_sha?: string; created_at?: string }) => (
          <button className="ds-row" key={item.id} onClick={() => onOpen?.(item.id)}>
            <span className="ds-row-icon"><Rocket size={15} /></span>
            <span className="ds-row-main"><strong>{item.commit_sha?.slice(0, 8) || item.source_branch || item.id.slice(0, 8)}</strong><small>{item.source_repository || "Source not configured"}</small></span>
            <span style={{ color: "var(--ds-fg-muted)", fontSize: 12 }}>{item.environment}</span>
            <StatusBadge tone={toneForStatus(item.status)}>{item.status}</StatusBadge>
            <small style={{ color: "var(--ds-fg-muted)", fontSize: 11.5 }}>{formatDate(item.created_at, true)}</small>
          </button>
        ))}</div>
      ) : <EmptyState title="No deployments in this environment" body="A deployment record appears after a real hosting adapter accepts a deployment intent. No infrastructure state is fabricated." />}
    </Card>
  </>;
}

function DeploymentDetail({ id, tab, onNavigate }: { id: string; tab: DeploymentTab; onNavigate?: (href: string) => void }) {
  const query = trpc.deployments.get.useQuery({ id, includeLogs: true }, { retry: false, refetchInterval: tab === "build-logs" ? 3000 : false });
  const deployment = query.data?.deployment;
  const protectionQuery = trpc.deployments.protection.get.useQuery(
    { organizationId: deployment?.organization_id ?? "00000000-0000-0000-0000-000000000000", projectId: deployment?.project_id ?? "00000000-0000-0000-0000-000000000000" },
    { enabled: Boolean(deployment), retry: false },
  );
  const historyQuery = trpc.deployments.rollbackHistory.useQuery({ deploymentId: id }, { enabled: tab === "rollback-history", retry: false });

  const rollback = trpc.deployments.rollback.useMutation({
    onSuccess: result => { result.configured ? toast.success("Rollback completed") : toast.info(result.reason); void query.refetch(); void historyQuery.refetch(); },
    onError: error => toast.error(error.message),
  });
  const protection = trpc.deployments.protection.set.useMutation({
    onSuccess: () => { void protectionQuery.refetch(); toast.success("Deployment protection saved"); },
    onError: error => toast.error(error.message),
  });

  if (query.isLoading) return <><PageHeader title="Deployment" crumb="Workspace / Deployments" /><LoadingBlock rows={4} /></>;
  if (query.error || !deployment) return <><PageHeader title="Deployment" crumb="Workspace / Deployments" /><Card><EmptyState title="Deployment unavailable" body={query.error?.message ?? "The deployment could not be found in an organization you can access."} /></Card></>;

  const logs = query.data?.logs ?? [];
  const protectionState = protectionQuery.data ?? { enabled: false, require_authentication: true, preview_access: "public" as const };
  const navigateTab = (next: DeploymentTab) => onNavigate?.(`/dashboard/deployments/${id}/${next}`);

  return <>
    <PageHeader
      title="Deployment detail"
      crumb={`Workspace / Deployments / ${deployment.environment} / ${deployment.commit_sha?.slice(0, 8) ?? id.slice(0, 8)}`}
      action={<Button onClick={() => onNavigate?.("/dashboard/deployments/all")}><ArrowLeft size={14} /> Back to deployments</Button>}
    />
    <Tabs items={(["summary", "build-logs", "source", "rollback-history"] as DeploymentTab[]).map(value => ({ label: value.replaceAll("-", " ").replace(/\b\w/g, character => character.toUpperCase()), value }))} active={tab} onChange={value => navigateTab(value as DeploymentTab)} />

    {tab === "summary" ? <>
      <div className="ds-grid-3" style={{ marginBottom: 16 }}>
        <Stat label="Status" value={<StatusBadge tone={toneForStatus(deployment.status)}>{deployment.status}</StatusBadge>} />
        <Stat label="Environment" value={deployment.environment} />
        <Stat label="Created" value={formatDate(deployment.created_at, true)} />
      </div>
      <Card style={{ marginBottom: 16 }}>
        <CardHead eyebrow="Deployment protection" title="Preview access boundary" action={<StatusBadge tone={protectionState.enabled ? "ready" : "neutral"}>{protectionState.enabled ? "Enabled" : "Not configured"}</StatusBadge>} />
        <CardBody>
          <p style={{ color: "var(--ds-fg-muted)", fontSize: 12.5, lineHeight: 1.6 }}>Protection settings are persisted per project. Enforcement stays honest until the hosting provider is connected.</p>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <Button disabled={protection.isPending} onClick={() => protection.mutate({ organizationId: deployment.organization_id, projectId: deployment.project_id, enabled: !protectionState.enabled, requireAuthentication: protectionState.require_authentication, previewAccess: protectionState.preview_access as "public" | "team" | "private" })}>
              <LockKeyhole size={14} /> {protectionState.enabled ? "Disable protection" : "Enable protection"}
            </Button>
            <Button disabled={rollback.isPending || deployment.status !== "ready"} onClick={() => rollback.mutate({ id })}><RotateCcw size={14} /> {rollback.isPending ? "Rolling back…" : "Rollback"}</Button>
            {deployment.deployment_url ? <Button onClick={() => window.open(deployment.deployment_url, "_blank", "noopener,noreferrer")}>Visit deployment</Button> : null}
          </div>
        </CardBody>
      </Card>
      <DeploymentEnvVars organizationId={deployment.organization_id} projectId={deployment.project_id} environment={deployment.environment as Environment} />
      <DeploymentDomainBinding organizationId={deployment.organization_id} projectId={deployment.project_id} environment={deployment.environment as Environment} />
    </> : null}

    {tab === "build-logs" ? <Card>
      <CardHead eyebrow="Append-only" title="Build and runtime logs" description="Logs are organization-scoped and stream while the deployment builds." action={<StatusBadge tone={toneForStatus(deployment.status)}>{deployment.status}</StatusBadge>} />
      {logs.length ? <div className="ds-log">{logs.map((log: { id: string; level?: string; source?: string; message?: string; created_at?: string }) => (
        <div className="ds-log-row" key={log.id}><time>{formatDate(log.created_at, true)}</time><span className={`ds-log-level ${log.level === "error" ? "is-error" : log.level === "warn" ? "is-warn" : "is-info"}`}>{log.level}</span><span>{log.message}</span></div>
      ))}</div> : <EmptyState title="No build logs" body="The connected hosting adapter has not emitted logs for this deployment." />}
    </Card> : null}

    {tab === "source" ? <Card>
      <CardHead eyebrow="Source" title="Repository and commit" />
      <div className="ds-list">
        <div className="ds-row"><span className="ds-row-icon"><GitBranch size={15} /></span><span className="ds-row-main"><strong>{deployment.source_branch || "Branch not configured"}</strong><small>{deployment.source_repository || "Repository not configured"}</small></span></div>
        <div className="ds-row"><span className="ds-row-main"><strong>Commit</strong><small className="ds-mono">{deployment.commit_sha || "Commit not configured"}</small></span></div>
        <div className="ds-row"><span className="ds-row-main"><strong>Provider reference</strong><small className="ds-mono">{deployment.provider_ref || "Not assigned"}</small></span></div>
      </div>
      <CardBody><EmptyState title="Source provider actions are gated" body="Repository connection and redeploy actions stay disabled until a Git provider is connected." /></CardBody>
    </Card> : null}

    {tab === "rollback-history" ? <Card>
      <CardHead eyebrow="History" title="Rollback attempts" />
      {historyQuery.isLoading ? <LoadingBlock rows={3} /> : historyQuery.data?.length ? <div className="ds-list">{historyQuery.data.map((entry: { id: string; result?: string; adapter_name?: string; reason?: string; created_at?: string }) => (
        <div className="ds-row" key={entry.id}><span className="ds-row-icon"><RotateCcw size={15} /></span><span className="ds-row-main"><strong>{entry.result}</strong><small>{entry.adapter_name} · {formatDate(entry.created_at, true)}</small><small>{entry.reason || "No diff returned"}</small></span><StatusBadge tone={toneForStatus(entry.result)}>{entry.result}</StatusBadge></div>
      ))}</div> : <EmptyState title="No rollback history" body="Rollback attempts appear here with the adapter result and status diff." />}
    </Card> : null}
  </>;
}

function DeploymentEnvVars({ organizationId, projectId, environment }: { organizationId: string; projectId: string; environment: Environment }) {
  const query = trpc.deployments.envVars.list.useQuery({ organizationId, projectId, environment }, { retry: false });
  const [name, setName] = useState("");
  const [valueRef, setValueRef] = useState("");
  const save = trpc.deployments.envVars.upsert.useMutation({ onSuccess: () => { void query.refetch(); setName(""); setValueRef(""); toast.success("Environment variable saved"); }, onError: error => toast.error(error.message) });
  const remove = trpc.deployments.envVars.remove.useMutation({ onSuccess: () => { void query.refetch(); toast.success("Environment variable removed"); }, onError: error => toast.error(error.message) });
  return <Card style={{ marginBottom: 16 }}>
    <CardHead eyebrow={`${environment} environment`} title="Environment variables" description="Secret values are never returned to the browser. Only a masked value and provider reference are stored." />
    <CardBody>
      <div className="ds-form-grid">
        <Field label="Name"><Input value={name} onChange={event => setName(event.target.value.toUpperCase())} placeholder="DATABASE_URL" /></Field>
        <Field label="Provider reference"><Input value={valueRef} onChange={event => setValueRef(event.target.value)} placeholder="secret://provider/ref" /></Field>
      </div>
      <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!name || !valueRef || save.isPending} onClick={() => save.mutate({ organizationId, projectId, environment, name, valueRef, isSecret: true })}>Save variable</Button></div>
    </CardBody>
    {query.data?.length ? <div className="ds-list">{query.data.map((variable: { id: string; name: string; masked_value?: string }) => (
      <div className="ds-row" key={variable.id}><span className="ds-row-main"><strong className="ds-mono">{variable.name}</strong><small className="ds-mono">{variable.masked_value}</small></span><Button variant="danger" size="sm" onClick={() => remove.mutate({ id: variable.id })}><Trash2 size={13} /> Remove</Button></div>
    ))}</div> : null}
  </Card>;
}

function DeploymentDomainBinding({ organizationId, projectId, environment }: { organizationId: string; projectId: string; environment: Environment }) {
  const domains = trpc.domains.list.useQuery({ organizationId, projectId }, { retry: false });
  const bindings = trpc.deployments.domainBindings.list.useQuery({ organizationId, projectId }, { retry: false });
  const [domainId, setDomainId] = useState("");
  const bind = trpc.deployments.domainBindings.bind.useMutation({ onSuccess: result => { void bindings.refetch(); toast.info(result.error_message ?? "Domain binding saved"); }, onError: error => toast.error(error.message) });
  return <Card>
    <CardHead eyebrow="Custom domain" title={`Bind a domain to ${environment}`} description="Binding intent is persisted, but live routing stays not configured until a hosting and domain adapter are connected." />
    <CardBody>
      <div className="ds-form-grid">
        <Field label="Domain"><Select value={domainId} onChange={event => setDomainId(event.target.value)}><option value="">Select a domain</option>{(domains.data ?? []).map((domain: { id: string; hostname: string }) => <option key={domain.id} value={domain.id}>{domain.hostname}</option>)}</Select></Field>
      </div>
      <div style={{ marginTop: 14 }}><Button disabled={!domainId || bind.isPending} onClick={() => bind.mutate({ organizationId, projectId, domainId, environment })}><TerminalSquare size={14} /> Bind domain</Button></div>
    </CardBody>
    {bindings.data?.length ? <div className="ds-list">{bindings.data.map((binding: DomainBindingRow) => <DomainBindingItem key={binding.id} binding={binding} />)}</div> : null}
  </Card>;
}

type DomainBindingRow = { id: string; environment?: string; status?: string; error_message?: string; domains?: Array<{ hostname?: string }> | { hostname?: string } };

function DomainBindingItem({ binding }: { binding: DomainBindingRow }) {
  const related = Array.isArray(binding.domains) ? binding.domains[0] : binding.domains;
  return <div className="ds-row"><span className="ds-row-main"><strong>{related?.hostname ?? "Domain binding"}</strong><small>{binding.environment} · {binding.error_message ?? "Provider reference not assigned"}</small></span><StatusBadge tone={toneForStatus(binding.status)}>{binding.status}</StatusBadge></div>;
}
