import { type ReactNode } from "react";
import { Box } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button, Card, EmptyState, LoadingBlock, PageHeader, StatusBadge, type StatusTone } from "@/components/ui-kit";

/** Safe date rendering for optional provider timestamps. */
export function formatDate(value?: string | null, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return withTime ? date.toLocaleString() : date.toLocaleDateString();
}

export function formatValue(value?: string | number | null) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

/** The organization that scopes every resource query in the control plane. */
export function useOrganizationId() {
  const organizations = trpc.workspace.organizations.useQuery(undefined, { retry: false });
  return {
    organizationId: organizations.data?.[0]?.id as string | undefined,
    organization: organizations.data?.[0],
    isLoading: organizations.isLoading,
    error: organizations.error,
  };
}

export function Header({ title, crumb, description, action }: { title: string; crumb?: string; description?: ReactNode; action?: ReactNode }) {
  return <PageHeader title={title} crumb={crumb} description={description} action={action} />;
}

export function Empty({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return <EmptyState title={title} body={body} action={action ? <Button variant="primary" onClick={onAction}>{action}</Button> : undefined} />;
}

export function ComingSoon({ title, body }: { title: string; body: string }) {
  return <Card><Empty title={`${title} is not configured`} body={body} /></Card>;
}

export function toneForStatus(status?: string | null): StatusTone {
  if (!status) return "neutral";
  if (["ready", "active", "success", "completed", "healthy", "passing"].includes(status)) return "ready";
  if (["building", "queued", "pending", "provisioning", "warning", "degraded"].includes(status)) return "building";
  if (["error", "failed", "failure", "unhealthy", "canceled"].includes(status)) return "error";
  return "neutral";
}

export function SectionShell({ title, crumb, description, action, children, isLoading, error }: { title: string; crumb?: string; description?: string; action?: ReactNode; children: ReactNode; isLoading?: boolean; error?: unknown }) {
  if (isLoading) return <><Header title={title} crumb={crumb} /><LoadingBlock rows={5} /></>;
  if (error) return <><Header title={title} crumb={crumb} /><EmptyState title="Unable to load this view" body={error instanceof Error ? error.message : "The control plane could not load this section."} /></>;
  return <><Header title={title} crumb={crumb} description={description} action={action} />{children}</>;
}

export function ResourceIcon({ children }: { children?: ReactNode }) {
  return <span className="ds-row-icon">{children ?? <Box size={15} />}</span>;
}

export { StatusBadge };
