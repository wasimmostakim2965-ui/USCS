# ADR-0012 — Release-gate evidence, and why some gates stay open

- Status: accepted
- Date: 2026-09-23

## Context

The blueprint lists thirteen release gates. A gate is only meaningful if a
reviewer can check it, and the failure mode this project is most exposed to is a
gate that gets marked "done" because nobody looked. Two specific pressures
make that likely here:

1. Six of the gates involve an external system — an edge, containers, a real
   backup destination — that this deployment has no credentials for. It is easy
   to write a test that asserts the property against a fake and then report the
   gate as passing.
2. A "load test" that measures a `for` loop, or that reports an average, would
   satisfy the wording of gate 11 without measuring anything a user feels.

## Decision

Gate status is recorded in [`docs/release-gates.md`](../release-gates.md), one
row per gate, each pointing at the command or test that proves it. A gate has
exactly two states:

- **Enforced** — a running check fails the build when the property breaks.
- **Open — needs an engine** — the property depends on a system not configured
  here. The repository proves the contract (the adapter cannot report false
  success), and the gate stays open.

A gate in this repository may not be marked Enforced by a test that only runs
against a fake. If the property needs a real engine, the gate is Open and the
contract test is cited as partial evidence.

For gate 11 specifically, the load probe runs the real router and the real
procedure table under concurrency, asserts every request succeeded before
reporting percentiles, and prints p50/p95/p99 plus throughput. The percentile
maths uses nearest-rank over raw samples, so a reported p99 is always an
observed duration. The reported figure is labelled a harness proof, not a
capacity claim: the database, network and TLS costs are absent.

## Consequences

- Five gates (6, 7, 8, 9, and the runtime half of gate 1) are recorded as open.
  A release cannot be cut on this repository alone; it needs a configured
  environment and an operational validation.
- The gate table is now a document a reviewer can audit in minutes, and the
  "do not remove an open row" rule is written down so the table cannot quietly
  shrink.
- When an engine is configured, the gate's evidence changes from a contract test
  to a real-system test in the same commit that configures it.

## Alternatives considered

- **Mark the six engine-dependent gates Enforced against fakes.** Rejected: it
  would make the release gates decorative, which is exactly the outcome the
  blueprint warns about.
- **Leave gate status implicit in commit messages.** Rejected: it is not
  checkable, and it is what allowed the earlier phases to need a status
  reconciliation.
- **Report a single average latency.** Rejected: an average hides the tail where
  timeouts live.
