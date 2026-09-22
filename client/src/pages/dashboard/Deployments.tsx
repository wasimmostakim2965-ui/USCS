import { Rocket } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Empty, Header, Status } from "./shared";
export default function Deployments({ onOpen }: { onOpen?: (id?: string) => void }) {
  const query = trpc.deployments.list.useQuery(undefined, { retry: false });
  const items = query.data ?? [];
  return <><Header title="Deployments" /><div className="vc-card"><div className="vc-table-head"><span>Deployment</span><span>Environment</span><span>Status</span><span>Created</span></div>{query.isLoading ? <div className="vc-loading-row">Loading deployment records…</div> : items.length ? items.map(item => <button className="vc-list-row" key={item.id} onClick={() => onOpen?.(item.id)}><Rocket size={16} /><span><strong>{item.commit_sha || item.source_branch || item.id.slice(0, 8)}</strong><small>{item.source_repository || "Source not configured"}</small></span><span>{item.environment}</span><Status good={item.status === "ready"}>{item.status}</Status><small>{new Date(item.created_at).toLocaleString()}</small></button>) : <Empty title="No deployments yet" body="Deployment records will appear after a real hosting adapter is configured." />}</div></>;
}
