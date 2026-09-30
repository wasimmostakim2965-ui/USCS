/**
 * The page every section without a bespoke screen renders through.
 *
 * A section the sidebar lists but this deployment cannot yet act on is not a
 * blank page and not a fabricated one. It states what the section is for, names
 * the engine that would back it, and offers the same first action the reference
 * offers ("Create Repository", "Connect Database", …) — disabled, because the
 * engine behind it is not wired, rather than a button that pretends to work.
 *
 * When the reference draws the section with a sub-menu (Firewall, CDN, Storage,
 * Flags, AI Gateway) the sub-items render as tabs, each a deep-linkable URL.
 */
import { Button, EmptyState, PageShell, SectionShell, Tabs } from "@cloud-wai/ui/react";
import { subSections, subSectionTitle } from "../routes.js";
import type { SectionSpec } from "../sections.js";

export function SectionPage({
  spec,
  section,
  scope,
  sub,
  onSelectTab,
  onAction,
}: {
  readonly spec: SectionSpec;
  /** The section key, which is how its sub-items are looked up. */
  readonly section: string;
  /** What the section is scoped to, for the subtitle: a project, or the org. */
  readonly scope: string;
  /** The reference's sub-item being shown, when the section has sub-items. */
  readonly sub?: string | undefined;
  /** Follows a tab press; the shell rewrites the URL to that sub-item. */
  readonly onSelectTab?: ((sub: string) => void) | undefined;
  /** Runs the primary action. Omitted when the action is not wired yet. */
  readonly onAction?: () => void;
}) {
  const tabs = subSections(section).map((id) => ({ id, label: subSectionTitle(id) }));
  const active = sub ?? tabs[0]?.id ?? "overview";

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
      {tabs.length > 0 ? (
        <Tabs tabs={tabs} active={active} onChange={(id) => onSelectTab?.(id)} />
      ) : null}

      <SectionShell title={spec.title} hint={`Backed by the ${spec.engine}.`}>
        <EmptyState
          title={spec.empty.title}
          message={spec.empty.message}
          actions={
            spec.empty.action && onAction ? (
              <Button variant="primary" onClick={onAction}>
                {spec.empty.action}
              </Button>
            ) : undefined
          }
        />
      </SectionShell>
    </PageShell>
  );
}
