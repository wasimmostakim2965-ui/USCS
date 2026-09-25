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
import { useState, type ReactElement } from "react";
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
  loadDataRestores,
  type BackupDataSummary,
  type DataBackupSummary,
  type DataResourceSummary,
  type DataRestoreSummary,
  type ProvisionDataSummary,
  type RestoreDataSummary,
  type RotateCredentialsSummary,
} from "../view-model.js";
import { DataStateBadge, Timestamp } from "../components/page-parts.js";

import { databaseSectionTitle } from "../navigation.js";

/**
 * The sub-pages of this section, keyed by section.
 *
 * A section maps to the component that renders it, so the route cannot render
 * the wrong body. The previous shape was a boolean `implemented` flag plus one
 * hard-coded component, which meant any section flagged true rendered the
 * Storage page — harmless only while Storage was the single flagged section, and
 * a silent bug the first time another one was flipped.
 *
 * Overview and Storage are real: both read the same `data.list` rows and both
 * provision through the engine. The rest need an engine operation this build's
 * adapter interface does not expose yet — introspecting tables, running SQL,
 * listing auth users — so they stay honest placeholders rather than screens
 * wired to a fake.
 */
const SECTION_COMPONENT: Partial<
  Record<
    DatabaseSection,
    (props: { readonly organizationId: string; readonly projectId: string }) => ReactElement
  >
> = {
  overview: DatabaseOverview,
  storage: DatabaseStorage,
};
/**
 * What a section that is not built yet actually needs.
 *
 * Naming the missing engine operation is the honest form of "coming soon": it
 * says the route is real, the plan is real, and exactly which engine capability
 * is absent, rather than implying the feature is a styling task.
 */
const NOT_YET_REASON: Partial<Record<DatabaseSection, string>> = {
  tables:
    "Browsing and editing rows needs a table-introspection operation on the database engine, which this build's adapter interface does not expose yet.",
  sql: "Running SQL needs a query-execution operation on the database engine, which this build's adapter interface does not expose yet.",
  auth: "Users, sessions and providers need an auth-user listing operation on the database engine, which this build's adapter interface does not expose yet.",
  api: "The REST endpoint list is generated from the schema, so it needs the same table-introspection operation the Table Editor does.",
  roles:
    "Roles and extensions need a role-introspection operation on the database engine, which this build's adapter interface does not expose yet.",
  logs: "Database and API logs need a log-stream operation on the database engine, which this build's adapter interface does not expose yet.",
  settings:
    "Engine-level settings need a configuration operation on the database engine, which this build's adapter interface does not expose yet.",
};

function NotYetBuilt({ section }: { readonly section: DatabaseSection }) {
  return (
    <Card>
      <div className="banner" role="status">
        <strong>{databaseSectionTitle(section)} is not available in this build yet.</strong>
        <span>
          {NOT_YET_REASON[section] ??
            "The route exists so a link to it is honest, and the section is planned."}{" "}
          It is not wired to a fake in the meantime.
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
  return (
    <>
      <SectionShell title="Project" hint="What this database section is attached to">
        <div className="grid">
          <StatBox label="Tables" value="—" note="Needs a configured database engine." />
          <StatBox label="Storage buckets" value="—" note="Needs a configured database engine." />
          <StatBox label="Auth users" value="—" note="Needs a configured database engine." />
        </div>
      </SectionShell>

      <ResourcesPanel
        organizationId={organizationId}
        projectId={projectId}
        kinds="all"
        title="Resources"
        hint="Provisioning runs through the database engine"
        emptyMessage="No database resources for this project. Provisioning needs a configured database engine."
      />

      <SectionShell title="Connection" hint="Search path, roles and extensions">
        <Card>
          <p className="muted small">
            Connection details appear once a database engine is configured for this deployment.
          </p>
        </Card>
      </SectionShell>
    </>
  );
}

/**
 * The project's data resources, filtered to one kind.
 *
 * Overview and Storage show the same rows through this one component: the
 * Storage page is not a second list that could drift from the first, it is the
 * bucket half of the same query.
 */
function ResourcesPanel({
  organizationId,
  projectId,
  kinds,
  title,
  hint,
  emptyMessage,
}: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly kinds: "all" | "postgres" | "object_storage";
  readonly title: string;
  readonly hint: string;
  readonly emptyMessage: string;
}) {
  const { client } = useApp();
  const resources = useSection(
    () => loadDataResources(client, organizationId),
    [client, organizationId],
    "Databases and storage",
  );
  const [provisioning, setProvisioning] = useState(false);
  const [backingUp, setBackingUp] = useState<DataResourceSummary | null>(null);
  const [restoring, setRestoring] = useState<DataResourceSummary | null>(null);
  const [rotating, setRotating] = useState<DataResourceSummary | null>(null);

  const reload = resources.reload;
  // This page is project-scoped. Show this project's resources plus any
  // organization-wide ones, and never another project's: a resource created
  // from project A must not appear on project B's Database page.
  const visibleItems =
    resources.section.state.kind === "ready"
      ? resources.section.state.items.filter(
          (item) =>
            (item.projectId == null || item.projectId === projectId) &&
            (kinds === "all" || item.kind === kinds),
        )
      : [];
  const visibleResources =
    resources.section.state.kind === "ready" ? ready(title, visibleItems) : resources.section;

  return (
    <>
      <SectionShell
        title={title}
        hint={hint}
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
                  <div
                    style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}
                  >
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
                    <Button
                      size="sm"
                      disabled={item.state !== "ready" || item.kind !== "postgres"}
                      title={
                        item.kind !== "postgres"
                          ? "Restoring an object-storage bucket is not available yet."
                          : item.state === "ready"
                            ? "Restore from a backup"
                            : "A resource must be ready before it can be restored."
                      }
                      onClick={() => setRestoring(item)}
                    >
                      Restore
                    </Button>
                    <Button
                      size="sm"
                      disabled={item.state !== "ready" || item.kind !== "postgres"}
                      title={
                        item.kind !== "postgres"
                          ? "Rotating a bucket's credentials is not available yet."
                          : item.state === "ready"
                            ? "Rotate this database's credentials"
                            : "A resource must be ready before its credentials can be rotated."
                      }
                      onClick={() => setRotating(item)}
                    >
                      Rotate credentials
                    </Button>
                  </div>
                ),
              },
            ]}
            rowKey={(item) => item.id}
            onRetry={reload}
            emptyMessage={emptyMessage}
          />
        </Card>
      </SectionShell>

      <ProvisionResourceModal
        organizationId={organizationId}
        projectId={projectId}
        defaultKind={kinds === "object_storage" ? "object_storage" : "postgres"}
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

      <RestoreResourceModal
        organizationId={organizationId}
        resource={restoring}
        onClose={() => setRestoring(null)}
        onDone={() => {
          setRestoring(null);
          reload();
        }}
      />

      <RotateCredentialsModal
        organizationId={organizationId}
        resource={rotating}
        onClose={() => setRotating(null)}
      />
    </>
  );
}

/**
 * Object storage for this project.
 *
 * The buckets are the same `data_resources` rows with kind `object_storage`
 * that the Overview lists; this page is the storage-scoped view of them, with
 * provisioning defaulted to a bucket.
 */
function DatabaseStorage({
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
    "Storage buckets",
  );

  const buckets =
    resources.section.state.kind === "ready"
      ? resources.section.state.items.filter(
          (item) =>
            item.kind === "object_storage" &&
            (item.projectId == null || item.projectId === projectId),
        )
      : [];

  return (
    <>
      <SectionShell title="Object storage" hint="Buckets for files this project reads and writes">
        <div className="grid">
          <StatBox label="Buckets" value={String(buckets.length)} note="For this project" />
          <StatBox
            label="Ready"
            value={String(buckets.filter((item) => item.state === "ready").length)}
            note="Reported ready by the storage engine"
          />
          <StatBox
            label="Not configured"
            value={String(buckets.filter((item) => item.state === "not_configured").length)}
            note="Requested, but no storage engine is wired"
          />
        </div>
      </SectionShell>

      <ResourcesPanel
        organizationId={organizationId}
        projectId={projectId}
        kinds="object_storage"
        title="Buckets"
        hint="Created through the storage engine"
        emptyMessage="No buckets for this project. Creating one needs a configured storage engine."
      />
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
  defaultKind = "postgres",
  open,
  onClose,
  onDone,
}: {
  readonly organizationId: string;
  readonly projectId: string;
  /** Which kind the form opens with. The Storage page defaults to a bucket. */
  readonly defaultKind?: "postgres" | "object_storage";
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { client } = useApp();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"postgres" | "object_storage">(defaultKind);
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

/**
 * Restore a database from one of its own backups.
 *
 * A restore overwrites the target's current contents, so it is deliberately not
 * one click: the operator must type the database's own name to confirm, and the
 * server refuses without it. Only a `succeeded` backup with an engine handle is
 * offered, because that is the only one the engine can restore from. The result
 * is the adapter's own status — a `not_configured` engine is reported as such,
 * never as a completed restore.
 */
function RestoreResourceModal({
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
  const [backupId, setBackupId] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [result, setResult] = useState<RestoreDataSummary | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);

  const resourceId = resource?.id ?? "";
  const backups = useSection(
    () =>
      resourceId
        ? loadDataBackups(client, organizationId, resourceId)
        : Promise.resolve(ready<DataBackupSummary>("Backups", [])),
    [client, organizationId, resourceId],
    "Backups",
  );
  const history = useSection(
    () =>
      resourceId
        ? loadDataRestores(client, organizationId, resourceId)
        : Promise.resolve(ready<DataRestoreSummary>("Restores", [])),
    [client, organizationId, resourceId, historyNonce],
    "Restores",
  );

  if (!resource) return null;

  const restoreable =
    backups.section.state.kind === "ready"
      ? backups.section.state.items.filter(
          (item) => item.status === "succeeded" && item.providerResourceId,
        )
      : [];
  const selected = restoreable.find((item) => item.id === backupId) ?? null;

  const close = () => {
    setError(null);
    setResult(null);
    setBackupId("");
    setConfirmName("");
    onClose();
  };

  const submit = async () => {
    if (!selected) {
      setError("Choose a completed backup to restore from.");
      return;
    }
    setBusy(true);
    setError(null);
    const response = await client.call<RestoreDataSummary>("data.restore", {
      organizationId,
      resourceId: resource.id,
      backupId: selected.id,
      confirmName,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The restore could not be started.");
      return;
    }
    setResult(response.data);
    setHistoryNonce((value) => value + 1);
  };

  return (
    <Modal
      title="Restore from backup"
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
            <Button
              variant="danger"
              onClick={() => void submit()}
              busy={busy}
              disabled={!selected || confirmName.trim() !== resource.name}
              title={
                selected
                  ? confirmName.trim() === resource.name
                    ? "Restore this database"
                    : `Type ${resource.name} to confirm`
                  : "Choose a completed backup first"
              }
            >
              Restore
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <p>
          Restore <span className="mono">{resource.name}</span> from a backup.
        </p>
        {result ? (
          <>
            <span>
              <DataStateBadge state={result.restore.status} />
            </span>
            {result.engineReason ? (
              <p className="muted small">
                The engine did not complete the restore: {result.engineReason}
              </p>
            ) : result.restore.status === "pending" || result.restore.status === "running" ? (
              <p className="muted small">
                The restore is queued. The engine reports its own result here when it finishes.
              </p>
            ) : (
              <p className="small">The engine accepted the restore.</p>
            )}
          </>
        ) : (
          <>
            <p className="muted small">
              This overwrites the database's current contents with the backup's. Pick a completed
              backup and type the database name to confirm.
            </p>
            <Field label="Backup">
              {(id) => (
                <select
                  id={id}
                  className="select"
                  value={backupId}
                  onChange={(event) => setBackupId(event.target.value)}
                >
                  <option value="">Select a completed backup…</option>
                  {restoreable.map((item) => (
                    <option key={item.id} value={item.id}>
                      {new Date(item.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {backups.section.state.kind === "ready" && restoreable.length === 0 ? (
              <p className="muted small">
                No completed backup with an engine handle yet — take one first.
              </p>
            ) : null}
            <Field label={`Type "${resource.name}" to confirm`}>
              {(id) => (
                <TextInput
                  id={id}
                  value={confirmName}
                  placeholder={resource.name}
                  onChange={setConfirmName}
                />
              )}
            </Field>
          </>
        )}
        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}
        <div>
          <h2 className="small" style={{ marginBottom: "var(--space-2)" }}>
            Restore history
          </h2>
          <SectionView<DataRestoreSummary>
            section={history.section}
            onRetry={history.reload}
            emptyMessage="No restores recorded for this resource yet."
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

/**
 * Rotate a database's credentials.
 *
 * Rotation breaks every client still holding the old password, so it is a
 * confirm-by-name action like a restore. The new credential is deliberately not
 * shown: the engine writes it into its own store and the control plane keeps no
 * copy, so there is nothing here to display — only the engine's own outcome.
 */
function RotateCredentialsModal({
  organizationId,
  resource,
  onClose,
}: {
  readonly organizationId: string;
  readonly resource: DataResourceSummary | null;
  readonly onClose: () => void;
}) {
  const { client } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [result, setResult] = useState<RotateCredentialsSummary | null>(null);

  if (!resource) return null;

  const close = () => {
    setError(null);
    setResult(null);
    setConfirmName("");
    onClose();
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const response = await client.call<RotateCredentialsSummary>("data.rotateCredentials", {
      organizationId,
      resourceId: resource.id,
      confirmName,
    });
    setBusy(false);
    if (!response.ok || !response.data) {
      setError(response.error?.message ?? "The credentials could not be rotated.");
      return;
    }
    setResult(response.data);
  };

  return (
    <Modal
      title="Rotate credentials"
      open={resource !== null}
      onClose={close}
      footer={
        result ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => void submit()}
              busy={busy}
              disabled={confirmName.trim() !== resource.name}
              title={
                confirmName.trim() === resource.name
                  ? "Rotate this database's credentials"
                  : `Type ${resource.name} to confirm`
              }
            >
              Rotate
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        <p>
          Rotate the credentials of <span className="mono">{resource.name}</span>.
        </p>
        {result ? (
          result.engineReason ? (
            <p className="muted small">
              The engine did not rotate the credentials: {result.engineReason}
            </p>
          ) : (
            <p className="small">
              The engine rotated the credentials. It holds the new password; Cloud Wai keeps no
              copy, so read it from the engine.
            </p>
          )
        ) : (
          <>
            <p className="muted small">
              Every client using the current password will stop connecting. Type the database name
              to confirm.
            </p>
            <Field label={`Type "${resource.name}" to confirm`}>
              {(id) => (
                <TextInput
                  id={id}
                  value={confirmName}
                  placeholder={resource.name}
                  onChange={setConfirmName}
                />
              )}
            </Field>
          </>
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
  const Body = SECTION_COMPONENT[section];

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{title}</h1>
          <p className="page__sub">
            {section === "overview"
              ? "Databases, tables, storage and authentication for this project."
              : section === "storage"
                ? "Object storage buckets for this project, created through the storage engine."
                : `${title} for this project's database.`}
          </p>
        </div>
      </header>

      {Body ? (
        <Body organizationId={organizationId} projectId={projectId} />
      ) : (
        <NotYetBuilt section={section} />
      )}
    </div>
  );
}
