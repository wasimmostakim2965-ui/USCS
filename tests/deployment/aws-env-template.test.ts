/**
 * The AWS bootstrap's SSM environment template must carry every key the product
 * needs to *build* an engine, not just the ones that look important.
 *
 * The template is a `join("\n", compact([...]))` of `KEY=value` lines in
 * `infra/aws/terraform/compute.tf`. It once set `SECURITY_EDGE_URL` but not
 * `SECURITY_EDGE_ORIGIN`, and `securityEdgeConfigFromEnv` refuses a URL with no
 * private origin — so an operator who set the URL per the runbook still got
 * `not_configured`, with no error. The keys have to move together; this test
 * keeps them that way.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const terraformDir = fileURLToPath(new URL("../../infra/aws/terraform/", import.meta.url));
const compute = readFileSync(`${terraformDir}compute.tf`, "utf8");
const variables = readFileSync(`${terraformDir}variables.tf`, "utf8");

/**
 * The keys the SSM value emits, read from the `"KEY=${var.…}"` lines inside the
 * `aws_ssm_parameter "env"` block. Deliberately narrow: it reads only that
 * resource's value, so a `KEY=` in a comment elsewhere cannot satisfy it.
 */
function emittedKeys(source: string): Set<string> {
  const block = source.slice(source.indexOf('resource "aws_ssm_parameter" "env"'));
  const end = block.indexOf("\n}\n");
  const body = end === -1 ? block : block.slice(0, end);
  const keys = new Set<string>();
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*"([A-Z_][A-Z0-9_]*)="?.*",?\s*$/);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

describe("the AWS SSM environment template", () => {
  const keys = emittedKeys(compute);

  it("emits the control-plane keys the host cannot start without", () => {
    for (const key of [
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "HOST",
      "PORT",
    ]) {
      expect(keys.has(key), `the SSM template must emit ${key}`).toBe(true);
    }
  });

  it("moves the edge origin with the edge URL, so the edge builds or stays honest", () => {
    // `securityEdgeConfigFromEnv` returns null unless the URL *and* a private
    // origin are set. Emitting one without the other silently disables the edge.
    expect(keys.has("SECURITY_EDGE_URL")).toBe(true);
    expect(keys.has("SECURITY_EDGE_ORIGIN")).toBe(true);
  });

  it("emits the bot allow-list, so a deployment can trust its own webhook senders", () => {
    // The overlay is how attack mode avoids locking out a customer's own
    // webhook provider or uptime monitor. Without the key on the host, an
    // operator could set it in `.env.example` and have it silently ignored.
    expect(keys.has("SECURITY_EDGE_BOT_ALLOWLIST")).toBe(true);
  });

  it("never turns the fakes on", () => {
    expect(compute).not.toContain("CLOUD_WAI_USE_FAKE_ENGINES=true");
  });

  it("declares every input variable it interpolates", () => {
    // A `${var.x}` with no matching `variable "x"` block is a validate failure,
    // but this catches the edit before it reaches `terraform validate`.
    const referenced = new Set<string>();
    for (const match of compute.matchAll(/\$\{var\.([a-z0-9_]+)\}/g)) referenced.add(match[1]!);
    const declared = new Set<string>();
    for (const match of variables.matchAll(/^variable\s+"([a-z0-9_]+)"/gm)) declared.add(match[1]!);
    const missing = [...referenced].filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });
});
