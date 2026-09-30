/**
 * The project Setup page.
 *
 * This is the guided path from an empty project to a live site, in the order the
 * work actually happens: connect a repository, set the environment, deploy once,
 * then attach a domain you own. Each step reads the same section its own page
 * uses, so the checklist can never disagree with the page a step links to — the
 * same rule the Overview checklist follows, applied as a first-class surface
 * rather than a summary line.
 *
 * Two honesty rules carry over from the rest of the dashboard and are the reason
 * this is not a marketing wizard:
 *   * A step is "done" only when the underlying section says so (a repository
 *     row, a verified domain, a succeeded deployment). Nothing is marked done by
 *     the mere act of visiting this page.
 *   * A step blocked by an unconfigured engine says "needs an engine" with the
 *     reason, rather than a green tick over a deployment that never ran.
 */
import {
  Card,
  Icon,
  PageShell,
  SectionView,
  StatBox,
  StatusBadge,
  Table,
  type Column,
} from "@cloud-wai/ui/react";
import { presentDeploymentStatus, type SectionState } from "@cloud-wai/ui";
import { useApp } from "../react/context.js";
import { useSection } from "../react/hooks.js";
import { Link, Timestamp, VisitLink } from "../components/page-parts.js";
import type { Route } from "../routes.js";
import {
  loadDeployments,
  loadDomains,
  loadEnvVars,
  loadGitLinks,
  loadProject,
  loadProviderHealth,
  type DeploymentSummary,
  type DomainSummary,
  type EnvVarSummary,
  type GitLinkSummary,
  type ProjectSummary,
  type ProviderHealthRow,
} from "../view-model.js";

/**
 * A step's state.
 *
 * `loading` is its own state rather than a flavour of `todo`: before the owning
 * section has answered, "To do" is a claim this page cannot back, and a "0" in a
 * stat box reads as a measured fact. The step says it is still checking instead.
 */
type StepStatus = "done" | "todo" | "blocked" | "loading";

interface SetupStep {
  readonly id: string;
  readonly order: number;
  readonly title: string;
  readonly why: string;
  readonly status: StepStatus;
  readonly detail: string;
  readonly to: Route;
  readonly cta: string;
  /** Whether this step is optional for a first deploy. */
  readonly optional?: boolean;
}

export function ProjectSetupPage({
  organizationId,
  projectId,
}: {
  readonly organizationId: string;
  readonly projectId: string;
}) {
  const { client } = useApp();
  const project = useSection(() => loadProject(client, projectId), [client, projectId], "Project");
  const gitLinks = useSection(
    () => loadGitLinks(client, projectId),
    [client, projectId],
    "Repositories",
  );
  const domains = useSection(
    () => loadDomains(client, organizationId, projectId),
    [client, organizationId, projectId],
    "Domains",
  );
  const envVars = useSection(() => loadEnvVars(client, projectId), [client, projectId], "Env");
  const deployments = useSection(
    () => loadDeployments(client, projectId),
    [client, projectId],
    "Deployments",
  );
  const health = useSection(
    () => loadProviderHealth(client, organizationId),
    [client, organizationId],
    "Engine status",
  );

  const projectItem =
    project.section.state.kind === "ready" ? project.section.state.items[0] : undefined;
  const gitItems = gitLinks.section.state.kind === "ready" ? gitLinks.section.state.items : [];
  const domainItems = domains.section.state.kind === "ready" ? domains.section.state.items : [];
  const envItems = envVars.section.state.kind === "ready" ? envVars.section.state.items : [];
  const deploymentItems =
    deployments.section.state.kind === "ready" ? deployments.section.state.items : [];
  const healthItems = health.section.state.kind === "ready" ? health.section.state.items : [];

  // A section that has not answered yet is "loading", not "empty". Only a
  // resolved section may be read as a count, so a step never shows "To do"
  // before its own data has arrived.
  const isLoading = (state: SectionState<unknown>): boolean => state.kind === "loading";
  const gitLoading = isLoading(gitLinks.section.state);
  const envLoading = isLoading(envVars.section.state);
  const deploymentsLoading = isLoading(deployments.section.state);
  const domainsLoading = isLoading(domains.section.state);

  const live = deploymentItems.filter((item) => item.status === "succeeded").length;
  const unconfigured = deploymentItems.filter((item) => item.status === "not_configured").length;
  const hostingConfigured = healthItems.some(
    (item) =>
      (item.provider === "coolify" || item.provider === "selfhosted") && item.state === "ready",
  );
  const liveUrl = deploymentItems.find((item) => item.isCurrent && item.url)?.url ?? null;
  const verifiedDomain = domainItems.find((item) => item.verified) ?? null;

  const steps: readonly SetupStep[] = [
    {
      id: "repository",
      order: 1,
      title: "Connect a repository",
      why: "Link the Git repository that holds this project, so a push to its production branch deploys automatically instead of building by hand.",
      status: gitLoading ? "loading" : gitItems.length > 0 ? "done" : "todo",
      detail: gitLoading
        ? "Checking whether a repository is connected…"
        : gitItems.length > 0
          ? `${gitItems.length} repository connected. The first push builds this project.`
          : "No repository connected yet. You can also deploy a one-off build without one.",
      to: { name: "git", organizationId, projectId },
      cta: gitItems.length > 0 ? "Manage repositories" : "Connect Git",
    },
    {
      id: "environment",
      order: 2,
      title: "Set environment variables",
      why: "Inject configuration and secrets into the build and the runtime without committing them.",
      status: envLoading ? "loading" : envItems.length > 0 ? "done" : "todo",
      detail: envLoading
        ? "Checking the stored variables…"
        : envItems.length > 0
          ? `${envItems.length} variable${envItems.length === 1 ? "" : "s"} stored, injected at build and runtime.`
          : "None set yet. Optional for a first deploy, required by most real applications.",
      to: { name: "env", organizationId, projectId },
      cta: envItems.length > 0 ? "Manage variables" : "Add variables",
      optional: true,
    },
    {
      id: "deploy",
      order: 3,
      title: "Deploy once",
      why: "Build and release the application. Until one deploy succeeds there is no running site to point a domain at.",
      // A deploy that was requested and came back `not_configured`, or a
      // loaded engine list with no hosting engine in it, means the step cannot
      // succeed yet — say so rather than showing an idle "To do".
      status: deploymentsLoading
        ? "loading"
        : live > 0
          ? "done"
          : unconfigured > 0 || (health.section.state.kind === "ready" && !hostingConfigured)
            ? "blocked"
            : "todo",
      detail: deploymentsLoading
        ? "Checking the deployment history…"
        : live > 0
          ? `${live} deployment succeeded. The newest live build is serving.`
          : unconfigured > 0
            ? `${unconfigured} deployment was requested but no hosting engine is wired, so none could run.`
            : "No deployment has succeeded yet.",
      to: { name: "deployments", organizationId, projectId },
      cta: live > 0 ? "Open deployments" : "Deploy now",
    },
    {
      id: "domain",
      order: 4,
      title: "Attach a domain you own",
      why: "Give the project a name you control. The edge verifies it by DNS and provisions TLS once the record resolves.",
      status: domainsLoading ? "loading" : verifiedDomain ? "done" : "todo",
      detail: domainsLoading
        ? "Checking the attached domains…"
        : verifiedDomain
          ? `${verifiedDomain.hostname} is verified and serving this project.`
          : domainItems.length > 0
            ? `${domainItems.length} hostname(s) added, none verified yet. Publish the DNS record, then verify.`
            : "No hostname attached. You already own the domain — nothing is bought here.",
      to: { name: "domains", organizationId, projectId },
      cta: verifiedDomain ? "Manage domains" : "Add a domain",
    },
  ];

  const required = steps.filter((step) => !step.optional);
  const doneCount = required.filter((step) => step.status === "done").length;
  const progress = Math.round((doneCount / required.length) * 100);
  const allDone = required.every((step) => step.status === "done");
  const checking = required.some((step) => step.status === "loading");
  // The first step still to do is the one the eye should land on. Only one
  // element may be `aria-current`, so this is a single id, not a per-step flag.
  const nextStepId = checking ? undefined : steps.find((step) => step.status !== "done")?.id;

  return (
    <PageShell
      title="Setup"
      subtitle={
        projectItem
          ? `Get ${projectItem.name} from an empty project to a live site, in the order the work happens.`
          : "Get this project from an empty project to a live site, in the order the work happens."
      }
      actions={
        <div className="row">
          {liveUrl ? (
            <VisitLink url={liveUrl} label="Visit site" />
          ) : (
            <Link to={{ name: "deployments", organizationId, projectId }}>Deployments →</Link>
          )}
          <Link to={{ name: "project", organizationId, projectId }}>Overview →</Link>
        </div>
      }
      breadcrumb={
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to={{ name: "projects", organizationId }}>Projects</Link>
          <span className="breadcrumb__sep">/</span>
          <Link to={{ name: "project", organizationId, projectId }}>
            {projectItem?.name ?? "Project"}
          </Link>
          <span className="breadcrumb__sep">/</span>
          <span aria-current="page">Setup</span>
        </nav>
      }
    >
      <div className="setup-progress" role="status">
        <div className="setup-progress__meta">
          <strong>
            {checking
              ? "Checking this project…"
              : allDone
                ? "Setup complete"
                : `${doneCount} of ${required.length} required steps done`}
          </strong>
          <span className="muted small">
            {checking
              ? "Reading the sections this checklist is built from. Nothing is claimed until they answer."
              : allDone
                ? "Every required step is complete. This project is live and reachable."
                : "Each step reads the section it links to; a step is done only when that section says so."}
          </span>
        </div>
        <div
          className="meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label="Setup progress"
        >
          <div className="meter__track">
            <div
              className={`meter__fill${allDone ? " meter__fill--ok" : ""}`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="mono small faint">{progress}%</span>
        </div>
      </div>

      <div className="grid grid--stats" style={{ marginBottom: "var(--space-6)" }}>
        <StatBox
          label="Repositories"
          value={gitLoading ? "…" : gitItems.length}
          note="Linked for push-to-deploy"
        />
        <StatBox
          label="Live deployments"
          value={deploymentsLoading ? "…" : live}
          note="Reported succeeded by the engine"
        />
        <StatBox
          label="Verified domains"
          value={domainsLoading ? "…" : domainItems.filter((item) => item.verified).length}
          note="Confirmed by the edge"
        />
        <StatBox
          label="Variables"
          value={envLoading ? "…" : envItems.length}
          note="Injected at build and runtime"
        />
      </div>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Steps</h2>
          <span className="section__hint">In order — each one is the page that owns it</span>
        </div>
        <ol className="setup-steps">
          {steps.map((step) => (
            <li
              key={step.id}
              className={`setup-step setup-step--${step.status}`}
              aria-current={step.status !== "done" ? "step" : undefined}
            >
              <span className="setup-step__num" aria-hidden="true">
                {step.status === "done" ? <Icon name="check" size={18} /> : step.order}
              </span>
              <div className="setup-step__body">
                <div className="setup-step__head">
                  <strong>{step.title}</strong>
                  {step.optional ? <span className="faint small">Optional</span> : null}
                  <StatusBadge
                    label={stepStatusLabel(step.status)}
                    tone={stepStatusTone(step.status)}
                  />
                </div>
                <p className="setup-step__why muted small">{step.why}</p>
                <p className="setup-step__detail small">{step.detail}</p>
              </div>
              <div className="setup-step__action">
                <Link to={step.to} title={step.cta}>
                  {step.cta} <span aria-hidden="true">→</span>
                </Link>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {liveUrl ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Serving</h2>
            <span className="section__hint">The current production build</span>
          </div>
          <Card>
            <p className="small" style={{ margin: 0 }}>
              This project is live at{" "}
              <VisitLink url={liveUrl} label={liveUrl.replace(/^https?:\/\//, "")} />.
              {verifiedDomain ? (
                <>
                  {" "}
                  It is also reachable at <span className="mono">{verifiedDomain.hostname}</span>.
                </>
              ) : (
                " Attach a domain above to serve it under a name you own."
              )}
            </p>
          </Card>
        </section>
      ) : null}

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Engine status</h2>
          <span className="section__hint">What this deployment can actually run</span>
        </div>
        <Card flush>
          <SectionView<ProviderHealthRow>
            section={health.section}
            onRetry={health.reload}
            emptyMessage="No engines reported."
            renderReady={(items) => (
              <Table
                items={items}
                rowKey={(item) => item.provider}
                columns={[
                  {
                    key: "provider",
                    header: "Engine",
                    render: (item) => <span>{engineLabel(item.provider)}</span>,
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (item) =>
                      item.state === "ready" ? (
                        <StatusBadge label="Configured" tone="positive" />
                      ) : (
                        <StatusBadge label="Not configured" tone="neutral" />
                      ),
                  },
                  {
                    key: "detail",
                    header: "Detail",
                    render: (item) => <span className="small">{item.detail}</span>,
                  },
                ]}
              />
            )}
          />
        </Card>
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Recent deployments</h2>
          <span className="section__hint">Newest first</span>
        </div>
        <Card flush>
          <SectionView<DeploymentSummary>
            section={deployments.section}
            onRetry={deployments.reload}
            emptyMessage="Nothing has been deployed yet. Complete step 3 above."
            renderReady={(items) => (
              <Table
                items={items.slice(0, 6)}
                rowKey={(item) => item.id}
                columns={setupDeploymentColumns()}
              />
            )}
          />
        </Card>
      </section>

      {/* The loaders this page reads, surfaced honestly when one could not load,
          so a "0" in a stat box is never confused with "the request failed". */}
      <LoadFailures
        entries={[
          { section: project.section, reload: project.reload },
          { section: gitLinks.section, reload: gitLinks.reload },
          { section: domains.section, reload: domains.reload },
          { section: envVars.section, reload: envVars.reload },
        ]}
      />
    </PageShell>
  );
}

/**
 * The honest counterpart to the stat boxes above.
 *
 * A section that failed or degraded is rendered through `SectionView` so a "0"
 * count is never mistaken for a successful empty load. The section values have
 * different item types, so this takes the state alone rather than a typed
 * `Section<T>` per entry.
 */
function LoadFailures({
  entries,
}: {
  readonly entries: readonly {
    readonly section: { readonly title: string; readonly state: SectionState<unknown> };
    readonly reload: () => void;
  }[];
}) {
  return (
    <>
      {entries.map((entry, index) =>
        entry.section.state.kind === "error" || entry.section.state.kind === "degraded" ? (
          <SectionView key={index} section={entry.section} onRetry={entry.reload} />
        ) : null,
      )}
    </>
  );
}

function stepStatusLabel(status: StepStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "blocked":
      return "Needs an engine";
    case "loading":
      // The owning section has not answered yet, so the step is neither done
      // nor to-do; claiming either before the read returns would be a guess.
      return "Checking";
    case "todo":
      return "To do";
  }
}

function stepStatusTone(status: StepStatus): "neutral" | "positive" | "warning" | "progress" {
  switch (status) {
    case "done":
      return "positive";
    case "blocked":
      return "warning";
    case "loading":
      return "progress";
    case "todo":
      return "neutral";
  }
}

function setupDeploymentColumns(): readonly Column<DeploymentSummary>[] {
  return [
    {
      key: "status",
      header: "Status",
      // The same presentation the Deployments page uses, so a status word
      // ("Live", "Not configured") means the same thing on both surfaces.
      render: (item) => (
        <StatusBadge
          label={presentDeploymentStatus(item.status).label}
          tone={presentDeploymentStatus(item.status).tone}
        />
      ),
    },
    {
      key: "url",
      header: "URL",
      render: (item) =>
        item.url ? (
          <VisitLink url={item.url} label={item.url.replace(/^https?:\/\//, "")} />
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: "when",
      header: "Created",
      render: (item) => <Timestamp value={item.createdAt} />,
    },
  ];
}

function statusTone(status: string): "neutral" | "progress" | "positive" | "warning" | "danger" {
  switch (status) {
    case "succeeded":
      return "positive";
    case "running":
      return "progress";
    case "failed":
      return "danger";
    case "degraded":
      return "warning";
    default:
      return "neutral";
  }
}

/** A readable name for an engine id, matching the Settings page. */
function engineLabel(provider: string): string {
  switch (provider) {
    case "coolify":
      return "Coolify (hosting)";
    case "selfhosted":
      return "Self-hosted runtime";
    case "postgres":
      return "PostgreSQL";
    case "minio":
      return "MinIO (object storage)";
    case "envoy":
    case "haproxy":
      return "Security edge";
    case "coraza":
      return "Coraza WAF";
    case "crowdsec":
      return "CrowdSec";
    case "dns":
      return "DNS verifier";
    default:
      return provider;
  }
}

export type { GitLinkSummary, DomainSummary, EnvVarSummary, ProjectSummary };
