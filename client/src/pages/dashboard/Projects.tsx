import { useState } from "react";
import { Plus, ChevronDown, Search } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ComingSoon, Empty, Header, Status } from "./shared";

export default function Projects({ routeParts, onOpen }: { routeParts?: string[]; onOpen: (id?: string) => void }) {
  const projectsQuery = trpc.workspace.projects.list.useQuery(undefined, { retry: false });
  const orgQuery = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const [query, setQuery] = useState("");
  const createProject = trpc.workspace.projects.create.useMutation({ onSuccess: () => { void projectsQuery.refetch(); toast.success("Project created"); }, onError: error => toast.error(error.message) });
  const projects = (projectsQuery.data ?? []).filter(project => project.name.toLowerCase().includes(query.toLowerCase()) || project.slug.toLowerCase().includes(query.toLowerCase()));
  const add = () => { const name = window.prompt("Project name"); const organization = orgQuery.data?.[0]; if (!name?.trim()) return; if (!organization) { toast.error("No workspace is available"); return; } createProject.mutate({ organizationId: organization.id, name: name.trim() }); };
  const selectedId = routeParts?.[1];
  const selectedProject = selectedId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selectedId) ? projectsQuery.data?.find(project => project.id === selectedId) : undefined;
  if (selectedId && selectedProject) return <ProjectDetail project={selectedProject} section={routeParts?.[2] ?? ""} />;
  return <><Header title="Projects" crumb="All Projects" action={<button className="vc-btn primary" onClick={add}><Plus size={14} /> Add New <ChevronDown size={13} /></button>} />
    <div className="vc-project-toolbar"><div className="vc-search-input"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Projects" /></div></div>
    <div className="vc-card vc-project-recent">{projectsQuery.isLoading ? <div className="vc-loading-row">Loading projects…</div> : <Empty title={projects.length ? "Project activity" : "No recent project activity"} body="Deployment, configuration and security events will appear here when connected providers produce activity." />}</div>
    <div className="vc-section-title">Projects</div>
    {projects.length ? projects.map(project => <button className="vc-project-card" key={project.id} onClick={() => onOpen(project.id)}><span className="vc-project-logo">U</span><span><strong>{project.name}</strong><small>{project.slug}</small><p>Cloud Wai workspace · {new Date(project.updated_at).toLocaleDateString()}</p></span><Status good>Ready</Status></button>) : <div className="vc-card"><Empty title="No projects yet" body="Create a project to connect repositories, deployments, domains and runtime resources." action="Add New" onAction={add} /></div>}
  </>;
}

function ProjectDetail({ project, section }: { project: { id: string; name: string; slug: string; updated_at: string }; section: string }) {
  const title = section ? section.replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase()) : "Overview";
  return <><Header title={project.name} crumb={`Projects / ${project.name} / ${title}`} /><div className="vc-card"><span className="vc-eyebrow">Project</span><h3>{project.name}</h3><p>{project.slug} · Last updated {new Date(project.updated_at).toLocaleDateString()}</p>{!section && <div className="vc-list-row"><Status good>Workspace project</Status><span><strong>Project scope is active</strong><small>Use the project sidebar to drill into deployments, domains, environment variables, Git, functions, and settings.</small></span></div>}</div>{section === "deployments" ? <ComingSoon title="Project deployments" body="Project-scoped deployment history will appear here when deployment data is filtered by this project." /> : section === "domains" ? <ComingSoon title="Project domains" body="Project-scoped domain bindings are available from the deployment domain controls; a dedicated project view is not configured yet." /> : section === "env-vars" ? <ComingSoon title="Project environment variables" body="Environment variables are managed through the deployment environment controls and remain masked until a real provider is configured." /> : section === "git" ? <ComingSoon title="Project Git connection" body="Connect a repository from Developer before project-level Git actions become available." /> : section === "functions" ? <ComingSoon title="Project functions" body="Functions are not configured for this self-operated control plane." /> : section === "settings" ? <ComingSoon title="Project settings" body="Project settings will be enabled when project-level permission and provider contracts are configured." /> : null}</>;
}
