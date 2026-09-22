import { useMemo } from "react";
import { ArrowUpRight, GitBranch, Globe2, RotateCcw, Rocket, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, Checklist, EmptyState, ErrorState, LoadingSkeleton, PageHeader, StatusBadge } from "@/components/ui-kit";

export default function Overview({ routeParts, onProjects, onOpenProject }: { routeParts?: string[]; onProjects: () => void; onOpenProject: (id?: string) => void }) {
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const projects = trpc.workspace.projects.list.useQuery(undefined, { retry: false });
  const organizationId = organizations.data?.[0]?.id;
  const deployments = trpc.deployments.list.useQuery(organizationId ? { organizationId } : undefined, { enabled: Boolean(organizationId), retry: false });
  const rollback = trpc.deployments.rollback.useMutation({ onSuccess: result => { toast[result.configured ? "success" : "warning"](result.configured ? "Rollback completed" : result.reason); void deployments.refetch(); }, onError: error => toast.error(error.message) });
  const production = useMemo(() => (deployments.data ?? []).find(item => item.environment === "production"), [deployments.data]);
  const projectCount = projects.data?.length ?? 0;
  const checklist = [
    { label: "Connect Git Repository", complete: false, detail: "Connect a provider from Connect to enable source deployments." },
    { label: "Add Custom Domain", complete: false, detail: "No configured domain adapter is assumed." },
    { label: "Preview Deployment", complete: Boolean((deployments.data ?? []).some(item => item.environment === "preview")), detail: "A real preview deployment is required." },
    { label: "Enable Analytics", complete: false, detail: "Analytics remains gated until a telemetry source is configured." },
    { label: "Upgrade", complete: false, detail: "Billing is not configured; no purchase is implied." },
  ];
  if (organizations.isLoading || projects.isLoading || deployments.isLoading) return <><PageHeader title="Overview" /><LoadingSkeleton rows={5} /></>;
  if (organizations.error || projects.error || deployments.error) return <ErrorState message={(organizations.error ?? projects.error ?? deployments.error)?.message ?? "Workspace data unavailable"} />;
  return <>
    <PageHeader title="Overview" breadcrumb="Workspace / Overview" action={<Button variant="primary" onClick={onProjects}><Rocket size={14} /> Open Projects</Button>} />
    <div className="overview-grid">
      <Card className="overview-production"><div className="overview-card-head"><div><span className="ui-eyebrow">Production Deployment</span><h2>{production?.source_repository || "No production deployment"}</h2><p>{production ? "Latest production deployment from the live workspace." : "Create a deployment through the real deployment flow; no placeholder deployment is shown."}</p></div><StatusBadge status={production?.status === "ready" ? "ready" : production ? "building" : "neutral"}>{production?.status ?? "Not configured"}</StatusBadge></div><div className="overview-preview">{production ? <div><Rocket size={26} /><strong>{production.deployment_url || "Deployment URL not assigned"}</strong><small>{production.commit_sha || "Commit not assigned"}</small></div> : <div><Sparkles size={24} /><strong>Preview unavailable</strong><small>A hosting adapter is required for a live preview.</small></div>}</div><div className="overview-meta"><div><small>Deployment URL</small><strong>{production?.deployment_url || "Not configured"}</strong></div><div><small>Created</small><strong>{production?.created_at ? new Date(production.created_at).toLocaleString() : "—"}</strong></div><div><small>Branch</small><strong>{production?.source_branch || "Not configured"}</strong></div><div><small>Commit</small><strong>{production?.commit_sha || "Not configured"}</strong></div></div><div className="overview-actions"><Button variant="secondary" disabled={!production || production.status !== "ready" || rollback.isPending} onClick={() => production && rollback.mutate({ id: production.id })}><RotateCcw size={14} /> Rollback</Button><Button variant="secondary" disabled={!production?.deployment_url} onClick={() => production?.deployment_url && window.open(production.deployment_url, "_blank", "noopener,noreferrer")}><ArrowUpRight size={14} /> Visit</Button></div></Card>
      <Card><div className="ui-card-heading"><div><span className="ui-eyebrow">Production Checklist</span><h2>Complete your workspace</h2></div></div><Checklist items={checklist} /></Card>
    </div>
    <div className="overview-grid overview-lower"><Card><div className="ui-card-heading"><div><span className="ui-eyebrow">Observability</span><h2>Runtime signals</h2></div><StatusBadge>Not configured</StatusBadge></div><div className="overview-stats"><div><small>Edge requests</small><strong>—</strong></div><div><small>Function invocations</small><strong>—</strong></div><div><small>Error rate</small><strong>—</strong></div></div><EmptyState title="No telemetry yet" body="Real edge and function metrics will appear when an observability adapter emits them." /></Card><Card><div className="ui-card-heading"><div><span className="ui-eyebrow">Analytics</span><h2>Understand your audience</h2></div><StatusBadge>Gated</StatusBadge></div><div className="overview-callout"><BarIcon /><div><strong>Enable Analytics</strong><p>Analytics is intentionally not enabled without a real telemetry provider.</p><Button variant="secondary" onClick={() => toast.info("Analytics remains not configured until a telemetry provider is connected.")}>View setup state</Button></div></div></Card></div>
    <div className="ui-section-heading"><div><span className="ui-eyebrow">Active Branches</span><h2>Projects in this workspace</h2></div><Button variant="ghost" onClick={onProjects}>View all <ArrowUpRight size={14} /></Button></div>{projectCount ? projects.data?.map(project => <button className="overview-project" key={project.id} onClick={() => onOpenProject(project.id)}><span className="overview-project-mark">{project.name.slice(0, 1).toUpperCase()}</span><span><strong>{project.name}</strong><small><GitBranch size={12} /> {project.slug} · updated {new Date(project.updated_at).toLocaleDateString()}</small></span><Globe2 size={15} /></button>) : <Card><EmptyState title="No projects yet" body="Create a project to start connecting repositories, domains, deployments, and runtime resources." action={<Button variant="primary" onClick={onProjects}>Open Projects</Button>} /></Card>}
  </>;
}
function BarIcon() { return <div className="overview-analytics-icon"><ShieldCheck size={20} /></div>; }
