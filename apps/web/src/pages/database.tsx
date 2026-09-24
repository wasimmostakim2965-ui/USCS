/**
 * The Database section.
 *
 * This is the third drill-in level (Workspace -> Project -> Database). The
 * sidebar for it comes from `databaseNav`, and the route decides which
 * sub-page is showing, so every sub-page is its own URL.
 *
 * What is rendered here is honest about what exists. The rows below the
 * Overview are read through the same `data.list` procedure as before; each
 * sub-page that needs a procedure the API does not have yet says so explicitly
 * and offers no control that pretends otherwise. Nothing here reports success
 * for work the platform has not performed.
 */
import { Button, Card, SectionShell, SectionView, StatBox } from "@cloud-wai/ui/react";
import { useApp } from "../react/context.js";
import { useSection } from "../react/hooks.js";
import type { DatabaseSection } from "../routes.js";
import { loadDataResources, loadProviderHealth, type DataResourceSummary } from "../view-model.js";
import { DataStateBadge } from "../components/page-parts.js";
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

function DatabaseOverview({ organizationId }: { readonly organizationId: string }) {
  const { client } = useApp();
  const resources = useSection(
    () => loadDataResources(client, organizationId),
    [client, organizationId],
    "Databases and storage",
  );

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
        actions={<ComingSoon label="Auto Database Setup" />}
      >
        <Card flush>
          <SectionView<DataResourceSummary>
            section={resources.section}
            columns={[
              { key: "name", header: "Name", render: (item) => item.name },
              {
                key: "kind",
                header: "Kind",
                render: (item) => <span className="mono small">{item.kind}</span>,
              },
              {
                key: "state",
                header: "State",
                render: (item) => <DataStateBadge state={item.state} />,
              },
            ]}
            rowKey={(item) => item.id}
            onRetry={resources.reload}
            emptyMessage="No database resources. Provisioning needs a configured database engine."
          />
        </Card>
      </SectionShell>

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

export function DatabasePage({
  organizationId,
  section,
}: {
  readonly organizationId: string;
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
        <DatabaseOverview organizationId={organizationId} />
      ) : (
        <NotYetBuilt section={section} />
      )}
    </div>
  );
}
