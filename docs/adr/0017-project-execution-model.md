# ADR-0017 — A project's execution model: container or serverless

- Status: accepted
- Date: 2026-09-25

## Context

Until now a Cloud Wai project had exactly one execution model: a long-lived
container built from a git repository on the container engine (Coolify,
ADR-0002/0009). Everything downstream assumed that shape — `deployments.create`
built a Coolify application, rollback named a git commit, env vars were pushed to
Coolify's env API, and the edge forwarded to a private origin on the host.

The brief asks for the platform to be one step above Vercel, and Vercel's default
product is a *function*: code that runs on demand, scales to zero, and has no
always-on origin at all. Two consequences make this more than a feature:

1. **The origin-isolation property changes kind.** On the container model the
   origin is a private IP that the edge is the only route to (gate 6). On a
   serverless model there is no host to reach: the edge forwards to a function
   URL. Isolation stops being a firewall rule and becomes structural.
2. **The engine API is a different machine.** Coolify builds from git. Lambda
   does not build anything: it is handed an already-built artifact (a zip in S3
   or an image in ECR). A deploy that "works" by quietly container-building a
   project the customer asked to run serverless would be the exact class of lie
   this repository exists to prevent.

The remaining question was how to add a second execution model without either
leaking engine-specific branches into every caller, or pretending the two engines
are interchangeable when their operations genuinely differ.

## Decision

1. **The execution model is a property of the project, not of the request.** A
   `projects.execution_model` column (`container` default, `serverless`)
   holds the customer's own choice (migration `0017`). It is a *writable* column
   — it is customer input — and is deliberately not in the engine-column guard's
   frozen list (`0006`), unlike `projects.provider` / `provider_resource_id`,
   which remain the engine's answer and stay frozen. The worker drains a
   deployment job with no session, so the model cannot live only in the browser:
   a queued job would otherwise have no honest way to pick its engine.

2. **A serverless engine is a distinct provider and a distinct adapter.** `lambda`
   and `microvm` are new `ProviderName`s (`packages/contracts/src/ids.ts`),
   separate from the container providers because the isolation boundary and the
   API differ; an adapter for one must not silently answer for the other. The
   serverless adapter (`packages/adapters/src/serverless.ts`) signs every call
   with SigV4 (`aws-signature.ts`, pinned against AWS's published test vector)
   and resolves credentials **per organization**, so one tenant's function is
   unreachable with another tenant's keys — the same boundary the Coolify
   adapter keeps.

3. **One deployment port over two models.** `DeploymentEngine`
   (`packages/adapters/src/execution-router.ts`) is the seam: a caller asks for
   "the deployment engine for this project's execution model" and receives a
   single uniform port. Which adapter is behind it is decided in one place, so no
   router, procedure or worker imports an engine directly. The port is
   deliberately the *intersection* of the two adapters — env-var management and
   preview bookkeeping stay with the container adapter and are not part of it.

4. **The honesty rules are structural, not comments.** They are enforced by the
   router and covered by tests (`tests/engines/execution-router.test.ts`):
   - A `serverless` project is **never** handed to the container engine. If the
     serverless engine is unconfigured, the result is `not_configured`.
   - Lambda does not build from git. A serverless deploy requires a built
     artifact and refuses without one; the build step (CodeBuild) is a separate
     engine and stays `not_configured` until wired, so the gap is visible rather
     than faked.
   - Rollback and cancel are container concepts. On serverless they report
     `not_configured` with that reason, never a fabricated success.

5. **The adapter calls only routes the pinned engine exposes.** As with Coolify
   (gate 14), the serverless adapter's routes are checked against the
   authoritative model for each service — botocore's `service-2.json`, from which
   every AWS SDK is generated. `scripts/fetch-aws-routes.py` regenerates
   `tests/fixtures/lambda-routes.json` at a pinned botocore commit, and
   `tests/engines/lambda-routes.test.ts` drives the adapter's whole lifecycle
   against it. This check found two real bugs on first write: the CloudWatch Logs
   read omitted the `X-Amz-Target` header that names the operation (Logs is
   JSON-RPC, not REST), and `CreateFunction` for an image artifact omitted
   `PackageType: "Image"`, which Lambda requires or it rejects an `ImageUri` code.

6. **The control plane surfaces the choice, the engines report the result.** A
   project picks its execution model at creation and can change it in project
   settings, both through the same control. The overview states which model the
   project runs on. Which specific resource an engine created remains the
   engine's answer, frozen against client writes.

## Consequences

- A deployment, rollback, cancel and log read all route through
  `deploymentEngineFor`, so a serverless project's operations are answered by the
  machine that runs it — never by Coolify.
- The worker's env reconciliation pushes through the container adapter's env API
  and therefore runs only for a container deploy; a serverless function's
  environment belongs to its own engine.
- Serverless execution stays `not_configured` end to end until AWS credentials
  and a build step exist. That is the honest state, and it is what the dashboard
  shows.
- Gate 6 (deny direct origin) is not weakened: the container model keeps its
  private origin, and the serverless model has no origin to reach.

## Alternatives considered

- **A Coolify build pack for functions.** Rejected: it would run the wrong
  execution model and report it as the requested one, which is the failure mode
  the honesty rule forbids.
- **Letting each caller branch on the model.** Rejected: the same branch would be
  written in the API, the worker and every procedure, and would drift. One port,
  one decision point.
- **Making `execution_model` an engine-observed, frozen column.** Rejected: it is
  the customer's choice, not the engine's answer. The engine reports the resource
  it created; the customer picks the model.
