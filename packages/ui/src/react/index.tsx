/**
 * Cloud Wai design system components.
 *
 * Every component takes explicit state. There is deliberately no `isLoading`
 * boolean anywhere: a caller renders a `Section` state, and the components that
 * exist for `degraded` and `error` cannot be reached from a success path. That
 * is what stops a not-configured engine from rendering as a green badge.
 *
 * Accessibility is built in rather than added later: buttons are real buttons,
 * dialogs trap focus and close on Escape, tabs expose `aria-selected`, and load
 * results are announced through live regions.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Section, SectionState, StatusPresentation, ViewState } from "../index.js";

/* ------------------------------------------------------------------ tones */

export type Tone = StatusPresentation["tone"];

export interface BadgeProps {
  readonly label: string;
  readonly tone?: Tone;
  /** Show a leading dot. Defaults on for a plain status badge. */
  readonly dot?: boolean;
}

export function StatusBadge({ label, tone = "neutral", dot = true }: BadgeProps) {
  return (
    <span className={`badge badge--${tone}`}>
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ text */

export function PageShell({
  title,
  subtitle,
  actions,
  breadcrumb,
  children,
}: {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly breadcrumb?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="page">
      {breadcrumb}
      <header className="page__head">
        <div>
          <h1 className="page__title">{title}</h1>
          {subtitle ? <p className="page__sub">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page__actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function SectionShell({
  title,
  hint,
  actions,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">{title}</h2>
        {hint ? <span className="section__hint">{hint}</span> : null}
        {actions ? <div style={{ marginLeft: "auto" }}>{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ card */

export function Card({
  title,
  actions,
  footer,
  children,
  flush = false,
}: {
  readonly title?: string;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly flush?: boolean;
}) {
  return (
    <div className="card">
      {title || actions ? (
        <div className="card__head">
          {title ? <span className="card__title">{title}</span> : null}
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      {flush ? children : <div className="card__body">{children}</div>}
      {footer ? <div className="card__foot">{footer}</div> : null}
    </div>
  );
}

export function StatBox({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly note?: string;
}) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {note ? <div className="stat__note">{note}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ button */

export interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly variant?: "default" | "primary" | "ghost" | "danger";
  readonly size?: "default" | "sm";
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly title?: string;
  readonly type?: "button" | "submit";
  readonly ariaLabel?: string;
}

export function Button({
  children,
  onClick,
  variant = "default",
  size = "default",
  disabled = false,
  busy = false,
  title,
  type = "button",
  ariaLabel,
}: ButtonProps) {
  const classes = [
    "btn",
    variant !== "default" ? `btn--${variant}` : "",
    size === "sm" ? "btn--sm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type={type}
      className={classes}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      aria-label={ariaLabel}
      aria-busy={busy}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------- table */

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly render: (item: T) => ReactNode;
  readonly align?: "left" | "right";
  /** Sort key when the column is sortable. */
  readonly sortValue?: (item: T) => string | number;
}

export interface TableProps<T> {
  readonly caption?: string;
  readonly columns: readonly Column<T>[];
  readonly items: readonly T[];
  readonly rowKey: (item: T) => string;
  readonly onRowClick?: (item: T) => void;
}

export function Table<T>({ caption, columns, items, rowKey, onRowClick }: TableProps<T>) {
  return (
    <div className="table-wrap">
      <table className="table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.align === "right" ? { textAlign: "right" } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={rowKey(item)}
              onClick={onRowClick ? () => onRowClick(item) : undefined}
              style={onRowClick ? { cursor: "pointer" } : undefined}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={column.align === "right" ? "table__num" : undefined}
                >
                  {column.render(item)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------------- tabs */

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  readonly tabs: readonly { readonly id: string; readonly label: string }[];
  readonly active: string;
  readonly onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={`tabs__tab${tab.id === active ? " tabs__tab--active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- states */

/**
 * The "nothing to show yet" states.
 *
 * They are separate components rather than one with a mode, so a view cannot
 * pass a success-shaped prop to the degraded one.
 */
export function LoadingSkeleton({
  title,
  rows = 3,
}: {
  readonly title: string;
  readonly rows?: number;
}) {
  const widths = ["64%", "88%", "46%", "74%", "58%"];
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{title} is loading.</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="skeleton__bar"
          style={{ width: widths[index % widths.length] as CSSProperties["width"] }}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  actions,
}: {
  readonly title: string;
  readonly message: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="state state--empty">
      <div className="state__glyph" aria-hidden="true">
        ∅
      </div>
      <div>
        <div className="state__title">{title}</div>
        <p className="state__body">{message}</p>
        {actions ? <div className="state__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/**
 * An engine this deployment cannot act on yet.
 *
 * The wording is fixed here on purpose. "Not configured" is a deployment fact,
 * not a customer error, and it must never be phrased as success or as the
 * customer's mistake.
 */
export function DegradedState({
  title,
  reason,
  actions,
}: {
  readonly title: string;
  readonly reason: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="state state--degraded" role="status">
      <div className="state__glyph" aria-hidden="true">
        ⚠
      </div>
      <div>
        <div className="state__title">{title} — not configured</div>
        <p className="state__body">{reason}</p>
        {actions ? <div className="state__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

export function ErrorState({
  title,
  message,
  onRetry,
}: {
  readonly title: string;
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="state state--error" role="alert">
      <div className="state__glyph" aria-hidden="true">
        !
      </div>
      <div>
        <div className="state__title">{title} could not load</div>
        <p className="state__body">{message}</p>
        {onRetry ? (
          <div className="state__actions">
            <Button size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- section */

/**
 * Render any `Section<T>`.
 *
 * This is the only component that reads a section state, which is why the
 * honesty rules hold everywhere at once: adding a page cannot skip them without
 * deliberately not using this.
 */
export function SectionView<T>({
  section,
  columns,
  rowKey,
  emptyMessage,
  onRetry,
  onRowClick,
  renderReady,
}: {
  readonly section: Section<T>;
  readonly columns?: readonly Column<T>[];
  readonly rowKey?: (item: T) => string;
  readonly emptyMessage?: string;
  readonly onRetry?: () => void;
  readonly onRowClick?: (item: T) => void;
  readonly renderReady?: (items: readonly T[]) => ReactNode;
}) {
  const state: SectionState<T> = section.state;

  switch (state.kind) {
    case "loading":
      return <LoadingSkeleton title={section.title} />;
    case "degraded":
      return <DegradedState title={section.title} reason={state.reason} />;
    case "error":
      return (
        <ErrorState
          title={section.title}
          message={state.message}
          {...(onRetry ? { onRetry } : {})}
        />
      );
    case "empty":
      return <EmptyState title={section.title} message={emptyMessage ?? state.message} />;
    case "ready":
      if (renderReady) return <>{renderReady(state.items)}</>;
      if (columns && rowKey) {
        return (
          <Table
            columns={columns}
            items={state.items}
            rowKey={rowKey}
            {...(onRowClick ? { onRowClick } : {})}
          />
        );
      }
      return null;
  }
}

/**
 * Map a `ViewState` to a node. Used by views that already model their own state
 * rather than carrying a full `Section`.
 */
export function ViewStateView({
  state,
  title,
  children,
}: {
  readonly state: ViewState;
  readonly title: string;
  readonly children: (data: unknown) => ReactNode;
}) {
  switch (state.kind) {
    case "loading":
      return <LoadingSkeleton title={title} />;
    case "empty":
      return <EmptyState title={title} message="Nothing here yet." />;
    case "degraded":
      return <DegradedState title={title} reason={state.reason} />;
    case "error":
      return <ErrorState title={title} message={state.message} />;
    case "success":
      return <>{children(state.data)}</>;
  }
}

/* --------------------------------------------------------------- dialog */

/** Lock background scroll while a dialog-like overlay is open. */
function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}

export function Modal({
  title,
  open,
  onClose,
  footer,
  children,
}: {
  readonly title: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useScrollLock(open);

  // Kept in refs so typing inside the dialog does not re-run the effect below.
  // With `onClose` in the dependency list every keystroke re-attached the
  // listener and, worse, yanked focus to the first control in the dialog (the
  // close button) — so the next space keyup activated it and closed the modal.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const wasOpen = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key === "Tab") {
        const focusables = panel.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    // Focus moves in once per opening, never on a re-render, so a field keeps
    // focus while the operator types.
    if (!wasOpen.current) {
      wasOpen.current = true;
      const firstField = panel.current?.querySelector<HTMLElement>(
        "input, select, textarea, button",
      );
      firstField?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      wasOpen.current = false;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={panel}>
        <div className="dialog__head">
          <span className="dialog__title">{title}</span>
          <Button variant="ghost" size="sm" onClick={onClose} ariaLabel="Close">
            ✕
          </Button>
        </div>
        <div className="dialog__body">{children}</div>
        {footer ? <div className="dialog__foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({
  title,
  open,
  onClose,
  children,
}: {
  readonly title: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  useScrollLock(open);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div
        className="overlay"
        style={{ paddingTop: 0, placeItems: "stretch" }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog__head">
          <span className="dialog__title">{title}</span>
          <Button variant="ghost" size="sm" onClick={onClose} ariaLabel="Close">
            ✕
          </Button>
        </div>
        <div style={{ padding: "var(--space-5)", overflowY: "auto" }}>{children}</div>
      </aside>
    </>
  );
}

/* --------------------------------------------------------------- form */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && !error ? <span className="field__hint">{hint}</span> : null}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  type = "text",
  error,
  autoFocus,
  onEnter,
}: {
  readonly id?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly type?: string;
  readonly error?: boolean;
  readonly autoFocus?: boolean;
  readonly onEnter?: () => void;
}) {
  return (
    <input
      id={id}
      className="input"
      type={type}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      aria-invalid={error ? true : undefined}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={
        onEnter
          ? (event) => {
              if (event.key === "Enter") onEnter();
            }
          : undefined
      }
    />
  );
}

/* --------------------------------------------------------------- toast */

export interface Toast {
  readonly id: string;
  readonly message: string;
  readonly tone: "positive" | "danger" | "warning";
}

interface ToastContextValue {
  readonly toasts: readonly Toast[];
  readonly push: (message: string, tone?: Toast["tone"]) => void;
  readonly dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: Toast["tone"] = "positive") => {
      counter.current += 1;
      const id = `t${counter.current}`;
      setToasts((current) => [...current, { id, message, tone }]);
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "fixed",
          right: "var(--space-5)",
          bottom: "var(--space-5)",
          zIndex: 90,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`banner${toast.tone === "danger" ? " banner--danger" : ""}`}
            style={{ margin: 0, minWidth: "260px" }}
          >
            <span>{toast.message}</span>
            <span className="banner__spacer" />
            <Button variant="ghost" size="sm" onClick={() => dismiss(toast.id)} ariaLabel="Dismiss">
              ✕
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside a ToastProvider.");
  return value;
}
