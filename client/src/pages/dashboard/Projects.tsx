import { useState } from "react";
import { Plus, ChevronDown, Search } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Empty, Header, Status } from "./shared";

export default function Projects({ onOpen }: { onOpen: (id?: string) => void }) {
  const projectsQuery = trpc.workspace.projects.list.useQuery(undefined, { retry: false });
  const orgQuery = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  const [query, setQuery] = useState("");
  const createProject = trpc.workspace.projects.create.useMutation({ onSuccess: () => { void projectsQuery.refetch(); toast.success("Project created"); }, onError: error => toast.error(error.message) });
  const projects = (projectsQuery.data ?? []).filter(project => project.name.toLowerCase().includes(query.toLowerCase()) || project.slug.toLowerCase().includes(query.toLowerCase()));
  const add = () => { const name = window.prompt("Project name"); const organization = orgQuery.data?.[0]; if (!name?.trim()) return; if (!organization) { toast.error("No workspace is available"); return; } createProject.mutate({ organizationId: organization.id, name: name.trim() }); };
  return <><Header title="Projects" crumb="All Projects" action={<button className="vc-btn primary" onClick={add}><Plus size={14} /> Add New <ChevronDown size={13} /></button>} />
    <div className="vc-project-toolbar"><div className="vc-search-input"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Projects" /></div></div>
    <div className="vc-card vc-project-recent">{projectsQuery.isLoading ? <div className="vc-loading-row">Loading projects…</div> : <Empty title={projects.length ? "Project activity" : "No recent project activity"} body="Deployment, configuration and security events will appear here when connected providers produce activity." />}</div>
    <div className="vc-section-title">Projects</div>
    {projects.length ? projects.map(project => <button className="vc-project-card" key={project.id} onClick={() => onOpen(project.id)}><span className="vc-project-logo">U</span><span><strong>{project.name}</strong><small>{project.slug}</small><p>Cloud Wai workspace · {new Date(project.updated_at).toLocaleDateString()}</p></span><Status good>Ready</Status></button>) : <div className="vc-card"><Empty title="No projects yet" body="Create a project to connect repositories, deployments, domains and runtime resources." action="Add New" onAction={add} /></div>}
  </>;
}
