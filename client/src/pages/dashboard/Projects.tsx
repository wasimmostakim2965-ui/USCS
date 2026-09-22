import { useMemo, useState } from "react";
import { ArrowUpRight, Box, GitBranch, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, EmptyState, Input, LoadingSkeleton, PageHeader, StatusBadge, Tabs } from "@/components/ui-kit";

export default function Projects({ routeParts, onOpen, onNavigate }: { routeParts?: string[]; onOpen: (id?: string) => void; onNavigate?: (href: string) => void }) {
  const projectsQuery = trpc.workspace.projects.list.useQuery(undefined, { retry: false });
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const [query, setQuery] = useState("");
  const routeTab = routeParts?.[1] === "usage" || routeParts?.[1] === "alerts" ? routeParts[1] : "recents";
  const createProject = trpc.workspace.projects.create.useMutation({ onSuccess: () => { toast.success("Project created"); setQuery(""); void projectsQuery.refetch(); }, onError: error => toast.error(error.message) });
  const projects = useMemo(() => (projectsQuery.data ?? []).filter(project => project.name.toLowerCase().includes(query.toLowerCase()) || project.slug.toLowerCase().includes(query.toLowerCase())), [projectsQuery.data, query]);
  const add = () => { const name = window.prompt("Project name"); const organizationId = organizations.data?.[0]?.id; if (!name?.trim() || !organizationId) return; createProject.mutate({ organizationId, name: name.trim() }); };
  if (routeParts?.[1] && /^[0-9a-f-]{36}$/i.test(routeParts[1])) return <ProjectDetail project={projectsQuery.data?.find(project => project.id === routeParts[1])} section={routeParts[2]} />;
  return <>
    <PageHeader title="Projects" breadcrumb="Workspace / Projects" action={<Button variant="primary" onClick={add} disabled={createProject.isPending}><Plus size={14} /> Add New</Button>} />
    <div className="projects-scope"><div><span className="ui-eyebrow">Scope</span><strong>All Projects</strong></div><span className="ui-scope-hint">{organizations.data?.[0]?.name ?? "Workspace"}</span></div>
    <Tabs items={[{ label: "Recents", value: "recents" }, { label: "Usage", value: "usage" }, { label: "Alerts", value: "alerts" }]} active={routeTab} onChange={value => onNavigate?.(`/dashboard/projects/${value}`)} />
    {routeTab !== "recents" ? <Card><EmptyState title={`${routeTab[0].toUpperCase()}${routeTab.slice(1)} are not configured`} body="This view stays visible for discoverability but will only show live project telemetry when its provider is connected." /></Card> : <><div className="projects-toolbar"><div className="projects-search"><Search size={15} /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search projects" /></div><span className="projects-count">{projects.length} project{projects.length === 1 ? "" : "s"}</span></div>{projectsQuery.isLoading ? <LoadingSkeleton rows={4} /> : projects.length ? <div className="project-card-grid">{projects.map(project => <button className="project-card-modern" key={project.id} onClick={() => onOpen(project.id)}><div className="project-card-top"><span className="project-mark">{project.name.slice(0, 1).toUpperCase()}</span><StatusBadge status="neutral">Ready</StatusBadge></div><strong>{project.name}</strong><small>{project.slug}</small><div className="project-card-meta"><span><GitBranch size={12} /> Repository not configured</span><span>Updated {new Date(project.updated_at).toLocaleDateString()}</span></div><ArrowUpRight size={15} className="project-card-arrow" /></button>)}</div> : <Card><EmptyState title="No projects yet" body="Create a project to connect repositories, deployments, domains and runtime resources." action={<Button variant="primary" onClick={add}><Plus size={14} /> Add New</Button>} /></Card>}</>}
  </>;
}

function ProjectDetail({ project, section }: { project?: { id: string; name: string; slug: string; updated_at: string }; section?: string }) {
  if (!project) return <EmptyState title="Project not found" body="This project is not present in the live workspace or you do not have access to it." />;
  return <><PageHeader title={project.name} breadcrumb={`Workspace / Projects / ${project.name} / ${section || "Overview"}`} /><Card className="project-detail-card"><span className="ui-eyebrow">Project scope</span><h2>{section ? section.replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase()) : "Overview"}</h2><p>{project.slug} · Last updated {new Date(project.updated_at).toLocaleDateString()}</p><EmptyState title={section ? "Project surface is not configured" : "Project is ready"} body={section ? "This project section is wired to the URL and will only expose live provider data when the corresponding adapter is configured." : "Use the project sidebar to inspect deployments, domains, storage, database, security and environment variables."} action={!section ? <Button variant="secondary" onClick={() => undefined}><Box size={14} /> Project overview</Button> : undefined} /></Card></>;
}
