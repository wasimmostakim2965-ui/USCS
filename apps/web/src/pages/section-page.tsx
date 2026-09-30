/**
 * The page every section without a bespoke screen renders through.
 *
 * A section the sidebar lists but this deployment cannot yet act on is not a
 * blank page and not a fabricated one. It states what the section is for, names
 * the engine that would back it, and shows the columns its list will be read by
 * — so the shape of the section is legible before the data exists, and the page
 * is honest that the data does not exist. That is the difference between
 * "empty" and "broken", which the rest of this app is careful about too.
 */
import {
  Button,
  EmptyState,
  PageShell,
  SectionShell,
  Table,
  type Column,
} from "@cloud-wai/ui/react";
import type { SectionSpec } from "../sections.js";

/** One row of the placeholder list: the column names, with no invented values. */
type PlaceholderRow = { readonly id: string; readonly column: string };

export function SectionPage({
  spec,
  scope,
  onAction,
}: {
  readonly spec: SectionSpec;
  /** What the section is scoped to, for the subtitle: a project, or the org. */
  readonly scope: string;
  /** Runs the primary action. Omitted when the action is not wired yet. */
  readonly onAction?: () => void;
}) {
  const rows: readonly PlaceholderRow[] = spec.columns.map((column) => ({
    id: column,
    column,
  }));

  const columns: readonly Column<PlaceholderRow>[] = [
    {
      key: "column",
      header: "Column",
      render: (row) => row.column,
    },
    {
      key: "value",
      header: "Value",
      render: () => <span className="text-dim">—</span>,
    },
  ];

  return (
    <PageShell
      title={spec.title}
      subtitle={`${spec.blurb} ${scope}`}
      actions={
        spec.action ? (
          <Button onClick={onAction ?? (() => undefined)} disabled={!onAction}>
            {spec.action}
          </Button>
        ) : null
      }
    >
      <SectionShell title={spec.title} hint={`Backed by the ${spec.engine}.`}>
        <EmptyState
          title={`${spec.title} is not configured`}
          message={`This deployment has no ${spec.engine} wired in, so there is nothing to list yet. The columns below are the shape this section will read by once it is.`}
        />
        <Table
          columns={columns}
          items={rows}
          rowKey={(row) => row.id}
          caption={`Columns this section is read by`}
        />
      </SectionShell>
    </PageShell>
  );
}
