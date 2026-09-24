/**
 * Startup configuration: what a real deployment must set, and what happens when
 * it is missing.
 *
 * The API used to build its CORS allow-list only from a programmatic option, so
 * a containerised deployment could not tell the server which dashboard origin
 * was allowed — the browser would be refused with no way to fix it from the
 * environment. These pin the environment path that closes that gap, and keep the
 * allow-list strict: never a wildcard, never an empty entry.
 */
import { describe, expect, it } from "vitest";
import { allowedOriginsFromEnv } from "@cloud-wai/api";

describe("allowed origins from the environment", () => {
  it("is undefined when the variable is unset, so CORS stays off", () => {
    expect(allowedOriginsFromEnv({})).toBeUndefined();
  });

  it("is undefined for an empty or whitespace-only value", () => {
    expect(allowedOriginsFromEnv({ CLOUD_WAI_ALLOWED_ORIGINS: "" })).toBeUndefined();
    expect(allowedOriginsFromEnv({ CLOUD_WAI_ALLOWED_ORIGINS: "   ,  " })).toBeUndefined();
  });

  it("splits a comma-separated list and trims each origin", () => {
    expect(
      allowedOriginsFromEnv({
        CLOUD_WAI_ALLOWED_ORIGINS: "https://app.example, https://staging.example",
      }),
    ).toEqual(["https://app.example", "https://staging.example"]);
  });

  it("drops blank entries rather than allowing an empty origin", () => {
    expect(
      allowedOriginsFromEnv({ CLOUD_WAI_ALLOWED_ORIGINS: "https://app.example,," }),
    ).toEqual(["https://app.example"]);
  });

  it("never turns the value into a wildcard", () => {
    // A `*` is a literal origin here, not an allow-everything. The server only
    // matches exact strings, so this is a non-match rather than a bypass.
    const origins = allowedOriginsFromEnv({ CLOUD_WAI_ALLOWED_ORIGINS: "*" });
    expect(origins).toEqual(["*"]);
    expect(origins).not.toContain("https://evil.example");
  });
});
