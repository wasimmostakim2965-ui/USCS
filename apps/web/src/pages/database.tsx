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
import { useEffect, useState, type ReactElement } from "react";
import {
  Button,
  Card,
  DegradedState,
  EmptyState,
  Field,
  LoadingSkeleton,
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
  loadDataLogs,
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
import { DataStateBadge, Timestamp, VisitLink } from "../components/page-parts.js";

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
 * Every sub-page is now real. Overview, Storage and Logs read the control plane
 * directly (`data.list`, `data.logs`). The remaining sub-pages — Table Editor,
 * SQL Editor, Authentication, API, Roles — describe a concern whose *engine*
 * screen exists but whose operation Cloud Wai does not proxy: ADR-0011 keeps the
 * control plane out of the tenant data plane, so it holds no tenant database
 * connection and issues no SQL. Those pages therefore hand the operator to the
 * engine's own console for that concern, through the deep link the server
 * resolved, instead of pretending to be a query console or a fake editor.
 */
const SECTION_COMPONENT: Record<
  DatabaseSection,
  (props: { readonly organizationId: string; readonly projectId: string }) => ReactElement
> = {
  overview: DatabaseOverview,
  tables: DatabaseTables,
  sql: DatabaseSql,
  auth: DatabaseAuth,
  storage: DatabaseStorage,
  api: DatabaseApi,
  roles: DatabaseRoles,
  logs: DatabaseLogs,
  settings: DatabaseSettings,
};

/**
 * A Database sub-page whose concern lives on the engine's own console.
 *
 * The shape is the same for each: an honest statement of what the control plane
 * does *not* proxy for this concern, and one link per ready database to the
 * engine screen that owns it. When no console is configured the link is absent
 * and the page says so — it never renders a dead link, and it never fabricates a
 * screen of its own that would imply the platform performed work it did not.
 *
 * `consoleSection` is a key into the links the server resolved, not a path: the
 * engine's URL grammar stays in the adapter layer, so a route rename cannot
 * silently produce a 404 in the dashboard.
 */
function ConsoleHandoff({
  organizationId,
  projectId,
  title,
  hint,
  explanation,
  consoleSection,
}: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly hint: string;
  readonly explanation: string;
  readonly consoleSection: string;
}) {
  const { client } = useApp();
  const resources = useSection(
    () => loadDataResources(client, organizationId),
    [client, organizationId],
    title,
  );

  const databases =
    resources.section.state.kind === "ready"
      ? resources.section.state.items.filter(
          (item) =>
            item.kind === "postgres" &&
            item.state === "ready" &&
            (item.projectId == null || item.projectId === projectId),
        )
      : [];

  return (
    <>
      {/* The page header already carries the section title, so this states the
          handoff itself rather than repeating the heading. */}
      <SectionShell title="Where this is managed" hint={hint}>
        <Card>
          <p className="muted small">{explanation}</p>
        </Card>
      </SectionShell>

      <SectionShell title="Engine console" hint="The engine's own screen for this concern">
        <SectionView<DataResourceSummary>
          section={ready(title, databases)}
          columns={[
            { key: "name", header: "Database", render: (item) => item.name },
            {
              key: "console",
              header: "Engine console",
              render: (item) => {
                const url = item.engineConsole?.[consoleSection];
                // A ready database with no console link is a deployment fact:
                // no tenant-reachable console is configured. It says so rather
                // than offering a link that would not resolve.
                return url ? (
                  <VisitLink url={url} label="Open in engine console" />
                ) : (
                  <span className="small muted">No engine console configured</span>
                );
              },
            },
          ]}
          rowKey={(item) => item.id}
          onRetry={resources.reload}
          emptyMessage="No ready database in this project. This concern is served by the engine's console once a database is ready."
        />
      </SectionShell>
    </>
  );
}

function DatabaseTables(props: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  return (
    <ConsoleHandoff
      {...props}
      title="Table Editor"
      hint="Rows are managed in the engine's own console"
      explanation="Cloud Wai does not connect to a tenant database and does not issue SQL (ADR-0011, Option A), so it does not proxy a table browser. Rows are inspected and edited in the engine's console for the database — the terminal there is where SQL is run against it."
      consoleSection="terminal"
    />
  );
}

function DatabaseSql(props: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  return (
    <ConsoleHandoff
      {...props}
      title="SQL Editor"
      hint="SQL runs in the engine's own console"
      explanation="SQL is executed against the database inside the engine, never through the control plane: Cloud Wai holds no tenant data-plane credentials. The engine console's terminal is where a query is run against this database."
      consoleSection="terminal"
    />
  );
}

function DatabaseAuth(props: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  return (
    <ConsoleHandoff
      {...props}
      title="Authentication"
      hint="Identity for applications built on this database"
      explanation="Application-level authentication belongs to the app that uses this database, not to the engine that hosts it, and not to this control plane — which holds no tenant data-plane credentials (ADR-0011). The engine console shows the database itself; auth providers are configured where the app is deployed."
      consoleSection="overview"
    />
  );
}

function DatabaseApi(props: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  return (
    <ConsoleHandoff
      {...props}
      title="API"
      hint="The engine's own API surface for this database"
      explanation="Cloud Wai does not generate a REST layer over tenant tables — that would require the data-plane access ADR-0011 forbids. The database's own engine API and its configuration are on the engine console."
      consoleSection="overview"
    />
  );
}

function DatabaseRoles(props: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  return (
    <ConsoleHandoff
      {...props}
      title="Roles & Extensions"
      hint="Database roles, extensions and limits"
      explanation="Roles and extensions are database-level concerns inside the engine, and inspecting them needs the data-plane access ADR-0011 forbids. The engine console is where they are inspected; the control plane records the resource and its credentials rotation, not the engine's role catalogue."
      consoleSection="overview"
    />
  );
}

function DatabaseSettings(props: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  return (
    <ConsoleHandoff
      {...props}
      title="Settings"
      hint="Engine-level configuration for this database"
      explanation="Engine-level settings — environment variables, resource limits, health checks — belong to the engine's own resource record, which the control plane does not hold (ADR-0011). The console is where they are changed; Cloud Wai's control plane holds the resource's identity and lifecycle, not the engine's configuration surface."
      consoleSection="environment-variables"
    />
  );
}

/**
 * The database's log, read through the engine.
 *
 * This is the one database view that is a real control-plane read: `data.logs`
 * asks the database adapter for the resource's container log, which the engine
 * serves without Cloud Wai entering the data plane. The page shows the engine's
 * own lines, and an unconfigured or unreachable engine renders as its own state
 * rather than as an empty log that would read like "nothing is happening".
 */
function DatabaseLogs({
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
    "Database logs",
  );
  const [selected, setSelected] = useState<string | null>(null);

  const databases =
    resources.section.state.kind === "ready"
      ? resources.section.state.items.filter(
          (item) =>
            item.kind === "postgres" &&
            item.state === "ready" &&
            (item.projectId == null || item.projectId === projectId),
        )
      : [];

  const active = databases.find((item) => item.id === selected) ?? databases[0] ?? null;

  return (
    <>
      <SectionShell title="Database log" hint="The engine's own container output for this database">
        {active && databases.length > 1 ? (
          <Card title="Database">
            <p className="small muted">The log shown is this database's own.</p>
            <div className="row" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
              {databases.map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={item.id === active.id ? "primary" : "ghost"}
                  aria-pressed={item.id === active.id}
                  onClick={() => setSelected(item.id)}
                >
                  {item.name}
                </Button>
              ))}
            </div>
          </Card>
        ) : null}

        {active ? (
          <DatabaseLogPanel
            key={active.id}
            organizationId={organizationId}
            resource={active}
          />
        ) : (
          <Card>
            <EmptyState
              title="No database to read a log from"
              message="A database must be ready before the engine has a log for it. Provision a database on the Overview page."
            />
          </Card>
        )}
      </SectionShell>
    </>
  );
}

/**
 * One database's log.
 *
 * `key`-ed by the resource so switching databases remounts the panel and the
 * previous database's lines never linger under a new heading. The three states
 * are distinct: loading, the engine refusing (its own reason), and the engine
 * answering (its lines, or an honest empty tail).
 */
function DatabaseLogPanel({
  organizationId,
  resource,
}: {
  readonly organizationId: string;
  readonly resource: DataResourceSummary;
}) {
  const { client } = useApp();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<
    | { readonly kind: "loading" }
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "loaded"; readonly lines: readonly string[]; readonly cursor: string | null }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void loadDataLogs(client, organizationId, resource.id).then((logs) => {
      if (cancelled) return;
      if (logs.engineReason && logs.lines.length === 0) {
        setState({ kind: "refused", reason: logs.engineReason });
        return;
      }
      setState({ kind: "loaded", lines: logs.lines, cursor: logs.cursor });
    });
    return () => {
      cancelled = true;
    };
  }, [client, organizationId, resource.id, nonce]);

  return (
    <SectionShell
      title={resource.name}
      hint="Read through the database engine"
      actions={
        <Button size="sm" onClick={() => setNonce((n) => n + 1)}>
          Refresh
        </Button>
      }
    >
      {state.kind === "loading" ? <LoadingSkeleton title="Database log" rows={5} /> : null}
      {state.kind === "refused" ? (
        <DegradedState title="Database log" reason={state.reason} />
      ) : null}
      {state.kind === "loaded" ? (
        state.lines.length === 0 ? (
          <Card>
            <EmptyState
              title="No log output"
              message="The engine returned no log lines for this database. That is the engine's answer, not a missing view."
            />
          </Card>
        ) : (
          <Card flush>
            <pre className="log" aria-label={`Log for ${resource.name}`}>
              {state.lines.join("\n")}
            </pre>
          </Card>
        )
      ) : null}
    </SectionShell>
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

      <Body organizationId={organizationId} projectId={projectId} />
    </div>
  );
}
