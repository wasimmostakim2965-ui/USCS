/**
 * The dashboard pages.
 *
 * Each page loads exactly the sections its route names and renders them through
 * `SectionView`, which is the single place a section state becomes UI. There is
 * no page here that renders a value it did not load, and no page that turns a
 * `not_configured` engine into a success.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  type Column,
  DegradedState,
  Drawer,
  EmptyState,
  ErrorState,
  Field,
  LoadingSkeleton,
  Modal,
  PageShell,
  SectionShell,
  SectionView,
  StatBox,
  StatusBadge,
  Table,
  TextInput,
  presentDeploymentStatus,
} from "@cloud-wai/ui/react";
import { useApp } from "../react/context.js";
import { useSection } from "../react/hooks.js";
import { newRequestId } from "../ids.js";
import type { Route } from "../routes.js";
import {
  loadApiKeys,
  loadAudit,
  loadDeployments,
  loadDeploymentLogs,
  loadDomains,
  loadOrganization,
  loadOrganizationMembers,
  loadOrganizations,
  loadProject,
  loadProjects,
  updateProject,
  loadProviderHealth,
  loadUsage,
  loadSecurityPolicy,
  loadSecurityPolicyEvents,
  API_KEY_SCOPES,
  type ApiKeySummaryRow,
  type AuditSummary,
  type DeploymentRequestSummary,
  type DeploymentLogsSummary,
  type DeploymentSummary,
  type DistributePolicySummary,
  type DomainChallengeSummary,
  type DomainSummary,
  type DomainVerificationSummary,
  type IssuedApiKey,
  type OrganizationSummary,
  type OrganizationMemberSummary,
  type ProjectSummary,
  type ProviderHealthRow,
  type SecurityPolicyEventSummary,
  type SecurityPolicySummary,
  type UsageTotalSummary,
} from "../view-model.js";
import { ApiKeyStateBadge, Link, Timestamp, VerifiedBadge } from "../components/page-parts.js";

/* ------------------------------------------------------------------ cards */

function DeploymentColumns(): readonly Column<DeploymentSummary>[] {
  return [
    {
      key: "status",
      header: "Status",
      render: (item) => {
        const presentation = presentDeploymentStatus(item.status);
        return <StatusBadge label={presentation.label} tone={presentation.tone} />;
      },
    },
    {
      key: "id",
      header: "Deployment",
      render: (item) => <span className="mono small">{item.id.slice(0, 12)}</span>,
    },
    {
      key: "url",
      header: "URL",
      render: (item) =>
        item.url ? (
          <span className="mono small truncate" style={{ display: "inline-block", maxWidth: 320 }}>
            {item.url}
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: "reason",
      header: "Detail",
      render: (item) =>
        item.failureReason ? (
          <span className="small">{item.failureReason}</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
  ];
}

/* ------------------------------------------------------------ organizations */

export function OrganizationsPage({
  createRequest = 0,
  onCreateRequestHandled,
}: {
  /** Non-zero when the shell asked for the create form; consumed then reset. */
  readonly createRequest?: number;
  readonly onCreateRequestHandled?: () => void;
}) {
  const { client, router } = useApp();
  const { section, reload } = useSection(
    () => loadOrganizations(client),
    [client],
    "Organizations",
  );
  const [creating, setCreating] = useState(false);

  // A request from the sidebar or the palette opens the form here, so "New
  // workspace" creates rather than merely landing on the list. The request is
  // consumed as it is acted on, so a later remount of this page does not reopen
  // a form the operator already dismissed.
  useEffect(() => {
    if (createRequest > 0) {
      setCreating(true);
      onCreateRequestHandled?.();
    }
  }, [createRequest, onCreateRequestHandled]);

  return (
    <PageShell
      title="Organizations"
      subtitle="A workspace is the tenant boundary. Everything you deploy belongs to one."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          New organization
        </Button>
      }
    >
      <SectionView<OrganizationSummary>
        section={section}
        onRetry={reload}
        emptyMessage="You are not a member of any organization yet. Create one to begin."
        renderReady={(items) => (
          <div className="grid">
            {items.map((organization) => (
              <Card
                key={organization.id}
                title={organization.name}
                actions={
                  <Link to={{ name: "projects", organizationId: organization.id }}>Open →</Link>
                }
              >
                <dl className="dl">
                  <dt>Slug</dt>
                  <dd className="mono">{organization.slug}</dd>
                  <dt>Id</dt>
                  <dd className="mono small">{organization.id}</dd>
                </dl>
              </Card>
            ))}
          </div>
        )}
      />

      <NewOrganizationModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(organizationId) => {
          setCreating(false);
          router.navigate({ name: "projects", organizationId });
        }}
      />
    </PageShell>
  );
}

function NewOrganizationModal({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (organizationId: string) => void;
}) {
  const { client } = useApp();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<OrganizationSummary>("organizations.create", { name, slug });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The organization could not be created.");
      return;
    }
    setName("");
    setSlug("");
    onCreated(response.data.id);
  };

  return (
    <Modal
      title="New organization"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            busy={busy}
            disabled={!name || !slug}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name" hint="Shown throughout the console.">
          {(id) => <TextInput id={id} value={name} onChange={setName} placeholder="Acme Inc." />}
        </Field>
        <Field
          label="Slug"
          hint="Lowercase letters, digits and hyphens. Used in URLs."
          {...(error ? { error } : {})}
        >
          {(id) => (
            <TextInput
              id={id}
              value={slug}
              onChange={(value) => setSlug(value.toLowerCase())}
              placeholder="acme"
              error={Boolean(error)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ projects */

export function ProjectsPage({ organizationId }: { readonly organizationId: string }) {
  const { client, router } = useApp();
  const { section, reload } = useSection(
    () => loadProjects(client, organizationId),
    [client, organizationId],
    "Projects",
  );
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<ProjectSummary>("projects.create", {
      organizationId,
      name,
      slug,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The project could not be created.");
      return;
    }
    setCreating(false);
    setName("");
    setSlug("");
    router.navigate({ name: "project", organizationId, projectId: response.data.id });
  };

  return (
    <PageShell
      title="Projects"
      subtitle="An application you deploy, with its own deployments, domains, data and security policy."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          New project
        </Button>
      }
    >
      <SectionView<ProjectSummary>
        section={section}
        onRetry={reload}
        emptyMessage="No projects yet. Create one to deploy your first application."
        renderReady={(items) => (
          <div className="grid">
            {items.map((project) => (
              <Card
                key={project.id}
                title={project.name}
                actions={
                  <Link to={{ name: "project", organizationId, projectId: project.id }}>
                    Open →
                  </Link>
                }
              >
                <dl className="dl">
                  <dt>Slug</dt>
                  <dd className="mono">{project.slug}</dd>
                </dl>
              </Card>
            ))}
          </div>
        )}
      />

      <Modal
        title="New project"
        open={creating}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              busy={busy}
              disabled={!name || !slug}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="stack">
          <Field label="Name">
            {(id) => <TextInput id={id} value={name} onChange={setName} placeholder="Web app" />}
          </Field>
          <Field
            label="Slug"
            hint="Lowercase letters, digits and hyphens."
            {...(error ? { error } : {})}
          >
            {(id) => (
              <TextInput
                id={id}
                value={slug}
                onChange={(value) => setSlug(value.toLowerCase())}
                placeholder="web-app"
                error={Boolean(error)}
              />
            )}
          </Field>
        </div>
      </Modal>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ project */

export function ProjectOverviewPage({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const project = useSection(() => loadProject(client, projectId), [client, projectId], "Project");
  const deployments = useSection(
    () => loadDeployments(client, projectId),
    [client, projectId],
    "Deployments",
  );
  const audit = useSection(
    () => loadAudit(client, organizationId),
    [client, organizationId],
    "Recent activity",
  );

  const projectItem =
    project.section.state.kind === "ready" ? project.section.state.items[0] : undefined;
  const deploymentItems =
    deployments.section.state.kind === "ready" ? deployments.section.state.items : [];
  const live = deploymentItems.filter((item) => item.status === "succeeded").length;
  const unconfigured = deploymentItems.filter((item) => item.status === "not_configured").length;

  return (
    <PageShell
      title={projectItem?.name ?? "Project"}
      subtitle={projectItem ? `Slug ${projectItem.slug}` : undefined}
      actions={<Link to={{ name: "deployments", organizationId, projectId }}>Deployments →</Link>}
      breadcrumb={
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to={{ name: "projects", organizationId }}>Projects</Link>
          <span className="breadcrumb__sep">/</span>
          <span aria-current="page">{projectItem?.name ?? projectId.slice(0, 8)}</span>
        </nav>
      }
    >
      {project.section.state.kind === "error" || project.section.state.kind === "degraded" ? (
        <SectionView<ProjectSummary> section={project.section} onRetry={project.reload} />
      ) : null}

      <div className="grid grid--stats" style={{ marginBottom: "var(--space-6)" }}>
        <StatBox
          label="Deployments"
          value={deployments.section.state.kind === "loading" ? "…" : deploymentItems.length}
          note="Total recorded for this project"
        />
        <StatBox label="Live" value={live} note="Reported succeeded by the engine" />
        <StatBox
          label="Not configured"
          value={unconfigured}
          note="Requested, but no hosting engine is wired"
        />
      </div>

      <SectionShell title="Deployments" hint="Newest first">
        <Card flush>
          <SectionView<DeploymentSummary>
            section={deployments.section}
            columns={DeploymentColumns()}
            rowKey={(item) => item.id}
            onRetry={deployments.reload}
            emptyMessage="Nothing has been deployed yet."
          />
        </Card>
      </SectionShell>

      <SectionShell title="Recent activity">
        <Card flush>
          <SectionView<AuditSummary>
            section={audit.section}
            onRetry={audit.reload}
            emptyMessage="No recorded activity for this organization yet."
            renderReady={(items) => (
              <Table
                items={items.slice(0, 8)}
                rowKey={(item) => item.id}
                columns={[
                  {
                    key: "event",
                    header: "Event",
                    render: (item) => <span className="mono small">{item.event}</span>,
                  },
                  { key: "actor", header: "Actor", render: (item) => item.actorEmail ?? "—" },
                  {
                    key: "when",
                    header: "When",
                    render: (item) => <Timestamp value={item.createdAt} />,
                  },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>
    </PageShell>
  );
}

/**
 * A project's settings page.
 *
 * Distinct from the workspace Settings page: this one edits the project the
 * caller is currently inside. Renaming goes through `projects.update`, which
 * resolves the organization from the row (not the request) before it guards.
 * Engine-owned fields are not shown as editable because they are not — the
 * adapter writes them.
 */
export function ProjectSettingsPage({
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadProject(client, projectId),
    [client, projectId],
    "Project",
  );

  const project = section.state.kind === "ready" ? section.state.items[0] : undefined;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // Seed once per project. Keying on the id (rather than priming on empty
  // strings) means a keystroke after a save is never overwritten by a reload.
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (project && seededFor.current !== project.id) {
      seededFor.current = project.id;
      setName(project.name);
      setSlug(project.slug);
    }
  }, [project]);

  const dirty = Boolean(project) && (name !== project!.name || slug !== project!.slug);

  const submit = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    const result = await updateProject(client, { projectId, name, slug });
    setBusy(false);
    if (result.state.kind !== "ready" || !result.state.items[0]) {
      setError(
        result.state.kind === "error" ? result.state.message : "The project could not be updated.",
      );
      return;
    }
    setSaved(true);
    reload();
  };

  return (
    <PageShell
      title="Settings"
      subtitle="Rename this project. Engine-owned fields are written by the adapters, not here."
    >
      <SectionShell title="Project">
        <Card>
          <div className="stack">
            <Field label="Name" {...(error ? { error } : {})}>
              {(id) => (
                <TextInput
                  id={id}
                  value={name}
                  onChange={(value) => {
                    setSaved(false);
                    setName(value);
                  }}
                  placeholder="Web app"
                />
              )}
            </Field>
            <Field label="Slug" hint="Lowercase letters, digits and hyphens. Used in URLs.">
              {(id) => (
                <TextInput
                  id={id}
                  value={slug}
                  onChange={(value) => {
                    setSaved(false);
                    setSlug(value.toLowerCase());
                  }}
                  placeholder="web-app"
                />
              )}
            </Field>
            <dl className="dl">
              <dt>Project ID</dt>
              <dd className="mono">{projectId}</dd>
            </dl>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {saved ? <span className="muted small">Saved.</span> : null}
              <Button
                variant="primary"
                onClick={() => void submit()}
                busy={busy}
                disabled={!dirty || !name || !slug}
              >
                Save changes
              </Button>
            </div>
          </div>
        </Card>
      </SectionShell>
    </PageShell>
  );
}

export function DeploymentsPage({
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadDeployments(client, projectId),
    [client, projectId],
    "Deployments",
  );
  const [deploying, setDeploying] = useState(false);
  const [rollingBack, setRollingBack] = useState<DeploymentSummary | null>(null);
  const [viewingLogs, setViewingLogs] = useState<DeploymentSummary | null>(null);

  return (
    <PageShell
      title="Deployments"
      subtitle="Every deployment this project has requested, newest first. A status is the hosting engine's, never the request's."
      actions={
        <Button variant="primary" onClick={() => setDeploying(true)}>
          New deployment
        </Button>
      }
    >
      <Card flush>
        <SectionView<DeploymentSummary>
          section={section}
          columns={[
            ...DeploymentColumns(),
            {
              key: "actions",
              header: "",
              render: (item) => (
                <div className="row">
                  <Button variant="ghost" size="sm" onClick={() => setViewingLogs(item)}>
                    Logs
                  </Button>
                  {item.status === "succeeded" ? (
                    <Button variant="ghost" size="sm" onClick={() => setRollingBack(item)}>
                      Rollback
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="Nothing has been deployed yet."
          filterText={(item) => `${item.status} ${item.url ?? ""} ${item.id}`}
          filterLabel="Filter deployments"
        />
      </Card>

      <NewDeploymentModal
        // Remount per open so the idempotency key is fresh for a new request
        // but stays put for a retry within the same open form.
        key={`deploy-${String(deploying)}`}
        projectId={projectId}
        open={deploying}
        onClose={() => setDeploying(false)}
        onRequested={() => {
          setDeploying(false);
          reload();
        }}
      />

      <RollbackDeploymentModal
        key={`rollback-${rollingBack?.id ?? "none"}`}
        projectId={projectId}
        deployment={rollingBack}
        onClose={() => setRollingBack(null)}
        onRolledBack={() => {
          setRollingBack(null);
          reload();
        }}
      />

      <DeploymentLogsDrawer
        key={`logs-${viewingLogs?.id ?? "none"}`}
        projectId={projectId}
        deployment={viewingLogs}
        onClose={() => setViewingLogs(null)}
      />
    </PageShell>
  );
}

/**
 * Show a deployment's engine logs.
 *
 * The lines come from the hosting engine through `deployments.logs`. When the
 * engine is not configured, or the project was never deployed, the drawer says
 * so in the engine's own words instead of showing an empty or fabricated log.
 */
function DeploymentLogsDrawer({
  projectId,
  deployment,
  onClose,
}: {
  readonly projectId: string;
  readonly deployment: DeploymentSummary | null;
  readonly onClose: () => void;
}) {
  const { client } = useApp();
  // A local, data-carrying state: the drawer needs the fetched summary back out
  // of the success arm, which the shapes-only `ViewState` does not carry.
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "degraded"; readonly reason: string }
    | { readonly kind: "success"; readonly data: DeploymentLogsSummary }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "loading" });

  const load = useCallback(async () => {
    if (!deployment) return;
    setState({ kind: "loading" });
    const logs = await loadDeploymentLogs(client, projectId, deployment.id);
    if (logs.engineReason && logs.lines.length === 0) {
      setState({ kind: "degraded", reason: logs.engineReason });
      return;
    }
    setState({ kind: "success", data: logs });
  }, [client, projectId, deployment]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Drawer
      title={deployment ? `Logs — ${deployment.id.slice(0, 8)}` : "Logs"}
      open={deployment !== null}
      onClose={onClose}
    >
      {state.kind === "loading" ? <LoadingSkeleton title="Logs" rows={5} /> : null}
      {state.kind === "degraded" ? (
        <DegradedState title="Deployment logs" reason={state.reason} />
      ) : null}
      {state.kind === "success" && state.data ? (
        <>
          <p className="small muted">
            {state.data.source === "deployment"
              ? "This is the build and deploy log for this run, as the hosting engine recorded it."
              : state.data.source === "application"
                ? "This is the running application's log tail. This deployment has no build log recorded from the engine, so the container's output is shown instead."
                : "The hosting engine returned no log source for this deployment."}
          </p>
          {state.data.cursor === null ? (
            <p className="small muted">
              The hosting engine keeps no cursor for logs, so this is the full tail it returned.
            </p>
          ) : null}
          {state.data.lines.length === 0 ? (
            <EmptyState
              title="No output yet"
              message="The engine returned no log lines for this deployment."
            />
          ) : (
            <pre className="log" aria-label="Deployment logs">
              {state.data.lines.join("\n")}
            </pre>
          )}
        </>
      ) : null}
      {state.kind === "error" ? (
        <ErrorState title="Deployment logs" message={state.message} onRetry={() => void load()} />
      ) : null}
    </Drawer>
  );
}

/**
 * Request a deployment.
 *
 * The branch and repository are optional because the engine may already hold
 * them; whatever is submitted is validated on the server. The result is shown
 * with the engine's own words, so a deployment with no hosting credentials reads
 * as "not configured" rather than as a failure the operator caused.
 */
function NewDeploymentModal({
  projectId,
  open,
  onClose,
  onRequested,
}: {
  readonly projectId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onRequested: () => void;
}) {
  const { client } = useApp();
  const [gitRepository, setGitRepository] = useState("");
  const [gitBranch, setGitBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeploymentRequestSummary | null>(null);
  // One key per open form: pressing "Deploy" twice, or after a failure, replays
  // the same request instead of queuing a second deployment.
  const [idempotencyKey] = useState(newRequestId);

  const reset = () => {
    setGitRepository("");
    setGitBranch("");
    setCommit("");
    setError(null);
    setResult(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<DeploymentRequestSummary>("deployments.create", {
      projectId,
      idempotencyKey,
      ...(gitRepository ? { gitRepository } : {}),
      ...(gitBranch ? { gitBranch } : {}),
      ...(commit ? { commit } : {}),
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The deployment could not be requested.");
      return;
    }
    setResult(response.data);
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <Modal
      title={result ? "Deployment requested" : "New deployment"}
      open={open}
      onClose={close}
      footer={
        result ? (
          <Button variant="primary" onClick={onRequested}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy}>
              Deploy
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <dl className="dl">
            <dt>Status</dt>
            <dd>
              <StatusBadge
                label={presentDeploymentStatus(result.deployment.status).label}
                tone={presentDeploymentStatus(result.deployment.status).tone}
              />
            </dd>
            <dt>Deployment</dt>
            <dd className="mono small">{result.deployment.id}</dd>
            {result.deployment.url ? (
              <>
                <dt>URL</dt>
                <dd className="mono small">{result.deployment.url}</dd>
              </>
            ) : null}
          </dl>
          {result.engineReason ? (
            <p className="small muted" role="status">
              The hosting engine did not act: {result.engineReason}
            </p>
          ) : null}
          {result.replayed ? (
            <p className="small muted">
              This request matched an earlier deployment, so nothing new was queued.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <p className="small muted">
            Leave a field blank to use what the engine already holds for this project.
          </p>
          <Field label="Repository" hint="https:// or git@ clone URL.">
            {(id) => (
              <TextInput
                id={id}
                value={gitRepository}
                onChange={setGitRepository}
                placeholder="https://github.com/acme/web-app.git"
              />
            )}
          </Field>
          <Field label="Branch">
            {(id) => (
              <TextInput id={id} value={gitBranch} onChange={setGitBranch} placeholder="main" />
            )}
          </Field>
          <Field label="Commit" hint="Optional; a specific revision to deploy.">
            {(id) => (
              <TextInput id={id} value={commit} onChange={setCommit} placeholder="abc1234" />
            )}
          </Field>
          {error ? (
            <p className="small" role="alert" style={{ color: "var(--danger-text, #f88)" }}>
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/**
 * Roll a project back.
 *
 * Coolify refuses a rollback without the git ref to return to, so the commit is
 * required here too — the dialog asks for it rather than sending a request the
 * engine will reject.
 */
function RollbackDeploymentModal({
  projectId,
  deployment,
  onClose,
  onRolledBack,
}: {
  readonly projectId: string;
  readonly deployment: DeploymentSummary | null;
  readonly onClose: () => void;
  readonly onRolledBack: () => void;
}) {
  const { client } = useApp();
  const [commit, setCommit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same reasoning as a deployment: a second press must not queue a second
  // rollback of the same commit.
  const [idempotencyKey] = useState(newRequestId);

  const submit = async () => {
    if (!deployment) return;
    setBusy(true);
    setError(null);
    const response = await client.call<DeploymentRequestSummary>("deployments.rollback", {
      projectId,
      commit,
      idempotencyKey,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The rollback could not be requested.");
      return;
    }
    setCommit("");
    onRolledBack();
  };

  return (
    <Modal
      title="Roll back"
      open={deployment !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => void submit()}
            busy={busy}
            disabled={commit.trim() === ""}
          >
            Roll back
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          Rolling back records a new deployment at an earlier revision. The deployment you are
          undoing is kept in the history.
        </p>
        <Field label="Commit" hint="The git revision to return to." {...(error ? { error } : {})}>
          {(id) => (
            <TextInput
              id={id}
              value={commit}
              onChange={setCommit}
              placeholder="abc1234"
              error={Boolean(error)}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ domains */

export function DomainsPage({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId?: string | undefined;
}) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadDomains(client, organizationId, projectId),
    [client, organizationId, projectId],
    "Domains",
  );

  const [adding, setAdding] = useState(false);
  const [verifying, setVerifying] = useState<DomainSummary | null>(null);
  const [removing, setRemoving] = useState<DomainSummary | null>(null);

  return (
    <PageShell
      title="Domains"
      subtitle="Hostnames routed through the security edge. Only the edge can verify a hostname."
      actions={
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add domain
        </Button>
      }
    >
      <Card flush>
        <SectionView<DomainSummary>
          section={section}
          columns={[
            {
              key: "hostname",
              header: "Hostname",
              render: (item) => <span className="mono">{item.hostname}</span>,
            },
            {
              key: "verified",
              header: "State",
              render: (item) => <VerifiedBadge verified={item.verified} />,
            },
            {
              key: "verifiedAt",
              header: "Last verified",
              render: (item) =>
                item.verifiedAt ? (
                  <Timestamp value={item.verifiedAt} />
                ) : (
                  <span className="muted">Never</span>
                ),
            },
            {
              key: "actions",
              header: "",
              render: (item) => (
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Button size="sm" onClick={() => setVerifying(item)}>
                    Verify
                  </Button>
                  <Button size="sm" onClick={() => setRemoving(item)}>
                    Remove
                  </Button>
                </div>
              ),
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="No domains registered. A domain is created unverified and the edge confirms it."
          filterText={(item) => `${item.hostname} ${item.verified ? "verified" : "unverified"}`}
          filterLabel="Filter domains"
        />
      </Card>

      <AddDomainModal
        organizationId={organizationId}
        projectId={projectId}
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          reload();
        }}
      />

      <VerifyDomainModal
        organizationId={organizationId}
        domain={verifying}
        onClose={() => setVerifying(null)}
        onVerified={() => {
          setVerifying(null);
          reload();
        }}
      />

      <RemoveDomainModal
        organizationId={organizationId}
        domain={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          setRemoving(null);
          reload();
        }}
      />
    </PageShell>
  );
}

/**
 * Add a hostname.
 *
 * The server creates it unverified and answers with the DNS challenge to
 * publish; this dialog shows that record rather than claiming the domain is
 * live. The final state is the verifier's to decide, not this form's.
 */
function AddDomainModal({
  organizationId,
  projectId,
  open,
  onClose,
  onAdded,
}: {
  readonly organizationId: string;
  readonly projectId?: string | undefined;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const { client } = useApp();
  const [hostname, setHostname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<DomainChallengeSummary | null>(null);

  const close = () => {
    setHostname("");
    setError(null);
    setChallenge(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<DomainChallengeSummary>("domains.create", {
      organizationId,
      hostname,
      ...(projectId ? { projectId } : {}),
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The domain could not be added.");
      return;
    }
    setChallenge(response.data);
  };

  return (
    <Modal
      title={challenge ? "Publish this DNS record" : "Add domain"}
      open={open}
      onClose={close}
      footer={
        challenge ? (
          <Button variant="primary" onClick={onAdded}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy}>
              Add
            </Button>
          </>
        )
      }
    >
      {challenge ? (
        <div className="stack">
          <p>
            The domain is registered but not yet verified. Publish this record, then use Verify.
          </p>
          <dl className="dl">
            <dt>Type</dt>
            <dd className="mono">{challenge.recordType}</dd>
            <dt>Name</dt>
            <dd className="mono">{challenge.recordName}</dd>
            <dt>Value</dt>
            <dd className="mono">{challenge.recordValue}</dd>
          </dl>
        </div>
      ) : (
        <div className="stack">
          <Field
            label="Hostname"
            hint="A hostname you control, e.g. app.example.com."
            {...(error ? { error } : {})}
          >
            {(id) => (
              <TextInput
                id={id}
                value={hostname}
                onChange={setHostname}
                placeholder="app.example.com"
                error={Boolean(error)}
                autoFocus
              />
            )}
          </Field>
        </div>
      )}
    </Modal>
  );
}

/**
 * Verify a hostname.
 *
 * The request asks the verifier to look; the answer is the verifier's. A
 * refusal is shown as its own detail, not as a failure the operator caused.
 */
function VerifyDomainModal({
  organizationId,
  domain,
  onClose,
  onVerified,
}: {
  readonly organizationId: string;
  readonly domain: DomainSummary | null;
  readonly onClose: () => void;
  readonly onVerified: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DomainVerificationSummary | null>(null);

  if (!domain) return null;

  const close = () => {
    setError(null);
    setResult(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<DomainVerificationSummary>("domains.verify", {
      organizationId,
      domainId: domain.id,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The domain could not be verified.");
      return;
    }
    setResult(response.data);
  };

  return (
    <Modal
      title="Verify domain"
      open={domain !== null}
      onClose={close}
      footer={
        result ? (
          <Button variant="primary" onClick={onVerified}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy}>
              Verify
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <p className="mono">{domain.hostname}</p>
        {result ? (
          <>
            <VerifiedBadge verified={result.domain.verified} />
            <p>{result.detail}</p>
          </>
        ) : (
          <p>The edge will look for the challenge record you published.</p>
        )}
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** Remove a hostname. */
function RemoveDomainModal({
  organizationId,
  domain,
  onClose,
  onRemoved,
}: {
  readonly organizationId: string;
  readonly domain: DomainSummary | null;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!domain) return null;

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<{ removed: boolean }>("domains.remove", {
      organizationId,
      domainId: domain.id,
    });
    setBusy(false);
    if (!response.ok || !response.data?.removed) {
      setError(response.error?.message ?? "The domain could not be removed.");
      return;
    }
    onRemoved();
  };

  return (
    <Modal
      title="Remove domain"
      open={domain !== null}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} busy={busy}>
            Remove
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          Remove <span className="mono">{domain.hostname}</span>? Traffic to it will stop being
          routed.
        </p>
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ security */

/**
 * A protection level, as the page describes it.
 *
 * The level is client-side vocabulary: it maps to a risk level and an
 * enforcement action that the *same* save form would let an operator pick. The
 * type keeps a glyph, a description and a mapping from drifting apart.
 */
interface ProtectionLevel {
  readonly id: string;
  readonly name: string;
  readonly riskLevel: SecurityPolicySummary["riskLevel"];
  readonly action: SecurityPolicySummary["action"];
  readonly summary: string;
  readonly enables: readonly string[];
}

/**
 * Security.
 *
 * This page reports what the deployment can actually do. The protection levels
 * below are a preview of the vocabulary Cloud Wai compiles; the *policy* is a
 * real row, saved as a draft and activated only when the edge accepts a
 * distribution. Until an edge is wired, the honest answer is "not configured",
 * and nothing here claims a policy is active that the edge never confirmed.
 */
export function SecurityPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const health = useSection(
    () => loadProviderHealth(client, organizationId),
    [client, organizationId],
    "Security engines",
  );
  const policy = useSection(
    () => loadSecurityPolicy(client, organizationId),
    [client, organizationId],
    "Security policy",
  );
  const events = useSection(
    () => loadSecurityPolicyEvents(client, organizationId),
    [client, organizationId],
    "Policy history",
  );
  const [saving, setSaving] = useState(false);
  const [distributing, setDistributing] = useState(false);
  // A level card preselects the risk and action the form opens with; it is a
  // convenience over the same save, never a separate write. Null means "open
  // with the policy's own values".
  const [prefill, setPrefill] = useState<ProtectionLevel | null>(null);

  const current =
    policy.section.state.kind === "ready" ? (policy.section.state.items[0] ?? null) : null;

  // The banner is the deployment's own answer, not a slogan. It used to be a
  // hardcoded "Edge not configured yet." that would keep saying so after an edge
  // was wired. It is derived from `providers.health` — the adapter's report of
  // the security edge — and says which engine it is talking about.
  const edgeConfigured: boolean | null =
    health.section.state.kind === "ready"
      ? health.section.state.items.find((item) => item.provider === "envoy")?.state === "ready"
      : null;

  const levels: readonly ProtectionLevel[] = [
    {
      id: "none",
      name: "None",
      riskLevel: "low",
      action: "allow",
      summary: "No inspection. The origin is reachable directly.",
      enables: ["Host firewall only"],
    },
    {
      id: "normal",
      name: "Normal",
      riskLevel: "medium",
      action: "log",
      summary: "Hidden origin, TLS termination, managed rule set.",
      enables: [
        "Origin hidden behind the edge",
        "TLS termination and HSTS",
        "OWASP Core Rule Set (generic detections)",
        "Access logging",
      ],
    },
    {
      id: "high",
      name: "High",
      riskLevel: "high",
      action: "challenge",
      summary: "Normal plus behaviour-based blocking and rate limits.",
      enables: [
        "Everything in Normal",
        "CrowdSec behavioural signals",
        "Per-route rate limits",
        "Challenge on suspicious traffic",
      ],
    },
    {
      id: "ultimate",
      name: "Ultimate",
      riskLevel: "critical",
      action: "block",
      summary: "High plus advanced anomaly scoring and quarantine.",
      enables: [
        "Everything in High",
        "Anomaly scoring thresholds",
        "Automatic quarantine",
        "Deny direct origin access (gate 6)",
      ],
    },
  ];

  return (
    <PageShell
      title="Security"
      subtitle="Choose a protection level. Cloud Wai compiles it to an edge policy; the edge applies and confirms it. The policy is organization-wide, not per project."
      actions={
        <Button variant="primary" onClick={() => setSaving(true)}>
          {current ? "Edit policy" : "Save policy"}
        </Button>
      }
    >
      <div className="banner" role="status">
        {edgeConfigured === true ? (
          <>
            <strong>Edge configured.</strong>
            <span>
              The security edge engine reports itself ready, so a saved policy can be distributed
              and confirmed by it. The engine status below is the adapter&apos;s report, not an
              assumption.
            </span>
          </>
        ) : edgeConfigured === false ? (
          <>
            <strong>Edge not configured.</strong>
            <span>
              No Envoy/Coraza edge is registered for this deployment, so no policy is compiled or
              claimed as active. Levels below describe what each level enables once an edge is
              wired.
            </span>
          </>
        ) : (
          <>
            <strong>Edge status unknown.</strong>
            <span>
              The engine status could not be read, so whether an edge is configured is unknown. What
              each level enables is described below; nothing here claims a policy is active.
            </span>
          </>
        )}
      </div>

      <SectionShell
        title="Policy"
        hint="Saved as a draft; the edge is what makes it active"
        actions={
          current ? (
            <Button size="sm" onClick={() => setDistributing(true)}>
              Distribute to edge
            </Button>
          ) : undefined
        }
      >
        <Card flush>
          <SectionView<SecurityPolicySummary>
            section={policy.section}
            onRetry={policy.reload}
            emptyMessage="No policy saved yet. Saving writes a draft; the edge activates it."
            columns={[
              { key: "name", header: "Name", render: (item) => item.name },
              {
                key: "riskLevel",
                header: "Risk",
                render: (item) => <span className="mono small">{item.riskLevel}</span>,
              },
              {
                key: "action",
                header: "Action",
                render: (item) => <span className="mono small">{item.action}</span>,
              },
              {
                key: "state",
                header: "State",
                render: (item) => <PolicyStateBadge state={item.state} />,
              },
              {
                key: "version",
                header: "Version",
                render: (item) => <span className="mono small">{item.version}</span>,
              },
              {
                key: "updatedAt",
                header: "Updated",
                render: (item) => <Timestamp value={item.updatedAt} />,
              },
            ]}
            rowKey={(item) => item.id}
          />
        </Card>
      </SectionShell>

      <SectionShell title="Protection level" hint="Selecting a level does not apply it yet">
        <div className="grid">
          {levels.map((level) => (
            <Card key={level.id} title={level.name}>
              <p className="muted small">{level.summary}</p>
              <ul className="small" style={{ margin: "var(--space-3) 0 0", paddingLeft: "1.1rem" }}>
                {level.enables.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              <div style={{ marginTop: "var(--space-4)" }}>
                <Button
                  size="sm"
                  onClick={() => {
                    setPrefill(level);
                    setSaving(true);
                  }}
                  title="Opens the policy form with this level's risk and action; saving writes a draft."
                >
                  Use this level
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </SectionShell>

      <SectionShell title="Engine status" hint="Read from the adapters, not assumed">
        <Card flush>
          <SectionView<ProviderHealthRow>
            section={health.section}
            onRetry={health.reload}
            emptyMessage="No engines reported."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.provider}
                columns={[
                  {
                    key: "provider",
                    header: "Engine",
                    render: (item) => <span className="mono">{item.provider}</span>,
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (item) =>
                      item.state === "ready" ? (
                        <StatusBadge label="Configured" tone="positive" />
                      ) : (
                        <StatusBadge label="Not configured" tone="neutral" />
                      ),
                  },
                  {
                    key: "detail",
                    header: "Detail",
                    render: (item) => <span className="small">{item.detail}</span>,
                  },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>

      <SectionShell
        title="Policy history"
        hint="Every transition the server recorded, including refusals"
      >
        <Card flush>
          <SectionView<SecurityPolicyEventSummary>
            section={events.section}
            onRetry={events.reload}
            emptyMessage="No policy transitions recorded yet."
            columns={[
              {
                key: "toState",
                header: "State",
                render: (item) => <PolicyStateBadge state={item.toState} />,
              },
              {
                key: "from",
                header: "From",
                render: (item) => <span className="mono small">{item.fromState ?? "—"}</span>,
              },
              {
                key: "version",
                header: "Version",
                render: (item) => <span className="mono small">{item.version}</span>,
              },
              {
                key: "detail",
                header: "Detail",
                render: (item) => <span className="small">{item.detail ?? "—"}</span>,
              },
              {
                key: "createdAt",
                header: "When",
                render: (item) => <Timestamp value={item.createdAt} />,
              },
            ]}
            rowKey={(item) => item.id}
          />
        </Card>
      </SectionShell>

      <SavePolicyModal
        // Remount on each open so the form starts from the chosen level or the
        // stored policy, never from a previous visit's keystrokes.
        key={`save-${String(saving)}-${prefill?.id ?? "none"}-${current?.version ?? "new"}`}
        organizationId={organizationId}
        policy={current}
        prefill={prefill}
        open={saving}
        onClose={() => {
          setSaving(false);
          setPrefill(null);
        }}
        onSaved={() => {
          setSaving(false);
          setPrefill(null);
          policy.reload();
          events.reload();
        }}
      />

      <DistributePolicyModal
        organizationId={organizationId}
        policy={current}
        open={distributing}
        onClose={() => setDistributing(false)}
        onDone={() => {
          setDistributing(false);
          policy.reload();
          events.reload();
        }}
      />
    </PageShell>
  );
}

/** A policy's lifecycle. `active` is the edge's answer, never a form's. */
function PolicyStateBadge({ state }: { readonly state: string }) {
  const tone = state === "active" ? "positive" : state === "rejected" ? "danger" : "warning";
  return <StatusBadge label={state} tone={tone} />;
}

/**
 * Save a policy as a draft.
 *
 * The form changes the name, risk level and action only. It cannot set the
 * state: the server always writes `draft`, and the badge afterwards is read back
 * from the server rather than assumed here.
 */
function SavePolicyModal({
  organizationId,
  policy,
  prefill,
  open,
  onClose,
  onSaved,
}: {
  readonly organizationId: string;
  readonly policy: SecurityPolicySummary | null;
  readonly prefill: ProtectionLevel | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const { client } = useApp();
  // A chosen level wins over the stored policy, so "Use this level" actually
  // carries the level the operator clicked. Without one the form opens on the
  // policy's own values.
  const [name, setName] = useState(policy?.name ?? "Default policy");
  const [riskLevel, setRiskLevel] = useState<SecurityPolicySummary["riskLevel"]>(
    prefill?.riskLevel ?? policy?.riskLevel ?? "medium",
  );
  const [action, setAction] = useState<SecurityPolicySummary["action"]>(
    prefill?.action ?? policy?.action ?? "log",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setError(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<SecurityPolicySummary>("security.policy.save", {
      organizationId,
      name,
      riskLevel,
      action,
    });
    setBusy(false);
    if (!response.ok) {
      setError(response.error?.message ?? "The policy could not be saved.");
      return;
    }
    onSaved();
  };

  return (
    <Modal
      title="Save policy"
      open={open}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} busy={busy}>
            Save draft
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name" {...(error ? { error } : {})}>
          {(id) => (
            <TextInput
              id={id}
              value={name}
              onChange={setName}
              placeholder="Default policy"
              error={Boolean(error)}
              autoFocus
            />
          )}
        </Field>
        <Field label="Risk level">
          {(id) => (
            <select
              id={id}
              className="input"
              value={riskLevel}
              onChange={(event) =>
                setRiskLevel(event.target.value as SecurityPolicySummary["riskLevel"])
              }
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          )}
        </Field>
        <Field label="Enforcement action" hint="How the edge treats a matching request.">
          {(id) => (
            <select
              id={id}
              className="input"
              value={action}
              onChange={(event) => setAction(event.target.value as SecurityPolicySummary["action"])}
            >
              <option value="allow">Allow</option>
              <option value="log">Log</option>
              <option value="challenge">Challenge</option>
              <option value="block">Block</option>
              <option value="quarantine">Quarantine</option>
            </select>
          )}
        </Field>
        <p className="muted small">
          Saving writes a draft with a version one higher than the current one. The edge is what
          activates it.
        </p>
      </div>
    </Modal>
  );
}

/**
 * Distribute the policy to the edge.
 *
 * The answer is the adapter's. A not-configured edge is reported as the reason
 * the policy stayed a draft, never as an activation.
 */
function DistributePolicyModal({
  organizationId,
  policy,
  open,
  onClose,
  onDone,
}: {
  readonly organizationId: string;
  readonly policy: SecurityPolicySummary | null;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DistributePolicySummary | null>(null);

  if (!policy) return null;

  const close = () => {
    setError(null);
    setResult(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<DistributePolicySummary>("security.policy.distribute", {
      organizationId,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The policy could not be distributed.");
      return;
    }
    setResult(response.data);
  };

  return (
    <Modal
      title="Distribute policy"
      open={policy !== null && open}
      onClose={close}
      footer={
        result ? (
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy}>
              Distribute
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <p>
          Send <span className="mono">{policy.name}</span> (version {policy.version}) to the edge.
        </p>
        {result ? (
          <>
            <PolicyStateBadge state={result.policy.state} />
            {result.distributed ? (
              <p className="small">The edge accepted the policy and it is now active.</p>
            ) : (
              <p className="muted small">
                {result.engineReason
                  ? `The edge did not apply the policy: ${result.engineReason}`
                  : "The distribution is queued. The edge applies it shortly and the policy becomes active when it does."}
              </p>
            )}
          </>
        ) : (
          <p className="muted small">
            The edge confirms its own version; a lower version is refused before the call.
          </p>
        )}
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ activity */

export function ActivityPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadAudit(client, organizationId),
    [client, organizationId],
    "Recent activity",
  );

  return (
    <PageShell
      title="Activity"
      subtitle="An append-only record. No role can edit or delete an entry."
    >
      <Card flush>
        <SectionView<AuditSummary>
          section={section}
          onRetry={reload}
          emptyMessage="Nothing recorded yet."
          renderReady={(items) => (
            <Table
              items={items}
              rowKey={(item) => item.id}
              filterText={(item) => `${item.event} ${item.actorEmail ?? ""}`}
              filterLabel="Filter activity"
              columns={[
                {
                  key: "event",
                  header: "Event",
                  render: (item) => <span className="mono small">{item.event}</span>,
                },
                { key: "actor", header: "Actor", render: (item) => item.actorEmail ?? "—" },
                {
                  key: "when",
                  header: "When",
                  render: (item) => <Timestamp value={item.createdAt} />,
                },
              ]}
            />
          )}
        />
      </Card>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ billing */

/**
 * Billing.
 *
 * An organization-level roll-up of what the engines actually reported, read
 * from `usage_records`. Every number shown is a real recorded quantity, so an
 * empty organization says "no usage recorded yet" rather than rendering a fake
 * zero-balance card. The page makes no claim about money: it reports usage, and
 * the invoice side is a contract the deployment has not wired yet.
 */
export function BillingPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadUsage(client, organizationId),
    [client, organizationId],
    "Usage",
  );

  const totals = section.state.kind === "ready" ? section.state.items : [];
  const grandTotal = totals.reduce((sum, item) => sum + item.total, 0);

  return (
    <PageShell
      title="Billing"
      subtitle="Usage recorded for this organization. Every figure comes from an engine's own report."
    >
      <SectionShell title="Recorded usage" hint="Grouped by metric, newest first">
        <div className="stat-grid">
          <StatBox label="Metrics" value={String(totals.length)} />
          <StatBox label="Records" value={String(totals.reduce((s, t) => s + t.records, 0))} />
          <StatBox label="Total quantity" value={String(grandTotal)} />
        </div>
        <Card flush>
          <SectionView<UsageTotalSummary>
            section={section}
            onRetry={reload}
            emptyMessage="No usage has been recorded for this organization. No engine in this deployment reports a usage metric yet, so this list stays empty until one is wired."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.metric}
                columns={[
                  {
                    key: "metric",
                    header: "Metric",
                    render: (item) => <span className="mono small">{item.metric}</span>,
                  },
                  {
                    key: "total",
                    header: "Total",
                    render: (item) => <span className="mono">{String(item.total)}</span>,
                  },
                  {
                    key: "records",
                    header: "Records",
                    render: (item) => String(item.records),
                  },
                  {
                    key: "last",
                    header: "Last recorded",
                    render: (item) =>
                      item.lastRecordedAt ? (
                        <Timestamp value={item.lastRecordedAt} />
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>

      <SectionShell title="Invoicing" hint="Not wired in this deployment">
        <Card>
          <p className="small" style={{ margin: 0 }}>
            Usage above is real. Payment collection and invoices need a billing provider this
            deployment has not configured, so there is nothing to pay here yet — and no placeholder
            balance is shown in its place.
          </p>
        </Card>
      </SectionShell>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ API keys */

export function ApiKeysPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadApiKeys(client, organizationId),
    [client, organizationId],
    "API keys",
  );
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeySummaryRow | null>(null);

  return (
    <PageShell
      title="API keys"
      subtitle="A key's secret is shown once, at creation, and stored only as a hash. This list can never contain it."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          Create key
        </Button>
      }
    >
      <Card flush>
        <SectionView<ApiKeySummaryRow>
          section={section}
          columns={[
            { key: "name", header: "Name", render: (item) => item.name },
            {
              key: "prefix",
              header: "Prefix",
              render: (item) => <span className="mono small">{item.keyPrefix}</span>,
            },
            {
              key: "scopes",
              header: "Scopes",
              render: (item) => <span className="small">{item.scopes.join(", ") || "—"}</span>,
            },
            {
              key: "state",
              header: "State",
              render: (item) => <ApiKeyStateBadge revokedAt={item.revokedAt} />,
            },
            {
              key: "actions",
              header: "",
              render: (item) =>
                item.revokedAt ? (
                  <span className="small muted">—</span>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(item)}>
                    Revoke
                  </Button>
                ),
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="No API keys yet."
        />
      </Card>

      <CreateApiKeyModal
        organizationId={organizationId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          reload();
        }}
      />

      <RevokeApiKeyModal
        organizationId={organizationId}
        apiKey={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={() => {
          setRevoking(null);
          reload();
        }}
      />
    </PageShell>
  );
}

/**
 * The secret is rendered here and nowhere else.
 *
 * It arrives on the create response, is shown once in a block the operator can
 * copy, and is dropped from component state when the dialog closes. No list, no
 * reload and no audit row ever carries it.
 */
function CreateApiKeyModal({
  organizationId,
  open,
  onClose,
  onCreated,
}: {
  readonly organizationId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const { client } = useApp();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedApiKey | null>(null);

  const reset = () => {
    setName("");
    setScopes([]);
    setError(null);
    setIssued(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<IssuedApiKey>("apiKeys.create", {
      organizationId,
      name,
      scopes,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The key could not be created.");
      return;
    }
    setIssued(response.data);
  };

  const close = () => {
    // The secret leaves state when the dialog does; there is no second chance.
    reset();
    onClose();
  };

  return (
    <Modal
      title={issued ? "Key created" : "Create API key"}
      open={open}
      onClose={close}
      footer={
        issued ? (
          <Button variant="primary" onClick={onCreated}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" onClick={() => void submit()} busy={busy} disabled={!name}>
              Create
            </Button>
          </>
        )
      }
    >
      {issued ? (
        <div className="stack">
          <p className="small">
            Copy this secret now. It is shown once and cannot be retrieved again — Cloud Wai stores
            only its hash.
          </p>
          <Field label="Secret">
            {(id) => <TextInput id={id} value={issued.secret} onChange={() => {}} />}
          </Field>
          {issued.key.scopes.length !== scopes.length ? (
            <p className="small muted">
              Granted scopes were narrowed to what your role allows:{" "}
              <span className="mono">{issued.key.scopes.join(", ") || "none"}</span>
            </p>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <Field label="Name" hint="What this key is for." {...(error ? { error } : {})}>
            {(id) => (
              <TextInput
                id={id}
                value={name}
                onChange={setName}
                placeholder="ci-deploy"
                error={Boolean(error)}
              />
            )}
          </Field>
          <fieldset className="field">
            <legend className="field__label">Scopes</legend>
            <div className="stack" style={{ gap: "var(--space-2)" }}>
              {API_KEY_SCOPES.map((scope) => (
                <label key={scope} className="row small">
                  <input
                    type="checkbox"
                    aria-label={scope}
                    checked={scopes.includes(scope)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, scope]
                          : current.filter((s) => s !== scope),
                      )
                    }
                  />
                  <span className="mono">{scope}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="small muted">
            Leave every scope unchecked to request none. The server narrows the request to your role
            before storing the key.
          </p>
        </div>
      )}
    </Modal>
  );
}

function RevokeApiKeyModal({
  organizationId,
  apiKey,
  onClose,
  onRevoked,
}: {
  readonly organizationId: string;
  readonly apiKey: ApiKeySummaryRow | null;
  readonly onClose: () => void;
  readonly onRevoked: () => void;
}) {
  const { client } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!apiKey) return;
    setBusy(true);
    setError(null);
    const response = await client.call<{ revoked: boolean }>("apiKeys.revoke", {
      organizationId,
      keyId: apiKey.id,
    });
    setBusy(false);
    if (!response.ok || !response.data?.revoked) {
      setError(response.error?.message ?? "The key could not be revoked.");
      return;
    }
    onRevoked();
  };

  return (
    <Modal
      title="Revoke API key"
      open={apiKey !== null}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} busy={busy} disabled={!apiKey}>
            Revoke
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          Revoking <span className="mono">{apiKey?.name}</span> takes effect immediately and cannot
          be undone. The key is kept in this list so the record survives.
        </p>
        {error ? (
          <p className="small" role="alert" style={{ color: "var(--danger-text, #f88)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ settings */

export function SettingsPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const organization = useSection(
    () => loadOrganization(client, organizationId),
    [client, organizationId],
    "Organization",
  );
  const health = useSection(
    () => loadProviderHealth(client, organizationId),
    [client, organizationId],
    "Engine status",
  );
  const members = useSection(
    () => loadOrganizationMembers(client, organizationId),
    [client, organizationId],
    "Members",
  );

  const org =
    organization.section.state.kind === "ready" ? organization.section.state.items[0] : undefined;

  return (
    <PageShell
      title="Settings"
      subtitle="Organization profile and the engines this deployment can act on."
    >
      <SectionShell title="Organization">
        <Card>
          {organization.section.state.kind === "loading" ? (
            <LoadingSkeleton title="Organization" />
          ) : org ? (
            <dl className="dl">
              <dt>Name</dt>
              <dd>{org.name}</dd>
              <dt>Slug</dt>
              <dd className="mono">{org.slug}</dd>
              <dt>Id</dt>
              <dd className="mono small">{org.id}</dd>
            </dl>
          ) : (
            <SectionView<OrganizationSummary>
              section={organization.section}
              onRetry={organization.reload}
            />
          )}
        </Card>
      </SectionShell>

      <SectionShell
        title="Members"
        hint="Everyone with access to this organization, and the role that decides what they can do"
      >
        <Card flush>
          <SectionView<OrganizationMemberSummary>
            section={members.section}
            rowKey={(item) => item.userId}
            onRetry={members.reload}
            emptyMessage="This organization has no members recorded."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.userId}
                filterText={(item) =>
                  `${item.displayName ?? ""} ${item.email ?? ""} ${item.role}`
                }
                filterLabel="Filter members"
                columns={[
                  {
                    key: "member",
                    header: "Member",
                    render: (item) => (
                      <span>{item.displayName ?? item.email ?? "Not yet signed in"}</span>
                    ),
                  },
                  {
                    key: "email",
                    header: "Email",
                    render: (item) =>
                      item.email ? (
                        <span className="mono small">{item.email}</span>
                      ) : (
                        <span className="faint">—</span>
                      ),
                  },
                  {
                    key: "role",
                    header: "Role",
                    render: (item) => <StatusBadge label={roleLabel(item.role)} tone="neutral" />,
                  },
                  {
                    key: "since",
                    header: "Added",
                    render: (item) => <Timestamp value={item.createdAt} />,
                  },
                ]}
              />
            )}
          />
        </Card>
        <p className="muted small" style={{ marginTop: "var(--space-3)" }}>
          Inviting, changing and removing members is not wired in this build. The list above is real
          membership data; the controls would be here once the invite procedure exists.
        </p>
      </SectionShell>

      <SectionShell
        title="Engine status"
        hint="An engine with no credentials reports not configured"
      >
        <Card flush>
          <SectionView<ProviderHealthRow>
            section={health.section}
            onRetry={health.reload}
            emptyMessage="No engines reported."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.provider}
                columns={[
                  {
                    key: "provider",
                    header: "Engine",
                    render: (item) => <span className="mono">{item.provider}</span>,
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (item) =>
                      item.state === "ready" ? (
                        <StatusBadge label="Configured" tone="positive" />
                      ) : (
                        <StatusBadge label="Not configured" tone="neutral" />
                      ),
                  },
                  {
                    key: "detail",
                    header: "Detail",
                    render: (item) => <span className="small">{item.detail}</span>,
                  },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>

      <SectionShell title="Release gates" hint="What still needs a real server">
        <Card>
          <ul className="small" style={{ margin: 0, paddingLeft: "1.1rem" }}>
            <li>Deny direct origin access — needs a deployed edge.</li>
            <li>Block CRS attacks — needs Envoy/Coraza on a real VPS.</li>
            <li>Tenant runtime isolation — needs a container runtime.</li>
            <li>Verified backup restore — needs Postgres/MinIO credentials.</li>
          </ul>
        </Card>
      </SectionShell>
    </PageShell>
  );
}

/** A membership role, spelled for a reader. */
function roleLabel(role: OrganizationMemberSummary["role"]): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "member":
      return "Member";
    case "viewer":
      return "Viewer";
  }
}

/* ------------------------------------------------------------------ not found */

export function NotFoundPage({ path }: { readonly path: string }) {
  return (
    <PageShell title="Not found" subtitle={`No route matches ${path}.`}>
      <EmptyState
        title="Nothing here"
        message="The address does not match any section. Use the sidebar or the command palette to navigate."
      />
    </PageShell>
  );
}

export type { Route };
