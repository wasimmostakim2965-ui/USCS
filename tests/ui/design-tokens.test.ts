/**
 * The design tokens, checked against the two things a screenshot cannot catch.
 *
 * jsdom has no layout, so axe reports no colour-contrast violations and no
 * touch-target violations — the audit that passes in CI is silent about both.
 * These assertions read the stylesheet directly, so a token that drifts below
 * AA or a nav row that drops under a thumb-sized minimum fails here instead of
 * shipping.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../packages/ui/src/styles.css", import.meta.url), "utf8");

/** The value of a custom property inside one theme block. */
function token(theme: "dark" | "light", name: string): string {
  const block = css.split(`[data-theme="${theme}"]`)[1]?.split("}")[0] ?? "";
  const match = block.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (!match) throw new Error(`--${name} not found in the ${theme} theme`);
  return match[1];
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("muted text is readable in both themes", () => {
  // --ink-3 carries group labels, table headers and helper lines. It is quiet,
  // not decorative, so it owes AA (4.5:1) on every ground it can sit on.
  for (const theme of ["dark", "light"] as const) {
    for (const surface of ["ground", "panel"]) {
      it(`--ink-3 on --${surface} clears AA in the ${theme} theme`, () => {
        const ratio = contrast(token(theme, "ink-3"), token(theme, surface));
        expect(
          ratio,
          `${theme} --ink-3 on --${surface} was ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("nav rows are thumb-sized", () => {
  it(".nav__item carries a 44px minimum height", () => {
    const rule = css.match(/\.nav__item\s*\{[^}]*\}/)?.[0] ?? "";
    const minHeight = rule.match(/min-height:\s*(\d+)px/)?.[1];
    expect(Number(minHeight)).toBeGreaterThanOrEqual(44);
  });

  it("no later rule shrinks a nav row back below the minimum", () => {
    // The compact override sets padding but must not undo the minimum.
    const rules = [...css.matchAll(/\.nav__item\s*\{[^}]*\}/g)].map((m) => m[0]);
    for (const rule of rules) {
      const shrink = rule.match(/(?:^|[\s;])height:\s*(\d+)px/);
      if (shrink) expect(Number(shrink[1])).toBeGreaterThanOrEqual(44);
    }
  });
});
