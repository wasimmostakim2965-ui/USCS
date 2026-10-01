/**
 * The page a section without a bespoke screen renders through.
 *
 * A section the sidebar lists but this deployment cannot yet act on is not a
 * blank page and not a fabricated one. It states what the section is for, names
 * the engine that would back it and its honest state, and offers the same first
 * action the reference offers — disabled where the engine is not wired, rather
 * than a button that pretends to work.
 *
 * The layout is the section's own: `spec.body.kind` picks one of the archetypes
 * in `@cloud-wai/ui/react` (a control room, a chooser, a numbered quickstart, a
 * set of meters, …), so two sections are never one pattern with the nouns
 * swapped. When the reference draws the section with a sub-menu (Firewall, CDN,
 * Storage, Flags, AI Gateway) the sub-items render as tabs, each a deep-linkable
 * URL.
 */
import { PageShell, SectionArchetype } from "@cloud-wai/ui/react";
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
  const activeTab = sub ?? tabs[0]?.id;

  return (
    <PageShell title={spec.title} subtitle={`${spec.blurb} ${scope}`}>
      <SectionArchetype
        chrome={{
          icon: spec.icon,
          title: spec.title,
          blurb: spec.blurb,
          tint: spec.tint,
          status: spec.status,
          ...(tabs.length > 0 ? { tabs, ...(activeTab ? { activeTab } : {}) } : {}),
          ...(onSelectTab ? { onSelectTab } : {}),
          ...(spec.body.kind === "empty" && spec.body.empty.action && onAction
            ? { primary: { label: spec.body.empty.action, onClick: onAction } }
            : {}),
          ...(spec.docs ? { docs: spec.docs } : {}),
        }}
        body={spec.body}
      />
    </PageShell>
  );
}
