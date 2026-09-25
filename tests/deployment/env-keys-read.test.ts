/**
 * A key in `.env.example` that no code reads is a small lie: the operator sets
 * it, sees it accepted, and expects a behaviour that never happens.
 *
 * The template may still document such a key — the operator's own edge and
 * tenant plane are real things to record — but it must say so explicitly, under
 * the "Reserved" heading, rather than sit among the live keys as if it were
 * wired. This test separates the two: every assignment *before* the Reserved
 * marker has to be read somewhere in production source, and every assignment the
 * code does not read has to be *after* it.
 *
 * Production source is `apps/`, `packages/` and `infra/`, excluding test files
 * and build output — a key only a test mentions is not wired.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const template = readFileSync(`${root}.env.example`, "utf8");

const RESERVED_MARKER = "# --- Reserved";

/** The keys assigned in the template, with the line each sits on. */
function assignments(source: string): { key: string; line: number }[] {
  const found: { key: string; line: number }[] = [];
  source.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (!line.includes("=")) return;
    found.push({ key: line.slice(0, line.indexOf("=")), line: index + 1 });
  });
  return found;
}

/** Recursively collect production source files. */
function productionFiles(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const path = `${dir}${entry}`;
    if (statSync(path).isDirectory()) productionFiles(`${path}/`, into);
    else if (/\.(ts|tsx|tftpl|yml|yaml|conf)$/.test(entry) && !/\.test\./.test(entry)) {
      into.push(path);
    }
  }
  return into;
}

describe("the environment template's live keys", () => {
  const reservedAt = template.split("\n").findIndex((l) => l.startsWith(RESERVED_MARKER));
  const entries = assignments(template);
  const live = entries.filter(({ line }) => reservedAt === -1 || line < reservedAt + 1);
  const reserved = entries.filter(({ line }) => reservedAt !== -1 && line >= reservedAt + 1);

  const sources = [
    ...productionFiles(`${root}apps/`),
    ...productionFiles(`${root}packages/`),
    ...productionFiles(`${root}infra/`),
  ].map((path) => readFileSync(path, "utf8"));

  const isRead = (key: string) => sources.some((source) => source.includes(key));

  it("has a Reserved section for the keys it documents but does not read", () => {
    expect(reservedAt).toBeGreaterThan(-1);
  });

  it("reads every key that sits above the Reserved marker", () => {
    const unread = live.filter(({ key }) => !isRead(key)).map(({ key }) => key);
    expect(unread).toEqual([]);
  });

  it("keeps the reserved keys honestly reserved", () => {
    // If one of these becomes wired, it must move above the marker — the test
    // then fails here, which is the prompt to relocate it rather than a bug.
    const nowRead = reserved.filter(({ key }) => isRead(key)).map(({ key }) => key);
    expect(nowRead).toEqual([]);
  });
});
