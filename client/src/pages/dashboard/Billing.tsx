import { CreditCard, FileText, Gauge, LockKeyhole, Rocket } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button, Card, CardBody, CardHead, EmptyState, ErrorState, LoadingBlock, PageHeader, Stat, StatusBadge, Tabs } from "@/components/ui-kit";
import { formatDate, toneForStatus, useOrganizationId } from "./shared";

type BillingTab = "usage" | "invoices" | "payment-methods";
const tabs: BillingTab[] = ["usage", "invoices", "payment-methods"];

export default function Billing({ routeParts, onNavigate }: { routeParts?: string[]; onNavigate?: (href: string) => void }) {
  const tab = tabs.includes(routeParts?.[1] as BillingTab) ? routeParts![1] as BillingTab : "usage";
  const { organizationId, organization } = useOrganizationId();

  const status = trpc.billing.status.useQuery(undefined, { retry: false });
  const usage = trpc.billing.usage.useQuery(organizationId ? { organizationId } : undefined, { enabled: Boolean(organizationId), retry: false });
  const invoices = trpc.billing.invoices.useQuery(organizationId ? { organizationId } : undefined, { enabled: Boolean(organizationId), retry: false });
  const methods = trpc.billing.paymentMethods.useQuery({ organizationId: organizationId ?? "00000000-0000-0000-0000-000000000000" }, { enabled: Boolean(organizationId), retry: false });
  const checkout = trpc.billing.checkout.useMutation({
    onSuccess: result => result.configured ? window.location.assign(result.url) : toast.info(result.reason),
    onError: error => toast.error(error.message),
  });

  const latest = usage.data?.[0];

  return <>
    <PageHeader
      title="Billing"
      crumb="Workspace / Billing"
      description={organization?.name ? `Usage, invoices and payment methods for ${organization.name}.` : "Usage, invoices and payment methods."}
      action={<Button variant="primary" disabled={!organizationId || checkout.isPending} onClick={() => organizationId && checkout.mutate({ organizationId, customerEmail: "billing@example.invalid", successUrl: window.location.href, cancelUrl: window.location.href })}><Rocket size={14} /> {checkout.isPending ? "Starting checkout…" : "Upgrade plan"}</Button>}
    />
    <div className="ds-grid-3" style={{ marginBottom: 16 }}>
      <Stat label="Plan" value={status.data?.plan.name ?? "Not configured"} />
      <Stat label="Deploy minutes" value={latest ? `${latest.deploy_minutes}` : "—"} />
      <Stat label="Estimated usage" value={latest ? `$${latest.estimated_amount}` : "$0"} />
    </div>
    <Tabs items={tabs.map(value => ({ label: value.replaceAll("-", " ").replace(/\b\w/g, character => character.toUpperCase()), value }))} active={tab} onChange={value => onNavigate?.(`/dashboard/billing/${value}`)} />

    {tab === "usage" ? <Card>
      <CardHead eyebrow="Plan limits" title={status.data?.plan.name ?? "Premium"} description={status.data?.message ?? "Billing provider status unavailable."} action={<StatusBadge tone={status.data?.configured ? "ready" : "neutral"}>{status.data?.configured ? "Configured" : "Not configured"}</StatusBadge>} />
      {usage.isLoading ? <LoadingBlock rows={3} /> : usage.error ? <ErrorState message={usage.error.message} /> : usage.data?.length ? (
        <div className="ds-list">{usage.data.map(period => (
          <div className="ds-row" key={String(period.id)}><span className="ds-row-icon"><Gauge size={15} /></span><span className="ds-row-main"><strong>{String(period.deploy_minutes)} deploy minutes</strong><small>{String(period.storage_gb)} GB storage · {String(period.bandwidth_gb)} GB bandwidth · period ending {formatDate(period.period_end as string)}</small></span><StatusBadge>${String(period.estimated_amount)}</StatusBadge></div>
        ))}</div>
      ) : <EmptyState title="No usage telemetry" body="Usage records appear once the billing provider reports a period." />}
      <CardBody><div className="ds-callout"><div className="ds-callout-icon"><LockKeyhole size={18} /></div><div><strong>Upgrade is gated safely</strong><p>The upgrade action never claims a purchase or payment while Stripe is not configured.</p></div></div></CardBody>
    </Card> : null}

    {tab === "invoices" ? <Card>
      <CardHead eyebrow="History" title="Invoices" />
      {invoices.isLoading ? <LoadingBlock rows={3} /> : invoices.error ? <ErrorState message={invoices.error.message} /> : invoices.data?.length ? (
        <div className="ds-list">{invoices.data.map(invoice => (
          <div className="ds-row" key={String(invoice.id)}><span className="ds-row-icon"><FileText size={15} /></span><span className="ds-row-main"><strong>{String(invoice.invoice_ref ?? "Provider invoice")}</strong><small>{String(invoice.amount)} {String(invoice.currency)} · issued {formatDate(invoice.issued_at as string)}</small></span><StatusBadge tone={toneForStatus(String(invoice.status))}>{String(invoice.status)}</StatusBadge></div>
        ))}</div>
      ) : <EmptyState title="No invoices" body="Invoices appear only after a configured billing provider emits them." />}
    </Card> : null}

    {tab === "payment-methods" ? <Card>
      <CardHead eyebrow="Payments" title="Saved methods" />
      {methods.isLoading ? <LoadingBlock rows={3} /> : methods.error ? <ErrorState message={methods.error.message} /> : methods.data?.length ? (
        <div className="ds-list">{methods.data.map(method => (
          <div className="ds-row" key={String(method.id)}><span className="ds-row-icon"><CreditCard size={15} /></span><span className="ds-row-main"><strong>{String(method.brand ?? method.provider)}</strong><small>{method.last4 ? `•••• ${String(method.last4)}` : "Provider reference not configured"}</small></span><StatusBadge tone={toneForStatus(String(method.status))}>{String(method.status)}</StatusBadge></div>
        ))}</div>
      ) : <EmptyState title="No payment method" body="Payment methods stay unavailable until the Stripe account and webhook contract are configured." />}
    </Card> : null}
  </>;
}
