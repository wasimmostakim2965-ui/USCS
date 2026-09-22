import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";

export function Button({ variant = "secondary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={`ui-button ui-button-${variant} ${className}`} {...props} />;
}
export function Card({ children, className = "", ...props }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return <section className={`ui-card ${className}`} {...props}>{children}</section>;
}
export function PageHeader({ title, breadcrumb, action }: { title: string; breadcrumb?: ReactNode; action?: ReactNode }) {
  return <header className="ui-page-header"><div><div className="ui-breadcrumb">{breadcrumb ?? title}</div><h1>{title}</h1></div>{action}</header>;
}
export function StatusBadge({ children, status = "neutral" }: { children: ReactNode; status?: "ready" | "building" | "error" | "neutral" }) {
  return <span className={`ui-status ui-status-${status}`}><i />{children}</span>;
}
export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="ui-empty"><div className="ui-empty-icon"><CircleAlert size={18} /></div><h3>{title}</h3><p>{body}</p>{action}</div>;
}
export function LoadingSkeleton({ rows = 4 }: { rows?: number }) {
  return <div className="ui-skeleton-list" aria-label="Loading"><LoaderCircle className="ui-spin" size={18} />{Array.from({ length: rows }, (_, index) => <span key={index} />)}</div>;
}
export function ErrorState({ message }: { message: string }) {
  return <EmptyState title="Unable to load this view" body={message} />;
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input className="ui-input" {...props} />; }
export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) { return <select className="ui-input" {...props}>{children}</select>; }
export function Tabs({ items, active, onChange }: { items: Array<{ label: string; value: string }>; active: string; onChange: (value: string) => void }) {
  return <nav className="ui-tabs" aria-label="Page tabs">{items.map(item => <button key={item.value} className={item.value === active ? "active" : ""} onClick={() => onChange(item.value)}>{item.label}</button>)}</nav>;
}
export function DataTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return <div className="ui-table-wrap"><table className="ui-table"><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
export function Checklist({ items }: { items: Array<{ label: string; complete: boolean; detail?: string }> }) {
  return <div className="ui-checklist">{items.map(item => <div className="ui-check" key={item.label}><span className={item.complete ? "complete" : ""}>{item.complete && <Check size={13} />}</span><div><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</div><ChevronRight size={14} /></div>)}</div>;
}
export function AppShell({ children }: { children: ReactNode }) { return <div className="ui-app-shell">{children}</div>; }
export function Drawer({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) { return open ? <div className="ui-overlay" onMouseDown={onClose}><aside className="ui-drawer" onMouseDown={event => event.stopPropagation()}><div className="ui-drawer-head"><h2>{title}</h2><Button variant="ghost" onClick={onClose}>Close</Button></div>{children}</aside></div> : null; }
