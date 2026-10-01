/**
 * The section page archetypes.
 *
 * The reference does not draw every section the same way. A Firewall opens as a
 * control room — a status strip over a mitigation board and paired event
 * tables. Flags opens as a chooser between two ways to start. Storage opens as
 * a single honest call to action. AI Gateway opens as a numbered quickstart with
 * terminal blocks. Only the layout repeats; the shape does not.
 *
 * Before this file every section rendered one pattern — a heading, a tab strip,
 * an empty state and a table — with the nouns swapped, which is the thing the
 * owner asked to stop. So the layout is now the section's identity: each
 * archetype below is a distinct arrangement, and `SectionArchetype` dispatches
 * on the section's own `kind`.
 *
 * Two rules are carried from the design system rather than restated per page:
 * a section that an engine cannot back yet says so and offers nothing that
 * pretends to work, and colour is added only to tiles, rules and rails — never
 * to body copy — so the measured contrast of the text is unchanged.
 */
import type { ReactNode } from "react";
import { BarChart, Button, Icon, Table, type Column } from "./index.js";
import type { IconName } from "../icons.js";

/** A section's colour identity. Maps to a `.tint-*` class on the page. */
export type Tint = "blue" | "violet" | "teal" | "amber" | "rose" | "green" | "slate" | "cyan";

/** The honest status of the engine behind a section. */
export interface EngineStatus {
  readonly tone: "ok" | "warn" | "danger" | "neutral";
  /** The one-line verdict, e.g. "Configured" or "Not configured". */
  readonly label: string;
  /** What that means for this deployment, in a sentence. */
  readonly detail: string;
}

/** The heading every archetype opens with, plus the page's shared controls. */
export interface SectionChrome {
  readonly icon: IconName;
  readonly title: string;
  readonly blurb: string;
  readonly tint: Tint;
  readonly status: EngineStatus;
  /** The sub-items, when the section has them. */
  readonly tabs?: readonly { readonly id: string; readonly label: string }[];
  readonly activeTab?: string;
  readonly onSelectTab?: (id: string) => void;
  /** The primary action. Omitted when the engine cannot act on it yet. */
  readonly primary?: { readonly label: string; readonly onClick?: () => void };
  /** A secondary, always-safe action: read the documentation. */
  readonly docs?: { readonly label: string; readonly href: string };
}

/* --------------------------------------------------------------- pieces */

function SectionHeader({
  icon,
  title,
  blurb,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly blurb: string;
}) {
  return (
    <div className="sec-head">
      <span className="sec-head__tile" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <div className="sec-head__text">
        <h2 className="sec-head__title">{title}</h2>
        <p className="sec-head__blurb">{blurb}</p>
      </div>
    </div>
  );
}

const TONE_CLASS: Readonly<Record<EngineStatus["tone"], string>> = {
  ok: "badge--positive",
  warn: "badge--warning",
  danger: "badge--danger",
  neutral: "badge--neutral",
};

/** The engine's status as a badge, never as a colour on the copy. */
export function EngineBadge({ status }: { readonly status: EngineStatus }) {
  return (
    <span className={`badge ${TONE_CLASS[status.tone]}`}>
      <span className="badge__dot" />
      {status.label}
    </span>
  );
}

export interface Metric {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

export interface Panel {
  readonly title: string;
  readonly value?: string;
  /** The series, rendered as a labelled bar chart. */
  readonly series?: readonly { readonly label: string; readonly value: number }[];
  readonly unit?: string;
  readonly foot?: string;
  readonly empty?: string;
}

export interface Meter {
  readonly label: string;
  readonly ratio: string;
  /** 0–100. Drives the fill width, so a value over its cap clamps visibly. */
  readonly percent: number;
  readonly note?: string;
}

export interface Chooser {
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly featured?: boolean;
  readonly icon?: IconName;
  /** False when the engine behind this choice is not wired yet. */
  readonly enabled?: boolean;
}

export interface GalleryTile {
  readonly title: string;
  readonly body: string;
  readonly icon?: IconName;
}

export interface Step {
  readonly title: string;
  readonly body: string;
  /** Terminal lines to run. A line starting with `#` renders as a comment. */
  readonly code?: readonly string[];
}

export interface Promise_ {
  readonly title: string;
  readonly body: string;
}

/* ----------------------------------------------------------- archetypes */

/** A status strip: the reference's "Firewall is active" row. */
export function SectionBanner({
  label,
  detail,
  action,
}: {
  readonly label: string;
  readonly detail: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="sec-banner">
      <span className="sec-banner__dot" aria-hidden="true" />
      <span className="sec-banner__label">{label}</span>
      <span className="sec-banner__detail">{detail}</span>
      {action ? <span className="sec-banner__spacer">{action}</span> : null}
    </div>
  );
}

/** A row of numeric tiles over a shared tinted rail. */
export function MetricBoard({ metrics }: { readonly metrics: readonly Metric[] }) {
  return (
    <div className="sec-metrics">
      {metrics.map((metric) => (
        <div className="sec-metric" key={metric.label}>
          <div className="sec-metric__label">{metric.label}</div>
          <div className="sec-metric__value">{metric.value}</div>
          {metric.note ? <div className="sec-metric__note">{metric.note}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** A grid of bordered panels, each a labelled series. */
export function PanelGrid({ panels }: { readonly panels: readonly Panel[] }) {
  return (
    <div className="sec-panels">
      {panels.map((panel) => (
        <div className="sec-panel" key={panel.title}>
          <div className="sec-panel__head">
            <span className="sec-panel__title">{panel.title}</span>
            {panel.value ? <span className="sec-panel__value mono">{panel.value}</span> : null}
          </div>
          {panel.series && panel.series.length > 0 ? (
            <BarChart
              bars={panel.series}
              ariaLabel={panel.title}
              {...(panel.unit ? { unit: panel.unit } : {})}
            />
          ) : (
            <p className="faint small">{panel.empty ?? "No data in this range."}</p>
          )}
          {panel.foot ? <div className="sec-panel__foot">{panel.foot}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** Capped meters with a ratio, for usage against a limit. */
export function MeterList({ meters }: { readonly meters: readonly Meter[] }) {
  return (
    <div className="sec-meters">
      {meters.map((meter) => (
        <div key={meter.label}>
          <div className="sec-meter__head">
            <span>{meter.label}</span>
            <span className="sec-meter__ratio mono small">{meter.ratio}</span>
          </div>
          <div
            className="sec-meter__track"
            role="progressbar"
            aria-label={meter.label}
            aria-valuenow={Math.round(meter.percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="sec-meter__fill"
              style={{ width: `${Math.min(100, Math.max(0, meter.percent))}%` }}
            />
          </div>
          {meter.note ? <div className="sec-meter__note">{meter.note}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** Side-by-side cards, each a way in. */
export function ChooserGrid({ choosers }: { readonly choosers: readonly Chooser[] }) {
  return (
    <div className="sec-choosers">
      {choosers.map((chooser) => (
        <div
          className={`sec-chooser${chooser.featured ? " sec-chooser--featured" : ""}`}
          key={chooser.title}
        >
          {chooser.icon ? (
            <span className="sec-tile__glyph" aria-hidden="true">
              <Icon name={chooser.icon} size={18} />
            </span>
          ) : null}
          <div className="sec-chooser__title">{chooser.title}</div>
          <div className="sec-chooser__body">{chooser.body}</div>
          <div className="sec-chooser__foot">
            <Button variant={chooser.featured ? "primary" : "default"} disabled>
              {chooser.action}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A grid of tiles for a set of named things. */
export function Gallery({ tiles }: { readonly tiles: readonly GalleryTile[] }) {
  return (
    <div className="sec-gallery">
      {tiles.map((tile) => (
        <div className="sec-tile" key={tile.title}>
          {tile.icon ? (
            <span className="sec-tile__glyph" aria-hidden="true">
              <Icon name={tile.icon} size={17} />
            </span>
          ) : null}
          <div className="sec-tile__title">{tile.title}</div>
          <div className="sec-tile__body">{tile.body}</div>
        </div>
      ))}
    </div>
  );
}

/** A numbered quickstart with terminal blocks. */
export function StepGuide({ steps }: { readonly steps: readonly Step[] }) {
  return (
    <div className="sec-steps">
      {steps.map((step) => (
        <div className="sec-step" key={step.title}>
          <span className="sec-step__num" aria-hidden="true" />
          <div>
            <div className="sec-step__title">{step.title}</div>
            <p className="sec-step__body">{step.body}</p>
            {step.code ? (
              <div className="sec-code">
                {step.code.map((line) => (
                  <code
                    className={`sec-code__line${line.startsWith("#") ? " sec-code__line--comment" : ""}`}
                    key={line}
                  >
                    {line}
                  </code>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A hero claim over a set of promises. */
export function FeatureIntro({
  hero,
  promises,
  action,
}: {
  readonly hero: { readonly title: string; readonly body: string };
  readonly promises: readonly Promise_[];
  readonly action?: ReactNode;
}) {
  return (
    <>
      <div className="sec-hero">
        <h3 className="sec-hero__title">{hero.title}</h3>
        <p className="sec-hero__body">{hero.body}</p>
        {action ? <div className="sec-hero__actions">{action}</div> : null}
      </div>
      <div className="sec-promises">
        {promises.map((promise) => (
          <div className="sec-promise" key={promise.title}>
            <div className="sec-promise__title">{promise.title}</div>
            <p className="sec-promise__body">{promise.body}</p>
          </div>
        ))}
      </div>
    </>
  );
}

/** One big score with a verdict, or an honest "no data yet". */
export function ScoreCard({
  score,
  verdict,
  body,
  unavailable,
}: {
  readonly score: number | null;
  readonly verdict: string;
  readonly body: string;
  readonly unavailable?: string;
}) {
  if (score === null) {
    return (
      <div className="sec-score">
        <div className="sec-empty__glyph" aria-hidden="true">
          <Icon name="pulse" size={20} />
        </div>
        <div>
          <div className="sec-score__verdict">{verdict}</div>
          <p className="sec-score__body">{unavailable ?? body}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="sec-score">
      <div className="sec-score__dial" style={{ ["--score" as string]: score }}>
        <div className="sec-score__inner">
          <span className="sec-score__value">{score}</span>
        </div>
      </div>
      <div>
        <div className="sec-score__verdict">{verdict}</div>
        <p className="sec-score__body">{body}</p>
      </div>
    </div>
  );
}

/** The honest "nothing here yet, and here is the one action". */
export function EmptyCard({
  icon,
  title,
  message,
  action,
  disabled,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly message: string;
  readonly action?: string;
  readonly disabled?: boolean;
}) {
  return (
    <div className="sec-empty">
      <span className="sec-empty__glyph" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <div className="sec-empty__title">{title}</div>
      <p className="sec-empty__body">{message}</p>
      {action ? (
        <Button variant="primary" {...(disabled ? { disabled } : {})}>
          {action}
        </Button>
      ) : null}
    </div>
  );
}

/** A plain list page: named columns over rows, for the sections that are one. */
export function SectionTable({
  caption,
  columns,
  rows,
  filterLabel,
}: {
  readonly caption: string;
  readonly columns: readonly { readonly key: string; readonly header: string }[];
  readonly rows: readonly {
    readonly id: string;
    readonly cells: Readonly<Record<string, string>>;
  }[];
  readonly filterLabel?: string;
}) {
  type Row = (typeof rows)[number];
  const tableColumns: readonly Column<Row>[] = columns.map((column) => ({
    key: column.key,
    header: column.header,
    render: (row) => row.cells[column.key] ?? "",
  }));
  return (
    <Table
      caption={caption}
      columns={tableColumns}
      items={rows}
      rowKey={(row) => row.id}
      filterText={(row) => Object.values(row.cells).join(" ")}
      {...(filterLabel ? { filterLabel } : {})}
    />
  );
}

/* ------------------------------------------------------------ dispatch */

export type SectionBody =
  | {
      readonly kind: "control";
      readonly banner: { readonly label: string; readonly detail: string };
      readonly metrics: readonly Metric[];
      readonly panels: readonly Panel[];
    }
  | {
      readonly kind: "board";
      readonly metrics: readonly Metric[];
      readonly panels: readonly Panel[];
    }
  | { readonly kind: "meters"; readonly meters: readonly Meter[] }
  | { readonly kind: "choosers"; readonly choosers: readonly Chooser[] }
  | { readonly kind: "gallery"; readonly tiles: readonly GalleryTile[] }
  | { readonly kind: "steps"; readonly steps: readonly Step[] }
  | {
      readonly kind: "intro";
      readonly hero: { readonly title: string; readonly body: string };
      readonly promises: readonly Promise_[];
    }
  | {
      readonly kind: "score";
      readonly score: number | null;
      readonly verdict: string;
      readonly body: string;
      readonly unavailable?: string;
    }
  | {
      readonly kind: "empty";
      readonly empty: {
        readonly icon: IconName;
        readonly title: string;
        readonly message: string;
        readonly action?: string;
      };
    }
  | {
      readonly kind: "table";
      readonly caption: string;
      readonly columns: readonly { readonly key: string; readonly header: string }[];
      readonly rows: readonly {
        readonly id: string;
        readonly cells: Readonly<Record<string, string>>;
      }[];
      readonly filterLabel?: string;
    };

/**
 * Renders a section as its own archetype.
 *
 * The chrome (heading, tabs, status, actions) is shared; the body is not. The
 * `kind` is a property of the section in the catalogue, so a section cannot be
 * given a layout that contradicts what it is.
 */
export function SectionArchetype({
  chrome,
  body,
}: {
  readonly chrome: SectionChrome;
  readonly body: SectionBody;
}) {
  const primary = chrome.primary ? (
    <Button
      variant="primary"
      {...(chrome.primary.onClick ? { onClick: chrome.primary.onClick } : {})}
    >
      {chrome.primary.label}
    </Button>
  ) : null;

  return (
    <div className={`tinted tint-${chrome.tint}`}>
      <SectionHeader icon={chrome.icon} title={chrome.title} blurb={chrome.blurb} />

      <div className="row" style={{ marginBottom: "var(--space-5)" }}>
        <EngineBadge status={chrome.status} />
        <span className="faint small">{chrome.status.detail}</span>
        <span className="sec-banner__spacer">
          {chrome.docs ? (
            <Button onClick={() => window.open(chrome.docs!.href, "_blank", "noopener")}>
              {chrome.docs.label}
            </Button>
          ) : null}
          {primary}
        </span>
      </div>

      {chrome.tabs && chrome.tabs.length > 0 ? (
        <div className="tabs" role="tablist">
          {chrome.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === chrome.activeTab}
              className={`tabs__tab${tab.id === chrome.activeTab ? " tabs__tab--active" : ""}`}
              onClick={() => chrome.onSelectTab?.(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}

      {body.kind === "control" ? (
        <div className="sec-control">
          <SectionBanner label={body.banner.label} detail={body.banner.detail} />
          <MetricBoard metrics={body.metrics} />
          <PanelGrid panels={body.panels} />
        </div>
      ) : null}

      {body.kind === "board" ? (
        <>
          <MetricBoard metrics={body.metrics} />
          <PanelGrid panels={body.panels} />
        </>
      ) : null}

      {body.kind === "meters" ? <MeterList meters={body.meters} /> : null}
      {body.kind === "choosers" ? <ChooserGrid choosers={body.choosers} /> : null}
      {body.kind === "gallery" ? <Gallery tiles={body.tiles} /> : null}
      {body.kind === "steps" ? <StepGuide steps={body.steps} /> : null}
      {body.kind === "intro" ? (
        <FeatureIntro hero={body.hero} promises={body.promises} action={primary} />
      ) : null}
      {body.kind === "score" ? (
        <ScoreCard
          score={body.score}
          verdict={body.verdict}
          body={body.body}
          {...(body.unavailable ? { unavailable: body.unavailable } : {})}
        />
      ) : null}
      {body.kind === "empty" ? (
        <EmptyCard
          icon={body.empty.icon}
          title={body.empty.title}
          message={body.empty.message}
          {...(body.empty.action ? { action: body.empty.action } : {})}
          disabled
        />
      ) : null}
      {body.kind === "table" ? (
        <SectionTable
          caption={body.caption}
          columns={body.columns}
          rows={body.rows}
          {...(body.filterLabel ? { filterLabel: body.filterLabel } : {})}
        />
      ) : null}
    </div>
  );
}
