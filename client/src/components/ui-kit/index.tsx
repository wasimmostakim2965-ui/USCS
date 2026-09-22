import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { Check, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({ variant = "secondary", size = "md", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "md" | "sm" }) {
  const classes = ["ds-btn", `ds-btn-${variant}`, size === "sm" ? "ds-btn-sm" : "", className].filter(Boolean).join(" ");
  return <button className={classes} {...props} />;
}

export function IconButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`ds-btn ds-btn-ghost ds-btn-icon ${className}`} {...props} />;
}

export function Card({ children, className = "", ...props }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return <section className={`ds-card ${className}`} {...props}>{children}</section>;
}

export function CardHead({ title, eyebrow, description, action }: { title: ReactNode; eyebrow?: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <div className="ds-card-head"><div style={{ minWidth: 0 }}>{eyebrow ? <span className="ds-eyebrow">{eyebrow}</span> : null}<h2>{title}</h2>{description ? <p>{description}</p> : null}</div>{action}</div>;
}

export function CardBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ds-card-body ${className}`}>{children}</div>;
}

export function PageHeader({ title, crumb, description, action }: { title: ReactNode; crumb?: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <header className="ds-page-head"><div style={{ minWidth: 0 }}><div className="ds-crumb">{crumb ?? title}</div><h1>{title}</h1>{description ? <p>{description}</p> : null}</div>{action}</header>;
}

export function Section({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return <div className="ds-section"><div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>{action}</div>;
}

export type StatusTone = "neutral" | "ready" | "building" | "error";

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={`ds-badge ${tone === "neutral" ? "" : `ds-badge-${tone}`}`}><i />{children}</span>;
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return <div className="ds-stat"><small>{label}</small><strong>{value}</strong>{hint ? <span>{hint}</span> : null}</div>;
}

export function EmptyState({ title, body, action }: { title: ReactNode; body: ReactNode; action?: ReactNode }) {
  return <div className="ds-empty"><div className="ds-empty-icon"><CircleAlert size={18} /></div><h3>{title}</h3><p>{body}</p>{action}</div>;
}

export function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return <div className="ds-skeleton" aria-label="Loading" aria-busy="true"><div className="ds-spinner" style={{ display: "grid", placeItems: "center", color: "var(--ds-fg-muted)" }}><LoaderCircle size={18} /></div>{Array.from({ length: rows }, (_, index) => <span key={index} />)}</div>;
}

export function ErrorState({ message }: { message: string }) {
  return <EmptyState title="Unable to load this view" body={message} />;
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`ds-input ${className}`} {...props} />;
}

export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`ds-select ${className}`} {...props}>{children}</select>;
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <label className="ds-field"><span>{label}</span>{children}</label>;
}

export function Tabs({ items, active, onChange }: { items: Array<{ label: string; value: string }>; active: string; onChange: (value: string) => void }) {
  return <nav className="ds-tabs" aria-label="Page tabs">{items.map(item => <button key={item.value} className={`ds-tab ${item.value === active ? "is-active" : ""}`} aria-current={item.value === active} onClick={() => onChange(item.value)}>{item.label}</button>)}</nav>;
}

export function DataTable({ headers, rows }: { headers: ReactNode[]; rows: ReactNode[][] }) {
  return <div className="ds-table-wrap"><table className="ds-table"><thead><tr>{headers.map((header, index) => <th key={index}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}

export function Checklist({ items }: { items: Array<{ label: string; complete: boolean; detail?: string; onSelect?: () => void }> }) {
  return <div className="ds-checklist">{items.map(item => <button className="ds-check" key={item.label} onClick={item.onSelect} disabled={!item.onSelect} style={{ cursor: item.onSelect ? "pointer" : "default", textAlign: "left" }}><span className={`ds-check-mark ${item.complete ? "is-complete" : ""}`}>{item.complete ? <Check size={12} /> : null}</span><div><strong>{item.label}</strong>{item.detail ? <small>{item.detail}</small> : null}</div><ChevronRight size={15} color="var(--ds-fg-subtle)" /></button>)}</div>;
}

export function Callout({ title, body, icon, action }: { title: ReactNode; body: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return <div className="ds-callout">{icon ? <div className="ds-callout-icon">{icon}</div> : null}<div style={{ minWidth: 0, flex: 1 }}><strong>{title}</strong><p>{body}</p>{action ? <div style={{ marginTop: 12 }}>{action}</div> : null}</div></div>;
}

export function Meter({ value, tone = "ok" }: { value: number; tone?: "ok" | "warn" | "danger" }) {
  const clamped = Math.max(0, Math.min(100, value));
  return <div className={`ds-meter ${tone === "ok" ? "" : `is-${tone}`}`} role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${clamped}%` }} /></div>;
}

export function Drawer({ open, title, children, onClose }: { open: boolean; title: ReactNode; children: ReactNode; onClose: () => void }) {
  if (!open) return null;
  return <div onMouseDown={onClose} style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,.28)" }}><aside onMouseDown={event => event.stopPropagation()} style={{ position: "absolute", right: 0, top: 0, height: "100%", width: "min(520px,100%)", overflow: "auto", background: "var(--ds-surface)", borderLeft: "1px solid var(--ds-border)", padding: 20 }}><div className="ds-card-head" style={{ padding: "0 0 14px" }}><h2>{title}</h2><Button variant="ghost" size="sm" onClick={onClose}>Close</Button></div>{children}</aside></div>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="ds-mono">{children}</span>;
}
