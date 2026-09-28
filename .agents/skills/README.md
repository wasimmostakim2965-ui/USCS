# Project skills added to this workspace

These are third-party agent skills, imported with the OpenHands `add-skill`
mechanism (`git sparse checkout` of each skill directory) so an agent working in
this repository picks them up on demand. They are **guidance, not code**: they do
not change Cloud Wai's behaviour, schema or honesty rules. Nothing here runs at
build or runtime.

They were selected for four things the owner asked for — production-grade UI/UX,
sound logic and patterns, working safely in large systems without hallucination,
and an end-to-end production release discipline — and every entry was reviewed
before install (frontmatter sanity, no bidi/invisible characters, no
`curl|sh`/`base64 -d`/credential-exfiltration patterns).

## Provenance (pinned)

| Source repository | Commit | License |
|---|---|---|
| [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills) | [`19392f7a0826`](https://github.com/alirezarezvani/claude-skills/tree/19392f7a0826) | MIT |
| [obra/superpowers](https://github.com/obra/superpowers) | [`8ca22dba9a94`](https://github.com/obra/superpowers/tree/8ca22dba9a94) | MIT |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | [`2686b620fc1f`](https://github.com/addyosmani/agent-skills/tree/2686b620fc1f) | MIT |
| [anthropics/skills](https://github.com/anthropics/skills) | [`33375500bcea`](https://github.com/anthropics/skills/tree/33375500bcea) | see upstream (some source-available) |

Upstream licenses and notices remain with their authors; this file records where
each skill came from, not a relicense. To refresh a skill, re-run `/add-skill`
with the same URL; to update the pin, change the commit in the URL.

## What each skill is for

| Skill | Source | Use it when |
|---|---|---|
| `zero-hallucination-coder` | alirezarezvani | High-stakes change across existing code; ground every API/import in real structure, no invented symbols |
| `agent-harness` | alirezarezvani | Drive a goal to a *verified* close with machine-run checks, retries and a human escalation when budgets run out |
| `memory-engineering` | alirezarezvani | Designing/reviewing what an agent should remember and, crucially, what it should forget (`AGENTS.md`, memory stores) |
| `systematic-debugging` | superpowers | Any bug or failing test, before proposing a fix |
| `verification-before-completion` | superpowers | Before claiming "done/fixed/passing" — run the command, show the output |
| `test-driven-development` | superpowers | Building a feature where a failing test should come first |
| `writing-plans` | superpowers | Before a multi-step change |
| `brainstorming` | superpowers | Opening a design question before committing to an approach |
| `requesting-code-review` | superpowers | Before asking for review of a change |
| `frontend-ui-engineering` | addyosmani | Building or changing UI that must be accessible, responsive and production-quality |
| `security-and-hardening` | addyosmani | Untrusted input, auth, storage, OWASP Top Ten, dependency/supply-chain review |
| `shipping-and-launch` | addyosmani | Taking a change to a real release |
| `ci-cd-and-automation` | addyosmani | Pipeline and automation work |
| `observability-and-instrumentation` | addyosmani | Metrics, logs, traces |
| `spec-driven-development` | addyosmani | Turning a requirement into an agreed spec before code |
| `source-driven-development` | addyosmani | Working against real source of truth rather than assumptions |
| `context-engineering` | addyosmani | Shaping the context an agent works from (large codebases) |
| `planning-and-task-breakdown` | addyosmani | Decomposing a large task |
| `code-review-and-quality` | addyosmani | Reviewing for quality |
| `browser-testing-with-devtools` | addyosmani | Verifying a live browser surface |
| `webapp-testing` | anthropics | Driving a web app end to end in a test |

## Product, UX, business and behavioural design

These are the ones the owner asked for specifically: not merely "pretty UI" but
the *why* — how a user reads a screen, what reduces cognitive load, what builds
trust, and where a business metric is won or lost. The `alirezarezvani` library
ships them with real frameworks rather than slogans.

| Skill | Use it when |
|---|---|
| `marketing-psychology` | Applying persuasion/influence principles (reciprocity, anchoring, loss aversion) **ethically** — the skill itself says to surface scarcity only when it is real, because fake urgency backfires |
| `ux-researcher-designer` | Running a UX research pass and turning it into a design |
| `ui-design-system` | Building a token-based, scalable design system instead of one-off styles |
| `product-manager-toolkit` | Product framing: problem, scope, success metric |
| `experiment-designer` | Designing an honest A/B test and its decision rule |
| `landing-page-generator`, `page-cro`, `signup-flow-cro`, `onboarding-cro`, `form-cro`, `paywall-upgrade-cro` | Conversion work page by page — landing, signup, first-run, forms, upgrade |
| `copywriting`, `site-architecture` | Words and information architecture |
| `pricing-strategy` | Pricing and packaging decisions |
| `churn-prevention`, `customer-success-manager`, `revenue-operations` | Retention and the money side |
| `saas-metrics-coach` | The metrics that actually matter (activation, retention, NRR) |
| `analytics-tracking` | What to instrument so a claim is measurable |
| `competitive-teardown`, `competitive-intel` | Reading competitors honestly |
| `a11y-audit` | Accessibility as a requirement, not an afterthought |

**Ethics boundary (this repository's rule, not the skill's).** Persuasion is used
only to align what the user wants with what the product honestly is. No fake
scarcity, no fabricated countdowns, no dark patterns, no metric that counts work
an engine did not perform. Where a skill suggests a technique that would make the
dashboard show a state that is not the truth, this repository's honesty rules
(`AGENTS.md`, ADR-0010) win.

## Boundary

These skills live under `.agents/skills/` — **project** scope, so they apply to
conversations using this workspace only. They are not global. Do not add a skill
whose `name` duplicates another loaded skill (OpenHands ignores duplicate names);
check the global list before adding.
