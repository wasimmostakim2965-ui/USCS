/**
 * The environment template must be loadable, not merely readable.
 *
 * `.env.example` is the contract an operator copies to `.env` before
 * `docker compose up`. Compose parses that file with its own dotenv reader,
 * which rejects a key containing `<` or `>` outright:
 *
 *   failed to read .env: unexpected character "<" in variable name
 *
 * The template used to document per-organization keys as live assignments like
 * `COOLIFY_TOKEN__<organizationId>=<token>`, so following the runbook produced a
 * deployment that would not start. The placeholders are now comments. This test
 * keeps them that way: it applies the same rule a dotenv parser does, so a
 * future placeholder written as a key fails here instead of on a host.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const templatePath = fileURLToPath(new URL("../../.env.example", import.meta.url));

/** A dotenv key: what Compose's reader accepts as a variable name. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function assignments(source: string): { key: string; line: number }[] {
  const found: { key: string; line: number }[] = [];
  source.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const key = line.includes("=") ? line.slice(0, line.indexOf("=")) : line;
    found.push({ key, line: index + 1 });
  });
  return found;
}

describe("the environment template", () => {
  const source = readFileSync(templatePath, "utf8");

  it("has no assignment a dotenv parser would reject", () => {
    const bad = assignments(source).filter(({ key }) => !VALID_KEY.test(key));
    expect(bad).toEqual([]);
  });

  it("documents the per-organization keys it cannot express as assignments", () => {
    // The keys a real tenant needs, named somewhere in the file even though the
    // assignment form is a comment.
    for (const key of ["COOLIFY_TOKEN__", "STORAGE_ACCESS_KEY__", "STORAGE_SECRET_KEY__"]) {
      expect(source).toContain(key);
    }
    // And the operator-facing ones are real assignments.
    const keys = new Set(assignments(source).map((entry) => entry.key));
    for (const key of [
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "HOST",
      "PORT",
      "CLOUD_WAI_USE_FAKE_ENGINES",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it("never enables the fakes in the template", () => {
    // The template is copied to production hosts; a `true` here would be a trap.
    const enabled = assignments(source).find((entry) => entry.key === "CLOUD_WAI_USE_FAKE_ENGINES");
    expect(enabled).toBeDefined();
    const line = source.split("\n")[enabled!.line - 1]!;
    expect(line.trim()).toBe("CLOUD_WAI_USE_FAKE_ENGINES=false");
  });
});
