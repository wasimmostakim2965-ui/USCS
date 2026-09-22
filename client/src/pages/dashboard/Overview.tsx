import { Plus, ChevronDown } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ComingSoon, Empty, Header, Status } from "./shared";

export default function Overview({ routeParts, onProjects, onOpenProject }: { routeParts?: string[]; onProjects: () => void; onOpenProject: (id?: string) => void }) {
  const projectsQuery = trpc.workspace.projects.list.useQuery(undefined, { retry: false });
  const projects = projectsQuery.data ?? [];
  const section = routeParts?.[1];
  if (section && section !== "activity-feed") return <><Header title={section.replaceAll("-", " ").replace(/\b\w/g, char => char.toUpperCase())} crumb={`Overview / ${section}`} /><ComingSoon title={section.replaceAll("-", " ")} body="This overview surface will populate from real organization-scoped telemetry when its provider data source is configured." /></>;
  return <><Header title="Overview" action={<button className="vc-btn primary" onClick={onProjects}><Plus size={14} /> Add New <ChevronDown size={13} /></button>} />
    <div className="vc-card vc-recent"><div className="vc-tabs"><button className="active">Recents</button><button onClick={onProjects}>Projects</button></div>{projectsQuery.isLoading ? <div className="vc-loading-row">Loading workspace data…</div> : <Empty title="No recent activity" body="Deployments, project changes and alerts will appear here when Cloud Wai has activity." action="Open Projects" onAction={onProjects} />}</div>
    <div className="vc-section-title">Projects</div>
    {projects.length ? projects.map(project => <button className="vc-project-card" key={project.id} onClick={() => onOpenProject(project.id)}><span className="vc-project-logo">U</span><span><strong>{project.name}</strong><small>{project.slug}</small><p>Cloud Wai workspace · {new Date(project.updated_at).toLocaleDateString()}</p></span><Status good>Connected</Status></button>) : <div className="vc-card"><Empty title="No projects yet" body="Create a project to connect repositories, deployments, domains and runtime resources." action="Open Projects" onAction={onProjects} /></div>}
  </>;
}
