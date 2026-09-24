/**
 * The Database section.
 *
 * This is the third drill-in level (Workspace -> Project -> Database). The
 * sidebar for it comes from `databaseNav`, and the route decides which
 * sub-page is showing, so every sub-page is its own URL.
 *
 * What is rendered here is honest about what exists. The rows below the
 * Overview are read through the same `data.list` procedure as before;
 * provisioning and backup call the real `data.provision` and `data.backup`
 * procedures, and the state they show is always the engine's answer. A
 * sub-page that needs a procedure the API does not have yet says so explicitly
 * and offers no control that pretends otherwise. Nothing here reports success
 * for work the platform has not performed.
 */
import { useState } from "react";
import {
  Button,
  Card,
  Field,
  Modal,
  ready,
  SectionShell,
  SectionView,
  StatBox,
  TextInput,
} from "@cloud-wai/ui/react";
import { useApp } from "../react/context.js";
import { useSection } from "../react/hooks.js";
import type { DatabaseSection } from "../routes.js";
import {
  loadDataBackups,
  loadDataResources,
  type BackupDataSummary,
  type DataBackupSummary,
  type DataResourceSummary,
  type ProvisionDataSummary,
} from "../view-model.js";
import { DataStateBadge, Timestamp } from "../components/page-parts.js";
import { ComingSoon } from "../components/app-shell.js";
import { databaseSectionTitle } from "../navigation.js";

/**
 * The sub-pages of this section.
 *
 * `implemented` is the one place that decides whether a section has a working
 * body or an honest placeholder, so the sidebar and the page cannot disagree.
 * It flips to true as each step of the phased plan lands.
 */
const SECTION_BODIES: Readonly<Record<DatabaseSection, boolean>> = {
  overview: true,
  tables: false,
  sql: false,
  auth: false,
  storage: false,
  api: false,
  roles: false,
  logs: false,
  settings: false,
};

function NotYetBuilt({ section }: { readonly section: DatabaseSection }) {
  return (
    <Card>
      <div className="banner" role="status">
        <strong>{databaseSectionTitle(section)} is not available in this build yet.</strong>
        <span>
          The route exists so a link to it is honest, and the section is planned. It will read from
          the configured database engine once that step is delivered — it is not wired to a fake in
          the meantime.
        </span>
      </div>
    </Card>
  );
}

function DatabaseOverview({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const resources = useSection(
    () => loadDataResources(client, organizationId),
    [client, organizationId],
    "Databases and storage",
  );
  const [provisioning, setProvisioning] = useState(false);
  const [backingUp, setBackingUp] = useState<DataResourceSummary | null>(null);

  const reload = resources.reload;
  // This page is project-scoped. Show this project's resources plus any
  // organization-wide ones, and never another project's: a resource created
  // from project A must not appear on project B's Database page.
  const visibleItems =
    resources.section.state.kind === "ready"
      ? resources.section.state.items.filter(
          (item) => item.projectId == null || item.projectId === projectId,
        )
      : [];
  const visibleResources =
    resources.section.state.kind === "ready"
      ? ready("Databases and storage", visibleItems)
      : resources.section;

  return (
    <>
      <SectionShell title="Project" hint="What this database section is attached to">
        <div className="grid">
          <StatBox label="Tables" value="—" note="Needs a configured database engine." />
          <StatBox label="Storage buckets" value="—" note="Needs a configured database engine." />
          <StatBox label="Auth users" value="—" note="Needs a configured database engine." />
        </div>
      </SectionShell>

      <SectionShell
        title="Resources"
        hint="Provisioning runs through the database engine"
        actions={
          <Button variant="primary" size="sm" onClick={() => setProvisioning(true)}>
            Provision resource
          </Button>
        }
      >
        <Card flush>
          <SectionView<DataResourceSummary>
            section={visibleResources}
            columns={[
              { key: "name", header: "Name", render: (item) => item.name },
              {
                key: "kind",
                header: "Kind",
                render: (item) => <span className="mono small">{item.kind}</span>,
              },
              {
                key: "scope",
                header: "Scope",
                render: (item) =>
                  item.projectId ? (
                    <span className="small">This project</span>
                  ) : (
                    <span className="small muted">Organization-wide</span>
                  ),
              },
              {
                key: "state",
                header: "State",
                render: (item) => <DataStateBadge state={item.state} />,
              },
              {
                key: "actions",
                header: "",
                render: (item) => (
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <Button
                      size="sm"
                      // A resource that is not ready has no engine handle, and a
                      // bucket has no backup path in this build; the server refuses
                      // both. Disabling says so before the call.
                      disabled={item.state !== "ready" || item.kind !== "postgres"}
                      title={
                        item.kind !== "postgres"
                          ? "Backing up an object-storage bucket is not available yet."
                          : item.state === "ready"
                            ? "Take a backup"
                            : "A resource must be ready before it can be backed up."
                      }
                      onClick={() => setBackingUp(item)}
                    >
                      Back up
                    </Button>
                  </div>
                ),
              },
            ]}
            rowKey={(item) => item.id}
            onRetry={reload}
            emptyMessage="No database resources for this project. Provisioning needs a configured database engine."
          />
        </Card>
      </SectionShell>

      <ProvisionResourceModal
        organizationId={organizationId}
        projectId={projectId}
        open={provisioning}
        onClose={() => setProvisioning(false)}
        onDone={() => {
          setProvisioning(false);
          reload();
        }}
      />

      <BackupResourceModal
        organizationId={organizationId}
        resource={backingUp}
        onClose={() => setBackingUp(null)}
        onDone={() => {
          setBackingUp(null);
          reload();
        }}
      />

      <SectionShell title="Connection" hint="Search path, roles and extensions">
        <Card>
          <p className="muted small">
            Connection details appear once a database engine is configured for this deployment.
          </p>
          <div className="row">
            <ComingSoon label="Add Project" />
            <ComingSoon label="Add custom database" />
          </div>
        </Card>
      </SectionShell>
    </>
  );
}

/**
 * Provision a resource.
 *
 * The engine's answer is what the dialog reports: a `not_configured` engine is
 * shown as the reason no resource was created, not as an operator mistake. The
 * created row's state is the engine's, and the list behind is reloaded so the
 * badge comes from the server rather than from this form.
 */
function ProvisionResourceModal({
  organizationId,
  projectId,
  open,
  onClose,
  onDone,
}: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { client } = useApp();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"postgres" | "object_storage">("postgres");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProvisionDataSummary | null>(null);

  const close = () => {
    setName("");
    setError(null);
    setResult(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<ProvisionDataSummary>("data.provision", {
      organizationId,
      projectId,
      name,
      kind,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The resource could not be provisioned.");
      return;
    }
    setResult(response.data);
  };

  return (
    <Modal
      title={result ? "Resource registered" : "Provision resource"}
      open={open}
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
              Provision
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="stack">
          <DataStateBadge state={result.resource.state} />
          {result.engineReason ? (
            <p>
              The engine did not provision this resource:{" "}
              <span className="muted">{result.engineReason}</span>
            </p>
          ) : (
            <p>The engine provisioned this resource and confirmed it.</p>
          )}
        </div>
      ) : (
        <div className="stack">
          <Field
            label="Name"
            hint="A Cloud Wai name; the engine's own handle is recorded separately."
            {...(error ? { error } : {})}
          >
            {(id) => (
              <TextInput
                id={id}
                value={name}
                onChange={setName}
                placeholder="tenant-db"
                error={Boolean(error)}
                autoFocus
              />
            )}
          </Field>
          <Field label="Kind">
            {(id) => (
              <select
                id={id}
                className="input"
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value === "object_storage" ? "object_storage" : "postgres")
                }
              >
                <option value="postgres">PostgreSQL database</option>
                <option value="object_storage">Object storage bucket</option>
              </select>
            )}
          </Field>
        </div>
      )}
    </Modal>
  );
}

/**
 * Back up a resource.
 *
 * The answer is the adapter's: a missing engine handle is refused before the
 * call, and a `not_configured` database engine is reported as the reason rather
 * than as a completed backup.
 */
function BackupResourceModal({
  organizationId,
  resource,
  onClose,
  onDone,
}: {
  readonly organizationId: string;
  readonly resource: DataResourceSummary | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackupDataSummary | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);

  const resourceId = resource?.id ?? "";
  const history = useSection(
    () =>
      resourceId
        ? loadDataBackups(client, organizationId, resourceId)
        : Promise.resolve(ready<DataBackupSummary>("Backups", [])),
    [client, organizationId, resourceId, historyNonce],
    "Backups",
  );

  if (!resource) return null;

  const close = () => {
    setError(null);
    setResult(null);
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<BackupDataSummary>("data.backup", {
      organizationId,
      resourceId: resource.id,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The backup could not be taken.");
      return;
    }
    setResult(response.data);
    setHistoryNonce((value) => value + 1);
  };

  return (
    <Modal
      title="Back up resource"
      open={resource !== null}
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
              Back up
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <p>
          Take a backup of <span className="mono">{resource.name}</span>.
        </p>
        {result ? (
          <>
            <span>
              <DataStateBadge state={result.backup.status} />
            </span>
            {result.engineReason ? (
              <p className="muted small">
                The engine did not complete the backup: {result.engineReason}
              </p>
            ) : result.backup.status === "pending" || result.backup.status === "running" ? (
              <p className="muted small">
                The backup is queued. The engine reports its own result here when it finishes.
              </p>
            ) : (
              <p className="small">The engine returned a backup reference.</p>
            )}
          </>
        ) : (
          <p className="muted small">The engine takes the backup and reports its own result.</p>
        )}
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <h2 className="small" style={{ marginBottom: "var(--space-2)" }}>
            Backup history
          </h2>
          <SectionView<DataBackupSummary>
            section={history.section}
            onRetry={history.reload}
            emptyMessage="No backups recorded for this resource yet."
            columns={[
              {
                key: "status",
                header: "Status",
                render: (item) => <DataStateBadge state={item.status} />,
              },
              {
                key: "createdAt",
                header: "Started",
                render: (item) => <Timestamp value={item.createdAt} />,
              },
              {
                key: "finishedAt",
                header: "Finished",
                render: (item) =>
                  item.finishedAt ? (
                    <Timestamp value={item.finishedAt} />
                  ) : (
                    <span className="faint">—</span>
                  ),
              },
            ]}
            rowKey={(item) => item.id}
          />
        </div>
      </div>
    </Modal>
  );
}

export function DatabasePage({
  organizationId,
  projectId,
  section,
}: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly section: DatabaseSection;
}) {
  const title = databaseSectionTitle(section);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{title}</h1>
          <p className="page__sub">
            {section === "overview"
              ? "Databases, tables, storage and authentication for this project."
              : `${title} for this project's database.`}
          </p>
        </div>
      </header>

      {SECTION_BODIES[section] ? (
        <DatabaseOverview organizationId={organizationId} projectId={projectId} />
      ) : (
        <NotYetBuilt section={section} />
      )}
    </div>
  );
}
