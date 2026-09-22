import { useState } from "react";
import { GitBranch, KeyRound, Link2, Plus, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardBody, CardHead, EmptyState, ErrorState, Field, Input, LoadingBlock, PageHeader, Select, StatusBadge, Tabs } from "@/components/ui-kit";
import { formatDate, toneForStatus, useOrganizationId } from "./shared";

type DeveloperTab = "git-connections" | "repositories" | "webhooks" | "api-keys";
const tabs: DeveloperTab[] = ["git-connections", "repositories", "webhooks", "api-keys"];

export default function Developer({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as DeveloperTab) ? routeParts![1] as DeveloperTab : "git-connections";
  const { organizationId, organization } = useOrganizationId();

  const connections = trpc.developer.connections.useQuery(undefined, { enabled: Boolean(organizationId), retry: false });
  const repositories = trpc.developer.repositories.useQuery(undefined, { enabled: Boolean(organizationId), retry: false });
  const apiKeys = trpc.account.apiKeys.list.useQuery(undefined, { enabled: tab === "api-keys", retry: false });

  return <>
    <PageHeader
      title="Developer"
      crumb="Workspace / Developer"
      description={organization?.name ? `Git connections, repositories, webhooks and API keys for ${organization.name}.` : "Git connections, repositories, webhooks and API keys."}
    />
    <Tabs items={tabs.map(value => ({ label: value.replaceAll("-", " ").replace(/\b\w/g, character => character.toUpperCase()), value }))} active={tab} onChange={value => onNavigate?.(`/dashboard/developer/${value}`)} />

    {tab === "git-connections" ? <ConnectionsPanel organizationId={organizationId} query={connections} /> : null}
    {tab === "repositories" ? <RepositoriesPanel organizationId={organizationId} connections={connections.data ?? []} query={repositories} /> : null}
    {tab === "webhooks" ? <WebhooksPanel query={repositories} /> : null}
    {tab === "api-keys" ? <ApiKeysPanel query={apiKeys} /> : null}
  </>;
}

function ConnectionsPanel({ organizationId, query }: { organizationId?: string; query: { data?: Array<Record<string, unknown>>; isLoading: boolean; error?: { message: string } | null; refetch: () => unknown } }) {
  const [provider, setProvider] = useState<"github" | "gitlab" | "bitbucket">("github");
  const [accountRef, setAccountRef] = useState("");
  const connect = trpc.developer.connect.useMutation({
    onSuccess: () => { void query.refetch(); toast.info("Connection intent saved. OAuth adapter is not configured yet."); },
    onError: error => toast.error(error.message),
  });
  return <>
    <Card style={{ marginBottom: 16 }}>
      <CardHead eyebrow="OAuth" title="Connect a Git provider" description="Connection intent is persisted and audited. Live OAuth stays not configured until the provider adapter is supplied." />
      <CardBody>
        <div className="ds-form-grid">
          <Field label="Provider"><Select value={provider} onChange={event => setProvider(event.target.value as typeof provider)}><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="bitbucket">Bitbucket</option></Select></Field>
          <Field label="Account reference"><Input value={accountRef} onChange={event => setAccountRef(event.target.value)} placeholder="wasimmostakim2965-ui" /></Field>
        </div>
        <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!organizationId || connect.isPending} onClick={() => organizationId && connect.mutate({ organizationId, provider, accountRef: accountRef || null })}><Link2 size={14} /> Save connection</Button></div>
      </CardBody>
    </Card>
    <Card>
      <CardHead eyebrow="Connections" title="Connected providers" />
      {query.isLoading ? <LoadingBlock rows={3} /> : query.error ? <ErrorState message={query.error.message} /> : query.data?.length ? (
        <div className="ds-list">{query.data.map(connection => (
          <div className="ds-row" key={String(connection.id)}>
            <span className="ds-row-icon"><GitBranch size={15} /></span>
            <span className="ds-row-main"><strong>{String(connection.provider)}</strong><small>{String(connection.account_ref ?? "Account reference not set")} · {String(connection.error_message ?? "OAuth adapter not configured")}</small></span>
            <StatusBadge tone={toneForStatus(String(connection.status))}>{String(connection.status)}</StatusBadge>
          </div>
        ))}</div>
      ) : <EmptyState title="No connections yet" body="Connect GitHub, GitLab or Bitbucket to link repositories to projects." />}
    </Card>
  </>;
}

function RepositoriesPanel({ organizationId, connections, query }: { organizationId?: string; connections: Array<Record<string, unknown>>; query: { data?: Array<Record<string, unknown>>; isLoading: boolean; error?: { message: string } | null; refetch: () => unknown } }) {
  const [connectionId, setConnectionId] = useState("");
  const [fullName, setFullName] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const add = trpc.developer.addRepository.useMutation({ onSuccess: () => { void query.refetch(); setFullName(""); toast.success("Repository linked"); }, onError: error => toast.error(error.message) });
  return <>
    <Card style={{ marginBottom: 16 }}>
      <CardHead eyebrow="Repository" title="Link a repository" description="Repositories inherit the branch default and produce webhook status once the provider is connected." />
      <CardBody>
        <div className="ds-form-grid">
          <Field label="Connection"><Select value={connectionId} onChange={event => setConnectionId(event.target.value)}><option value="">Select a connection</option>{connections.map(connection => <option key={String(connection.id)} value={String(connection.id)}>{String(connection.provider)} · {String(connection.account_ref ?? "account")}</option>)}</Select></Field>
          <Field label="Repository"><Input value={fullName} onChange={event => setFullName(event.target.value)} placeholder="owner/repo" /></Field>
          <Field label="Default branch"><Input value={defaultBranch} onChange={event => setDefaultBranch(event.target.value)} placeholder="main" /></Field>
        </div>
        <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!organizationId || !connectionId || !fullName || add.isPending} onClick={() => organizationId && add.mutate({ organizationId, connectionId, fullName, defaultBranch })}><Plus size={14} /> Link repository</Button></div>
      </CardBody>
    </Card>
    <Card>
      <CardHead eyebrow="Repositories" title="Linked repositories" />
      {query.isLoading ? <LoadingBlock rows={3} /> : query.error ? <ErrorState message={query.error.message} /> : query.data?.length ? (
        <div className="ds-list">{query.data.map(repository => (
          <div className="ds-row" key={String(repository.id)}>
            <span className="ds-row-icon"><GitBranch size={15} /></span>
            <span className="ds-row-main"><strong>{String(repository.full_name)}</strong><small>{String(repository.default_branch)} · webhook {String(repository.webhook_status ?? "not configured")}</small></span>
            <StatusBadge tone={toneForStatus(String(repository.webhook_status))}>{String(repository.webhook_status ?? "unknown")}</StatusBadge>
          </div>
        ))}</div>
      ) : <EmptyState title="No repositories linked" body="Link a repository to enable source deployments and preview builds." />}
    </Card>
  </>;
}

function WebhooksPanel({ query }: { query: { data?: Array<Record<string, unknown>>; isLoading: boolean; error?: { message: string } | null; refetch: () => unknown } }) {
  const configure = trpc.developer.webhook.useMutation({ onSuccess: result => { void query.refetch(); toast.info(result.reason); }, onError: error => toast.error(error.message) });
  return <Card>
    <CardHead eyebrow="Delivery" title="Webhooks" description="Webhook registration is delegated to the Git provider once OAuth is configured." />
    {query.isLoading ? <LoadingBlock rows={3} /> : query.error ? <ErrorState message={query.error.message} /> : query.data?.length ? (
      <div className="ds-list">{query.data.map(repository => (
        <div className="ds-row" key={String(repository.id)}>
          <span className="ds-row-icon"><Webhook size={15} /></span>
          <span className="ds-row-main"><strong>{String(repository.full_name)}</strong><small>{String(repository.webhook_ref ?? "No webhook reference assigned")}</small></span>
          <StatusBadge tone={toneForStatus(String(repository.webhook_status))}>{String(repository.webhook_status ?? "unknown")}</StatusBadge>
          <Button size="sm" disabled={configure.isPending} onClick={() => configure.mutate({ id: String(repository.id) })}>Configure</Button>
        </div>
      ))}</div>
    ) : <EmptyState title="No repositories for webhooks" body="Link a repository before configuring a webhook." />}
  </Card>;
}

function ApiKeysPanel({ query }: { query: { data?: Array<Record<string, unknown>>; isLoading: boolean; error?: { message: string } | null; refetch: () => unknown } }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const create = trpc.account.apiKeys.create.useMutation({
    onSuccess: result => { void query.refetch(); setName(""); setCreated(result.key); toast.success("API key created"); },
    onError: error => toast.error(error.message),
  });
  const revoke = trpc.account.apiKeys.revoke.useMutation({ onSuccess: () => { void query.refetch(); toast.success("API key revoked"); }, onError: error => toast.error(error.message) });
  return <>
    <Card style={{ marginBottom: 16 }}>
      <CardHead eyebrow="Credentials" title="Create an API key" description="Keys are shown once. Only a hash and prefix are stored server-side." />
      <CardBody>
        <div className="ds-form-grid">
          <Field label="Key name"><Input value={name} onChange={event => setName(event.target.value)} placeholder="ci-deploy" /></Field>
        </div>
        <div style={{ marginTop: 14 }}><Button variant="primary" disabled={!name || create.isPending} onClick={() => create.mutate({ name })}><KeyRound size={14} /> Create key</Button></div>
        {created ? <div className="ds-callout" style={{ marginTop: 14 }}><div style={{ minWidth: 0 }}><strong>Copy this key now</strong><p className="ds-mono" style={{ wordBreak: "break-all" }}>{created}</p></div></div> : null}
      </CardBody>
    </Card>
    <Card>
      <CardHead eyebrow="Keys" title="Active API keys" />
      {query.isLoading ? <LoadingBlock rows={3} /> : query.error ? <ErrorState message={query.error.message} /> : query.data?.length ? (
        <div className="ds-list">{query.data.map(key => (
          <div className="ds-row" key={String(key.id)}>
            <span className="ds-row-icon"><KeyRound size={15} /></span>
            <span className="ds-row-main"><strong>{String(key.name)}</strong><small className="ds-mono">{String(key.key_prefix)}••• · last used {formatDate(key.last_used_at as string | null, true)}</small></span>
            {key.revoked_at ? <StatusBadge tone="error">Revoked</StatusBadge> : <Button variant="danger" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: String(key.id) })}><Trash2 size={13} /> Revoke</Button>}
          </div>
        ))}</div>
      ) : <EmptyState title="No API keys" body="Create a key to authenticate CLI and automation requests." />}
    </Card>
  </>;
}
