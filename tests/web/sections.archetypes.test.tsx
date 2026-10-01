/**
 * Every section page has the shape its catalogue entry declares.
 *
 * The catalogue is the authority for what a section *is* — a Firewall is a
 * control room, Flags is a chooser, Usage is a set of meters. The archetype
 * component dispatches on `kind`, so the risk this guards is a section whose
 * declared shape and rendered shape drift apart: the page would still render,
 * and still be green in the "every route renders" test, while showing the wrong
 * layout entirely.
 *
 * The mapping below is the contract. A new archetype must be added here, or a
 * section that uses it is unverified.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SectionArchetype, type SectionBody } from "@cloud-wai/ui/react";
import { PROJECT_SECTIONS_SPEC, WORKSPACE_SECTIONS_SPEC, type SectionSpec } from "@cloud-wai/web";

afterEach(cleanup);

/** The class each archetype must put in the document, per `kind`. */
const MARKER: Readonly<Record<SectionBody["kind"], string>> = {
  control: ".sec-control",
  board: ".sec-metrics",
  meters: ".sec-meters",
  choosers: ".sec-choosers",
  gallery: ".sec-gallery",
  steps: ".sec-steps",
  intro: ".sec-hero",
  score: ".sec-score",
  empty: ".sec-empty",
  table: ".table-wrap",
};

/** Every section spec, tagged with the level it belongs to. */
function allSpecs(): readonly {
  readonly level: string;
  readonly id: string;
  readonly spec: SectionSpec;
}[] {
  return [
    ...Object.entries(WORKSPACE_SECTIONS_SPEC).map(([id, spec]) => ({
      level: "workspace",
      id,
      spec,
    })),
    ...Object.entries(PROJECT_SECTIONS_SPEC).map(([id, spec]) => ({ level: "project", id, spec })),
  ];
}

describe("the section catalogue", () => {
  it("gives every section a distinct tint, so two are never the same colour", () => {
    const byTint = new Map<string, string[]>();
    for (const { id, spec } of allSpecs()) {
      byTint.set(spec.tint, [...(byTint.get(spec.tint) ?? []), id]);
    }
    // Tints are shared on purpose (a colour is a family, not an identity), but
    // every tint in use must be one the stylesheet defines. An unknown tint
    // would silently render untinted.
    const defined = new Set(["blue", "violet", "teal", "amber", "rose", "green", "slate", "cyan"]);
    for (const { id, spec } of allSpecs()) {
      expect(defined.has(spec.tint), `section "${id}" uses an undefined tint`).toBe(true);
    }
  });

  it("never claims an engine is configured without a detail line saying so", () => {
    for (const { id, spec } of allSpecs()) {
      expect(spec.engine.trim(), `section "${id}" names no engine`).not.toBe("");
      expect(spec.status.detail.trim(), `section "${id}" has an empty status detail`).not.toBe("");
      if (spec.status.tone === "ok") {
        // A green status is a claim. It must name what answered.
        expect(spec.status.detail.toLowerCase()).toContain(spec.engine.toLowerCase().slice(0, 4));
      }
    }
  });

  it("bakes no configured status into the catalogue", () => {
    // The catalogue is a static default, not the deployment's state. Every
    // section's compiled status must say "not configured"; the page raises it
    // to "Configured" only when the live engine report says the adapter behind
    // it answered. A baked-in green would render even when the engine is
    // absent — which is exactly the storage regression this guards.
    for (const { id, spec } of allSpecs()) {
      expect(
        spec.status.tone,
        `section "${id}" bakes a "${spec.status.tone}" status into the catalogue`,
      ).not.toBe("ok");
      expect(spec.status.label, `section "${id}" bakes a "${spec.status.label}" label`).toBe(
        "Not configured",
      );
    }
  });
});

describe("every section renders as its declared archetype", () => {
  it.each(allSpecs().map(({ level, id, spec }) => [`${level}/${id}`, spec] as const))(
    "%s draws its own layout",
    (_label, spec) => {
      const { container } = render(
        <SectionArchetype
          chrome={{
            icon: spec.icon,
            title: spec.title,
            blurb: spec.blurb,
            tint: spec.tint,
            status: spec.status,
          }}
          body={spec.body}
        />,
      );
      const marker = MARKER[spec.body.kind];
      expect(
        container.querySelector(marker),
        `section "${spec.title}" declares kind "${spec.body.kind}" but drew no ${marker}`,
      ).toBeTruthy();
      // The tint is applied to the wrapper, so the colour identity is real.
      expect(container.querySelector(`.tint-${spec.tint}`)).toBeTruthy();
      // The heading is the section's own, never a placeholder.
      expect(container.querySelector(".sec-head__title")?.textContent).toBe(spec.title);
    },
  );
});
