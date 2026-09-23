import { describe, expect, it } from "vitest";
import { isSensitiveKey, logRecord, redact } from "@cloud-wai/observability";

describe("log redaction", () => {
  it("classifies credential-bearing keys as sensitive", () => {
    for (const key of [
      "password",
      "secret",
      "apiKey",
      "api_key",
      "token",
      "access_token",
      "authorization",
      "cookie",
      "privateKey",
      "credential",
      "databaseDsn",
      "connectionString",
      "jwt",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("classifies origin addresses as sensitive", () => {
    // Origin addresses must never be disclosed in logs: the whole edge design
    // depends on the origin staying private.
    for (const key of ["origin", "origin_ip", "originHost", "upstream", "backend_host"]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it("does not redact ordinary non-secret keys", () => {
    for (const key of ["id", "name", "status", "createdAt", "organizationId"]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("removes secrets nested anywhere in a record", () => {
    const record = {
      event: "deploy.requested",
      project: { name: "web", token: "ghp_supersecret", nested: { password: "hunter2" } },
      headers: { authorization: "Bearer abc.def.ghi" },
      ok: true,
    };
    const redacted = redact(record) as Record<string, unknown>;
    const asJson = JSON.stringify(redacted);

    expect(asJson).not.toContain("ghp_supersecret");
    expect(asJson).not.toContain("hunter2");
    expect(asJson).not.toContain("Bearer abc.def.ghi");
    expect(asJson).toContain("[redacted]");
    // Non-sensitive data survives.
    expect(asJson).toContain("web");
    expect(asJson).toContain("deploy.requested");
  });

  it("preserves arrays and primitives", () => {
    expect(redact([1, "two", null])).toEqual([1, "two", null]);
    expect(redact("plain")).toBe("plain");
    expect(redact(null)).toBeNull();
  });

  it("bounds recursion depth so logging cannot hang a request", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 50; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    expect(() => redact(deep)).not.toThrow();
  });

  it("produces a structured record with secrets stripped", () => {
    const record = logRecord("info", "session.created", {
      userId: "u-1",
      accessToken: "secret-token",
    });
    expect(record.level).toBe("info");
    expect(record.event).toBe("session.created");
    expect(JSON.stringify(record)).not.toContain("secret-token");
  });
});
