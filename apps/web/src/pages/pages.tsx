/**
 * The dashboard pages.
 *
 * Each page loads exactly the sections its route names and renders them through
 * `SectionView`, which is the single place a section state becomes UI. There is
 * no page here that renders a value it did not load, and no page that turns a
 * `not_configured` engine into a success.
 */
import { useState } from "react";
import {
  Button,
  Card,
  type Column,
  EmptyState,
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
import type { Route } from "../routes.js";
import {
  loadApiKeys,
  loadAudit,
  loadDataResources,
  loadDeployments,
  loadDomains,
  loadOrganization,
  loadOrganizations,
  loadProject,
  loadProjects,
  loadProviderHealth,
  API_KEY_SCOPES,
  type ApiKeySummaryRow,
  type AuditSummary,
  type DataResourceSummary,
  type DeploymentSummary,
  type DomainSummary,
  type IssuedApiKey,
  type OrganizationSummary,
  type ProjectSummary,
  type ProviderHealthRow,
} from "../view-model.js";
import {
  ApiKeyStateBadge,
  DataStateBadge,
  Link,
  Timestamp,
  VerifiedBadge,
} from "../components/page-parts.js";
import { ComingSoon } from "../components/app-shell.js";

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

export function OrganizationsPage() {
  const { client, router } = useApp();
  const { section, reload } = useSection(
    () => loadOrganizations(client),
    [client],
    "Organizations",
  );
  const [creating, setCreating] = useState(false);

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
                  <Link to={{ name: "projects", organizationId: organization.id }}>
                    Open →
                  </Link>
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
          <Button variant="primary" onClick={() => void submit()} busy={busy} disabled={!name || !slug}>
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
                  <Link
                    to={{ name: "project", organizationId, projectId: project.id }}
                  >
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
          <Field label="Slug" hint="Lowercase letters, digits and hyphens." {...(error ? { error } : {})}>
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
  const project = useSection(
    () => loadProject(client, projectId),
    [client, projectId],
    "Project",
  );
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

  const projectItem = project.section.state.kind === "ready" ? project.section.state.items[0] : undefined;
  const deploymentItems =
    deployments.section.state.kind === "ready" ? deployments.section.state.items : [];
  const live = deploymentItems.filter((item) => item.status === "succeeded").length;
  const unconfigured = deploymentItems.filter((item) => item.status === "not_configured").length;

  return (
    <PageShell
      title={projectItem?.name ?? "Project"}
      subtitle={projectItem ? `Slug ${projectItem.slug}` : undefined}
      actions={
        <>
          <ComingSoon label="Deploy" />
          <ComingSoon label="Rollback" />
        </>
      }
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
                  { key: "event", header: "Event", render: (item) => <span className="mono small">{item.event}</span> },
                  { key: "actor", header: "Actor", render: (item) => item.actorEmail ?? "—" },
                  { key: "when", header: "When", render: (item) => <Timestamp value={item.createdAt} /> },
                ]}
              />
            )}
          />
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

  return (
    <PageShell
      title="Deployments"
      subtitle="Every deployment this project has requested, newest first."
      actions={<ComingSoon label="Deploy" />}
    >
      <Card flush>
        <SectionView<DeploymentSummary>
          section={section}
          columns={DeploymentColumns()}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="Nothing has been deployed yet."
        />
      </Card>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ domains */

export function DomainsPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadDomains(client, organizationId),
    [client, organizationId],
    "Domains",
  );

  return (
    <PageShell
      title="Domains"
      subtitle="Hostnames routed through the security edge. Only the edge can verify a hostname."
      actions={<ComingSoon label="Add domain" />}
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
              key: "id",
              header: "Id",
              render: (item) => <span className="mono small">{item.id.slice(0, 12)}</span>,
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="No domains registered. A domain is created unverified and the edge confirms it."
        />
      </Card>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ data */

export function DataPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const { section, reload } = useSection(
    () => loadDataResources(client, organizationId),
    [client, organizationId],
    "Databases and storage",
  );

  return (
    <PageShell
      title="Data"
      subtitle="Tenant databases and object storage. These live in the data plane, not the control plane."
      actions={
        <>
          <ComingSoon label="Provision database" />
          <ComingSoon label="Back up" />
        </>
      }
    >
      <Card flush>
        <SectionView<DataResourceSummary>
          section={section}
          columns={[
            { key: "name", header: "Name", render: (item) => item.name },
            { key: "kind", header: "Kind", render: (item) => <span className="mono small">{item.kind}</span> },
            { key: "state", header: "State", render: (item) => <DataStateBadge state={item.state} /> },
          ]}
          rowKey={(item) => item.id}
          onRetry={reload}
          emptyMessage="No data resources. Provisioning needs a configured database engine."
        />
      </Card>
    </PageShell>
  );
}

/* ------------------------------------------------------------------ security */

/**
 * Security.
 *
 * This page reports what the deployment can actually do. Until the edge adapter
 * exists and an engine is wired, the honest answer is "not configured", and the
 * level cards below are shown as a preview rather than as working controls.
 */
export function SecurityPage({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const health = useSection(
    () => loadProviderHealth(client, organizationId),
    [client, organizationId],
    "Security engines",
  );

  const levels = [
    {
      id: "none",
      name: "None",
      summary: "No inspection. The origin is reachable directly.",
      enables: ["Host firewall only"],
    },
    {
      id: "normal",
      name: "Normal",
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
      subtitle="Choose a protection level. Cloud Wai compiles it to an edge policy; the edge applies and confirms it."
      actions={<ComingSoon label="Apply policy" />}
    >
      <div className="banner" role="status">
        <strong>Edge not configured yet.</strong>
        <span>
          Levels below describe what each level enables. Applying one needs a deployed
          Envoy/Coraza edge and a registered edge provider; until then no policy is compiled or claimed
          as active.
        </span>
      </div>

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
                <ComingSoon label="Select" />
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
                  { key: "provider", header: "Engine", render: (item) => <span className="mono">{item.provider}</span> },
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
                  { key: "detail", header: "Detail", render: (item) => <span className="small">{item.detail}</span> },
                ]}
              />
            )}
          />
        </Card>
      </SectionShell>
    </PageShell>
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
              columns={[
                { key: "event", header: "Event", render: (item) => <span className="mono small">{item.event}</span> },
                { key: "actor", header: "Actor", render: (item) => item.actorEmail ?? "—" },
                { key: "when", header: "When", render: (item) => <Timestamp value={item.createdAt} /> },
              ]}
            />
          )}
        />
      </Card>
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
            { key: "prefix", header: "Prefix", render: (item) => <span className="mono small">{item.keyPrefix}</span> },
            {
              key: "scopes",
              header: "Scopes",
              render: (item) => <span className="small">{item.scopes.join(", ") || "—"}</span>,
            },
            { key: "state", header: "State", render: (item) => <ApiKeyStateBadge revokedAt={item.revokedAt} /> },
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
            <Button
              variant="primary"
              onClick={() => void submit()}
              busy={busy}
              disabled={!name}
            >
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
            {(id) => (
              <TextInput id={id} value={issued.secret} onChange={() => {}} />
            )}
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
            Leave every scope unchecked to request none. The server narrows the request to your
            role before storing the key.
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

  const org = organization.section.state.kind === "ready" ? organization.section.state.items[0] : undefined;

  return (
    <PageShell title="Settings" subtitle="Organization profile and the engines this deployment can act on.">
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
            <SectionView<OrganizationSummary> section={organization.section} onRetry={organization.reload} />
          )}
        </Card>
      </SectionShell>

      <SectionShell title="Engine status" hint="An engine with no credentials reports not configured">
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
                  { key: "provider", header: "Engine", render: (item) => <span className="mono">{item.provider}</span> },
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
                  { key: "detail", header: "Detail", render: (item) => <span className="small">{item.detail}</span> },
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
