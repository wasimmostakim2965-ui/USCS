import { useMemo } from "react";
import { ArrowUpRight, GitBranch, Globe2, Rocket, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Callout, Card, CardBody, CardHead, Checklist, EmptyState, ErrorState, LoadingBlock, PageHeader, Section, Stat, StatusBadge } from "@/components/ui-kit";
import { toneForStatus } from "./shared";

type RouteProps = { routeParts?: string[]; onProjects: () => void; onOpenProject: (id?: string) => void };

export default function Overview({ routeParts, onProjects, onOpenProject }: RouteProps) {
  const tab = routeParts?.[1] ?? "activity";
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const projects = trpc.workspace.projects.list.useQuery(undefined, { retry: false });
  const organizationId = organizations.data?.[0]?.id;
  const deployments = trpc.deployments.list.useQuery(organizationId ? { organizationId } : undefined, { enabled: Boolean(organizationId), retry: false });

  const rollback = trpc.deployments.rollback.useMutation({
    onSuccess: result => { toast[result.configured ? "success" : "warning"](result.configured ? "Rollback completed" : result.reason); void deployments.refetch(); },
    onError: error => toast.error(error.message),
  });

  const production = useMemo(() => (deployments.data ?? []).find((item: { environment?: string }) => item.environment === "production"), [deployments.data]);
  const list = deployments.data ?? [];
  const checklist = [
    { label: "Connect a Git provider", complete: false, detail: "Connect GitHub, GitLab or Bitbucket from Developer to enable source deployments." },
    { label: "Add a custom domain", complete: false, detail: "No domain adapter is configured yet, so DNS stays honest." },
    { label: "Create a preview deployment", complete: list.some((item: { environment?: string }) => item.environment === "preview"), detail: "A real preview deployment record is required." },
    { label: "Enable observability", complete: list.length > 0, detail: "Logs, metrics and alerts light up once events are ingested." },
  ];

  if (organizations.isLoading || projects.isLoading || deployments.isLoading) return <><PageHeader title="Overview" /><LoadingBlock rows={5} /></>;
  if (organizations.error || projects.error || deployments.error) return <><PageHeader title="Overview" /><ErrorState message={(organizations.error ?? projects.error ?? deployments.error)?.message ?? "Workspace data unavailable"} /></>;

  return <>
    <PageHeader
      title="Overview"
      crumb="Workspace / Overview"
      description="A single view of what is deployed, what is protected, and what still needs a provider."
      action={<Button variant="primary" onClick={onProjects}><Rocket size={14} /> Open projects</Button>}
    />

    <div className="ds-split">
      <Card>
        <CardHead
          eyebrow="Production deployment"
          title={production?.source_repository || "No production deployment"}
          description={production ? "Latest production deployment from this workspace." : "Create a deployment through the real deployment flow. No placeholder deployment is shown."}
          action={<StatusBadge tone={production ? toneForStatus(production.status) : "neutral"}>{production?.status ?? "Not configured"}</StatusBadge>}
        />
        <CardBody>
          <div className="ds-preview">
            {production
              ? <div><Rocket size={26} /><strong>{production.deployment_url || "Deployment URL not assigned"}</strong><small>{production.commit_sha || "Commit not assigned"}</small></div>
              : <div><Sparkles size={24} /><strong>Preview unavailable</strong><small>A hosting adapter is required for a live preview.</small></div>}
          </div>
          <div className="ds-meta-grid" style={{ marginTop: 20 }}>
            <div className="ds-meta"><small>Deployment URL</small><strong>{production?.deployment_url || "Not configured"}</strong></div>
            <div className="ds-meta"><small>Branch</small><strong>{production?.source_branch || "Not configured"}</strong></div>
            <div className="ds-meta"><small>Commit</small><strong>{production?.commit_sha?.slice(0, 12) || "Not configured"}</strong></div>
            <div className="ds-meta"><small>Created</small><strong>{production?.created_at ? new Date(production.created_at).toLocaleString() : "—"}</strong></div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <Button disabled={!production || production.status !== "ready" || rollback.isPending} onClick={() => production && rollback.mutate({ id: production.id })}><RotateCcw size={14} /> {rollback.isPending ? "Rolling back…" : "Rollback"}</Button>
            <Button disabled={!production?.deployment_url} onClick={() => production?.deployment_url && window.open(production.deployment_url, "_blank", "noopener,noreferrer")}><ArrowUpRight size={14} /> Visit</Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHead eyebrow="Checklist" title="Complete your workspace" description="Every item reflects real control-plane state." />
        <Checklist items={checklist} />
      </Card>
    </div>

    {tab === "production" ? (
      <>
        <Section title="Production" description="Deployments currently serving production traffic." />
        <Card>{list.filter((item: { environment?: string }) => item.environment === "production").length
          ? list.filter((item: { environment?: string }) => item.environment === "production").map((item: { id: string; status?: string; source_repository?: string; created_at?: string }) => <div className="ds-row" key={item.id}><span className="ds-row-icon"><Rocket size={15} /></span><span className="ds-row-main"><strong>{item.source_repository || item.id.slice(0, 8)}</strong><small>{item.created_at ? new Date(item.created_at).toLocaleString() : "—"}</small></span><StatusBadge tone={toneForStatus(item.status)}>{item.status}</StatusBadge></div>)
          : <EmptyState title="No production deployments" body="Production deployments appear here once a hosting adapter accepts a deployment." />}</Card>
      </>
    ) : tab === "checklist" ? (
      <>
        <Section title="Checklist" description="The same list, expanded with provider context." />
        <Card><Checklist items={checklist} /></Card>
      </>
    ) : (
      <>
        <Section title="Activity" description="Recent control-plane records across the workspace." />
        <div className="ds-grid-3" style={{ marginBottom: 16 }}>
          <Stat label="Projects" value={projects.data?.length ?? 0} />
          <Stat label="Deployments" value={list.length} />
          <Stat label="Ready" value={list.filter((item: { status?: string }) => item.status === "ready").length} />
        </div>
        <Card>{list.length
          ? list.slice(0, 8).map((item: { id: string; status?: string; environment?: string; source_repository?: string; created_at?: string }) => <div className="ds-row" key={item.id}><span className="ds-row-icon"><Rocket size={15} /></span><span className="ds-row-main"><strong>{item.source_repository || item.id.slice(0, 8)}</strong><small>{item.environment} · {item.created_at ? new Date(item.created_at).toLocaleString() : "—"}</small></span><StatusBadge tone={toneForStatus(item.status)}>{item.status}</StatusBadge></div>)
          : <EmptyState title="No activity yet" body="Deployments, domains and security events will appear here as the control plane records them." action={<Button variant="primary" onClick={onProjects}>Open projects</Button>} />}</Card>
      </>
    )}

    <div className="ds-split" style={{ marginTop: 16 }}>
      <Card>
        <CardHead eyebrow="Observability" title="Runtime signals" action={<StatusBadge>Not configured</StatusBadge>} />
        <CardBody>
          <div className="ds-grid-3">
            <Stat label="Edge requests" value="—" />
            <Stat label="Invocations" value="—" />
            <Stat label="Error rate" value="—" />
          </div>
          <div style={{ marginTop: 16 }}><EmptyState title="No telemetry yet" body="Real edge and function metrics appear when an observability adapter emits them." /></div>
        </CardBody>
      </Card>
      <Card>
        <CardHead eyebrow="Security" title="Protection posture" action={<StatusBadge>Evidence required</StatusBadge>} />
        <CardBody>
          <Callout icon={<ShieldCheck size={18} />} title="Nothing is called protected without proof" body="Configure a security level to generate an enforcement policy preview. Edge enforcement stays off until a real edge adapter is connected." />
        </CardBody>
      </Card>
    </div>

    <Section title="Projects in this workspace" description="Open a project to inspect deployments, domains, data and security." action={<Button variant="ghost" onClick={onProjects}>View all <ArrowUpRight size={14} /></Button>} />
    {projects.data?.length ? (
      <div className="ds-project-grid">
        {projects.data.map((project: { id: string; name: string; slug: string; updated_at: string }) => (
          <button className="ds-project-card" key={project.id} onClick={() => onOpenProject(project.id)}>
            <div className="ds-project-top"><span className="ds-project-mark">{project.name.slice(0, 1).toUpperCase()}</span><Globe2 size={15} color="var(--ds-fg-subtle)" /></div>
            <div><h3>{project.name}</h3><small>{project.slug}</small></div>
            <div className="ds-project-meta">
              <span><GitBranch size={12} /> Repository not configured</span>
              <span>Updated {new Date(project.updated_at).toLocaleDateString()}</span>
            </div>
          </button>
        ))}
      </div>
    ) : <Card><EmptyState title="No projects yet" body="Create a project to connect repositories, domains, deployments and runtime resources." action={<Button variant="primary" onClick={onProjects}>Open projects</Button>} /></Card>}
  </>;
}
