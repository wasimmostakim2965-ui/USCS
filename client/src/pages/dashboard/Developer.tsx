import { useState } from "react";
import { BookOpen, GitBranch, KeyRound, Link2, Plus, Webhook } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ComingSoon, Empty, Header, Status } from "./shared";

type DeveloperTab = "connections" | "repositories" | "api-docs";
const tabs: DeveloperTab[] = ["connections", "repositories", "api-docs"];

export default function Developer({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as DeveloperTab) ? routeParts?.[1] as DeveloperTab : "connections";
  const connections = trpc.developer.connections.useQuery(undefined, { retry: false });
  const repositories = trpc.developer.repositories.useQuery(undefined, { retry: false });
  const go = (next: DeveloperTab) => onNavigate?.(`/dashboard/developer/${next}`);
  return <><Header title="Developer" /><div className="vc-subtabs">{tabs.map(value => <button key={value} className={tab === value ? "active" : ""} onClick={() => go(value)}>{value.replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase())}</button>)}</div>{tab === "connections" ? <ConnectionPanel data={connections.data ?? []} organizationId={connections.data?.[0]?.organization_id} onRefresh={() => void connections.refetch()} /> : tab === "repositories" ? <RepositoryPanel connections={connections.data ?? []} data={repositories.data ?? []} organizationId={connections.data?.[0]?.organization_id} onRefresh={() => void repositories.refetch()} /> : <ApiDocs />}</>;
}

function ConnectionPanel({ data, organizationId, onRefresh }: { data: Array<{ id: string; organization_id: string; provider: string; status: string; account_ref?: string | null; error_message?: string | null }>; organizationId?: string; onRefresh: () => void }) {
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const orgId = organizationId ?? organizations.data?.[0]?.id;
  const [provider, setProvider] = useState<"github" | "gitlab" | "bitbucket">("github");
  const [accountRef, setAccountRef] = useState("");
  const connect = trpc.developer.connect.useMutation({ onSuccess: () => { toast.info("Connection intent saved"); setAccountRef(""); onRefresh(); }, onError: error => toast.error(error.message) });
  return <><div className="vc-card vc-settings-editor"><span className="vc-eyebrow">Source control</span><h3>Connect Git provider</h3><p>OAuth credentials are not fabricated. This saves a provider connection intent and remains not configured until the provider adapter is enabled.</p><div className="vc-form-grid"><label>Provider<select value={provider} onChange={event => setProvider(event.target.value as typeof provider)}><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="bitbucket">Bitbucket</option></select></label><label>Account reference<input value={accountRef} onChange={event => setAccountRef(event.target.value)} placeholder="org or account slug" /></label></div><button className="vc-btn primary" disabled={!orgId || connect.isPending} onClick={() => orgId && connect.mutate({ organizationId: orgId, provider, accountRef: accountRef || null })}><Link2 size={14} /> Save connection</button></div><div className="vc-card">{data.length ? data.map(connection => <div className="vc-list-row" key={connection.id}><GitBranch size={16} /><span><strong>{connection.provider}</strong><small>{connection.account_ref || connection.error_message || "Account not configured"}</small></span><Status good={connection.status === "connected"}>{connection.status}</Status></div>) : <Empty title="No source connections" body="Connect a Git provider to make repository selection and deployment triggers available." />}</div></>;
}

function RepositoryPanel({ connections, data, organizationId, onRefresh }: { connections: Array<{ id: string; provider: string }>; data: Array<{ id: string; full_name: string; default_branch: string; webhook_status: string }>; organizationId?: string; onRefresh: () => void }) {
  const [connectionId, setConnectionId] = useState("");
  const [fullName, setFullName] = useState("");
  const [branch, setBranch] = useState("main");
  const add = trpc.developer.addRepository.useMutation({ onSuccess: () => { toast.info("Repository intent saved"); setFullName(""); onRefresh(); }, onError: error => toast.error(error.message) });
  const webhook = trpc.developer.webhook.useMutation({ onSuccess: result => toast.info(result.reason), onError: error => toast.error(error.message) });
  return <><div className="vc-card vc-settings-editor"><span className="vc-eyebrow">Repositories</span><h3>Add repository</h3><div className="vc-form-grid"><label>Connection<select value={connectionId} onChange={event => setConnectionId(event.target.value)}><option value="">Select connection</option>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.provider}</option>)}</select></label><label>Repository<input value={fullName} onChange={event => setFullName(event.target.value)} placeholder="org/repository" /></label><label>Default branch<input value={branch} onChange={event => setBranch(event.target.value)} /></label></div><button className="vc-btn primary" disabled={!organizationId || !connectionId || !fullName || add.isPending} onClick={() => organizationId && add.mutate({ organizationId, connectionId, fullName, defaultBranch: branch })}><Plus size={14} /> Add repository</button></div><div className="vc-card">{data.length ? data.map(repository => <div className="vc-list-row" key={repository.id}><GitBranch size={16} /><span><strong>{repository.full_name}</strong><small>Branch: {repository.default_branch}</small></span><Status>{repository.webhook_status}</Status><button className="vc-btn" onClick={() => webhook.mutate({ id: repository.id })}><Webhook size={14} /> Webhook</button></div>) : <Empty title="No repositories" body="Add a repository after saving a provider connection." />}</div></>;
}

function ApiDocs() {
  return <div className="vc-card"><span className="vc-eyebrow">API & CLI</span><h3>Developer API contracts</h3><p>All control-plane mutations are exposed through authenticated tRPC procedures. API keys are managed in the account area and secret values are shown only once at creation.</p><div className="vc-list-row"><BookOpen size={16} /><span><strong>Deployments</strong><small>deployments.list · deployments.create · deployments.rollback</small></span><Status>Documented</Status></div><div className="vc-list-row"><KeyRound size={16} /><span><strong>API keys</strong><small>account.apiKeys.list · account.apiKeys.create · account.apiKeys.revoke</small></span><Status>Available</Status></div><ComingSoon title="OpenAPI export" body="A generated OpenAPI document will be enabled when the external API gateway contract is provisioned." /></div>;
}
