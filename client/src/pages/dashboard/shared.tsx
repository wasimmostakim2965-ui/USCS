import { type ReactNode } from "react";
import { Box, ChevronRight } from "lucide-react";

export function Status({ children, good = false }: { children: ReactNode; good?: boolean }) {
  return <span className={`vc-status ${good ? "good" : ""}`}><i />{children}</span>;
}

export function Header({ title, crumb, action }: { title: string; crumb?: string; action?: ReactNode }) {
  return <div className="vc-page-head"><div><div className="vc-crumb">{crumb || title}</div><h1>{title}</h1></div>{action}</div>;
}

export function Empty({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return <div className="vc-empty"><div className="vc-empty-mark"><Box size={20} /></div><h3>{title}</h3><p>{body}</p>{action && <button className="vc-btn primary" onClick={onAction}>{action}<ChevronRight size={14} /></button>}</div>;
}

export function Stat({ label, value }: { label: string; value: string }) {
  return <div className="vc-stat"><small>{label}</small><strong>{value}</strong></div>;
}

export function ComingSoon({ title, body }: { title: string; body: string }) {
  return <div className="vc-card"><Empty title={`${title} is coming soon`} body={body} /></div>;
}
