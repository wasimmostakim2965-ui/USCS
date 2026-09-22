import { useMemo, useState } from "react";
import { ArrowUpRight, Box, GitBranch, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, EmptyState, ErrorState, Input, LoadingBlock, PageHeader, StatusBadge, Tabs } from "@/components/ui-kit";

type RouteProps = { routeParts?: string[]; onOpen: (id?: string) => void; onNavigate?: (href: string) => void };

export default function Projects({ routeParts, onOpen, onNavigate }: RouteProps) {
  const projectsQuery = trpc.workspace.projects.list.useQuery(undefined, { retry: false });
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const [query, setQuery] = useState("");
  const tab = ["all", "recents", "usage", "alerts"].includes(routeParts?.[1] ?? "") ? routeParts![1] : "all";
  const organizationId = organizations.data?.[0]?.id;

  const createProject = trpc.workspace.projects.create.useMutation({
    onSuccess: () => { toast.success("Project created"); void projectsQuery.refetch(); },
    onError: error => toast.error(error.message),
  });

  const projects = useMemo(
    () => (projectsQuery.data ?? []).filter((project: { name: string; slug: string }) => `${project.name} ${project.slug}`.toLowerCase().includes(query.toLowerCase())),
    [projectsQuery.data, query],
  );

  const add = () => {
    const name = window.prompt("Project name");
    if (!name?.trim() || !organizationId) return;
    createProject.mutate({ organizationId, name: name.trim() });
  };

  const projectId = routeParts?.[1] && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(routeParts[1]) ? routeParts[1] : undefined;
  if (projectId) return <ProjectDetail project={projectsQuery.data?.find((candidate: { id: string }) => candidate.id === projectId)} section={routeParts?.[2]} onNavigate={onNavigate} />;

  return <>
    <PageHeader
      title="Projects"
      crumb="Workspace / Projects"
      description="Every project owns its deployments, domains, data resources and security policy."
      action={<Button variant="primary" onClick={add} disabled={createProject.isPending || !organizationId}><Plus size={14} /> Add new</Button>}
    />
    <Tabs
      items={[{ label: "All projects", value: "all" }, { label: "Recents", value: "recents" }, { label: "Usage", value: "usage" }, { label: "Alerts", value: "alerts" }]}
      active={tab}
      onChange={value => onNavigate?.(`/dashboard/projects/${value}`)}
    />
    {tab === "usage" || tab === "alerts" ? (
      <Card><EmptyState title={`${tab[0].toUpperCase()}${tab.slice(1)} are not configured`} body="This view stays discoverable but only shows live project telemetry once the matching provider is connected." /></Card>
    ) : projectsQuery.isLoading ? (
      <LoadingBlock rows={4} />
    ) : projectsQuery.error ? (
      <ErrorState message={projectsQuery.error.message} />
    ) : (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div className="ds-search" style={{ flex: 1, maxWidth: 400 }}><Search size={15} /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search projects" /></div>
          <span style={{ color: "var(--ds-fg-muted)", fontSize: 12 }}>{projects.length} project{projects.length === 1 ? "" : "s"}</span>
        </div>
        {projects.length ? (
          <div className="ds-project-grid">
            {projects.map((project: { id: string; name: string; slug: string; updated_at: string }) => (
              <button className="ds-project-card" key={project.id} onClick={() => onOpen(project.id)}>
                <div className="ds-project-top"><span className="ds-project-mark">{project.name.slice(0, 1).toUpperCase()}</span><StatusBadge>Ready</StatusBadge></div>
                <div><h3>{project.name}</h3><small>{project.slug}</small></div>
                <div className="ds-project-meta">
                  <span><GitBranch size={12} /> Repository not configured</span>
                  <span>Updated {new Date(project.updated_at).toLocaleDateString()}</span>
                </div>
                <ArrowUpRight size={15} style={{ position: "absolute", right: 16, bottom: 16, color: "var(--ds-fg-subtle)" }} />
              </button>
            ))}
          </div>
        ) : <Card><EmptyState title="No projects yet" body="Create a project to connect repositories, deployments, domains and runtime resources." action={<Button variant="primary" onClick={add}><Plus size={14} /> Add new</Button>} /></Card>}
      </>
    )}
  </>;
}

function ProjectDetail({ project, section, onNavigate }: { project?: { id: string; name: string; slug: string; updated_at: string }; section?: string; onNavigate?: (href: string) => void }) {
  if (!project) return <><PageHeader title="Project" crumb="Workspace / Projects" /><Card><EmptyState title="Project not found" body="This project is not present in the live workspace or you do not have access to it." /></Card></>;
  const label = section ? section.replaceAll("-", " ").replace(/\b\w/g, character => character.toUpperCase()) : "Overview";
  return <>
    <PageHeader
      title={project.name}
      crumb={`Workspace / Projects / ${project.name} / ${label}`}
      description={`${project.slug} · Last updated ${new Date(project.updated_at).toLocaleDateString()}`}
      action={<Button onClick={() => onNavigate?.(`/dashboard/projects/${project.id}/deployments`)}>Deployments <ArrowUpRight size={14} /></Button>}
    />
    <Card>
      <EmptyState
        title={section ? `${label} is not configured` : "Project is ready"}
        body={section
          ? "This project section is wired to the URL and will only expose live provider data when the matching adapter is configured."
          : "Use the project sidebar to inspect deployments, domains, storage, database, security and environment variables."}
        action={<Button variant="secondary" onClick={() => onNavigate?.(`/dashboard/projects/${project.id}`)}><Box size={14} /> Project overview</Button>}
      />
    </Card>
  </>;
}
