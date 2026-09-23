/**
 * Shared page pieces.
 *
 * Small components every page uses so the sections look and behave the same
 * everywhere: a link that routes in-app, a relative timestamp, and the two
 * status presentations pages need (engine state, verification state).
 */
import type { ReactNode } from "react";
import { StatusBadge, type Tone } from "@cloud-wai/ui/react";
import { useApp } from "../react/context.js";
import { toPath, type Route } from "../routes.js";

/**
 * An in-app link.
 *
 * Left-clicks are handled by the router so the URL, the scroll position and the
 * focus all move together; modified clicks fall through to the browser so
 * "open in new tab" still works.
 */
export function Link({
  to,
  children,
  title,
}: {
  readonly to: Route;
  readonly children: ReactNode;
  readonly title?: string;
}) {
  const { router } = useApp();
  const path = toPath(to);
  return (
    <a
      href={`#${path}`}
      title={title}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        router.navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** A short, stable timestamp. Absolute date in the title for precision. */
export function Timestamp({ value }: { readonly value: string }) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="faint">—</span>;

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const label = () => {
    if (seconds < 45) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.round(seconds / 86400)}d ago`;
    return date.toISOString().slice(0, 10);
  };

  return (
    <time dateTime={value} title={date.toISOString()}>
      {label()}
    </time>
  );
}

/**
 * A deployment status, through `presentDeploymentStatus`.
 *
 * The tone comes from the shared mapping, which is what keeps
 * `not_configured` visually distinct from `failed`: it is a deployment fact,
 * not a customer error.
 */
export function DeploymentStatusBadge({
  status,
  label,
  tone,
}: {
  readonly status: string;
  readonly label?: string;
  readonly tone?: Tone;
}) {
  return <StatusBadge label={label ?? status} tone={tone ?? "neutral"} />;
}

/** A domain's verification state. An unverified domain is not an error. */
export function VerifiedBadge({ verified }: { readonly verified: boolean }) {
  return verified ? (
    <StatusBadge label="Verified" tone="positive" />
  ) : (
    <StatusBadge label="Unverified" tone="warning" />
  );
}

/** A data resource's lifecycle state. */
export function DataStateBadge({ state }: { readonly state: string }) {
  const tone: Tone =
    state === "ready"
      ? "positive"
      : state === "provisioning"
        ? "progress"
        : state === "failed"
          ? "danger"
          : state === "degraded"
            ? "warning"
            : "neutral";
  return <StatusBadge label={state} tone={tone} />;
}

/** A key's lifecycle. A revoked key is inactive, which is not a failure. */
export function ApiKeyStateBadge({ revokedAt }: { readonly revokedAt: string | null }) {
  return revokedAt ? (
    <StatusBadge label="Revoked" tone="neutral" />
  ) : (
    <StatusBadge label="Active" tone="positive" />
  );
}
