/**
 * Postgres and MinIO adapters, against a local stub engine.
 *
 * The stub speaks the documented request shapes. What is asserted here is the
 * adapter's own behaviour: which endpoint it calls, with whose credentials, and
 * that one organization cannot act on another's resource.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterContext, ProviderRef } from "@cloud-wai/contracts";
import {
  createPostgresDatabase,
  bucketNameFor,
  bucketPrefixFor,
  createMinioStorage,
} from "@cloud-wai/adapters";

const ORG_A = "org-a" as AdapterContext["organizationId"];
const ORG_B = "org-b" as AdapterContext["organizationId"];
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";

const ctx = (
  org: AdapterContext["organizationId"],
  key = "k",
  timeoutMs = 2_000,
): AdapterContext => ({
  organizationId: org,
  idempotencyKey: key,
  timeoutMs,
});

describe("Postgres adapter", () => {
  let server: Server;
  let baseUrl = "";
  const seen: { method: string; path: string; auth?: string; body?: unknown }[] = [];

  /** The engine logic, run once the body has been buffered. */
  const handle = (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    url: URL,
  ) => {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const team =
      req.headers.authorization === `Bearer ${TOKEN_A}`
        ? "a"
        : req.headers.authorization === `Bearer ${TOKEN_B}`
          ? "b"
          : null;
    if (!team) return json(401, { message: "unauthenticated" });

    if (req.method === "POST" && url.pathname === "/api/v1/databases/postgresql") {
      return json(201, { uuid: `db-${team}-1` });
    }
    const backup = url.pathname.match(/^\/api\/v1\/databases\/([^/]+)\/backups$/);
    if (backup && req.method === "POST") {
      const uuid = backup[1]!;
      // A database of another team is not visible to this token.
      if (!uuid.startsWith(`db-${team}-`)) return json(404, { message: "Not found" });
      return json(201, { uuid: "backup-1" });
    }
    // The engine lists a backup config's executions; only one carrying a
    // filename is restorable, which is what the adapter reads before importing.
    const executions = url.pathname.match(
      /^\/api\/v1\/databases\/([^/]+)\/backups\/([^/]+)\/executions$/,
    );
    if (executions && req.method === "GET") {
      const db = executions[1]!;
      if (!db.startsWith(`db-${team}-`)) return json(404, { message: "Not found" });
      return json(200, {
        executions: [
          { uuid: "exec-0", filename: null, status: "running", created_at: "2026-01-01T00:00:00Z" },
          {
            uuid: "exec-1",
            filename: "/backups/databases/team-a/db-a-1/pg-dump-all-1.gz",
            status: "successful",
            created_at: "2026-01-01T00:01:00Z",
          },
        ],
      });
    }
    // Coolify restores by importing a backup file, not by re-running an execution.
    const imports = url.pathname.match(/^\/api\/v1\/databases\/([^/]+)\/imports$/);
    if (imports && req.method === "POST") {
      const db = imports[1]!;
      if (!db.startsWith(`db-${team}-`)) return json(404, { message: "Not found" });
      return json(202, { message: "Import queued" });
    }
    // Credential rotation is a PATCH that writes a new password; the engine
    // must never return it.
    const patch = url.pathname.match(/^\/api\/v1\/databases\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const db = patch[1]!;
      if (!db.startsWith(`db-${team}-`)) return json(404, { message: "Not found" });
      return json(200, { message: "updated" });
    }
    const one = url.pathname.match(/^\/api\/v1\/databases\/([^/]+)$/);
    if (one && req.method === "DELETE") {
      const db = one[1]!;
      if (!db.startsWith(`db-${team}-`)) return json(404, { message: "Not found" });
      return json(200, { message: "deleted" });
    }
    return json(404, { message: "unknown" });
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        seen.push({
          method: req.method ?? "",
          path: url.pathname,
          auth: req.headers.authorization,
          ...(raw ? { body: JSON.parse(raw) as unknown } : {}),
        });
        handle(req, res, url);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const placement = { projectUuid: "proj-1", serverUuid: "srv-1", environmentName: "production" };

  const adapter = () =>
    createPostgresDatabase({
      credentials: (org) =>
        org === ORG_A
          ? { baseUrl, token: TOKEN_A, ...placement }
          : org === ORG_B
            ? { baseUrl, token: TOKEN_B, ...placement }
            : null,
      // Pinned so the test can assert the password never leaves the adapter.
      newPassword: () => "super-secret-new-password",
    });

  it("reports not_configured without credentials", async () => {
    const result = await adapter().provision(ctx("org-x"), { name: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });

  it("reports not_configured when the credential lacks a placement", async () => {
    const bare = createPostgresDatabase({
      credentials: () => ({ baseUrl, token: TOKEN_A }),
    });
    const result = await bare.provision(ctx(ORG_A, "no-placement"), { name: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe("not_configured");
      expect(result.reason).toContain("COOLIFY_PROJECT_UUID");
    }
  });

  it("provisions a database with the organization's own token and placement", async () => {
    seen.length = 0;
    const result = await adapter().provision(ctx(ORG_A, "p1"), { name: "alpha" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.resourceId).toBe("db-a-1");
    const call = seen.at(-1)!;
    expect(call.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/v1/databases/postgresql");
    // The engine's own field names, not the credential record's.
    expect(call.body).toMatchObject({
      project_uuid: "proj-1",
      server_uuid: "srv-1",
      environment_name: "production",
    });
  });

  it("cannot back up another organization's database", async () => {
    const ref: ProviderRef = {
      organizationId: ORG_B,
      provider: "postgres",
      resourceType: "database",
      resourceId: "db-a-1",
    };
    const result = await adapter().backup(ctx(ORG_B, "cross"), ref);
    expect(result.ok).toBe(false);
  });

  it("backs up and restores through the engine's own artifacts", async () => {
    const db = adapter();
    const provisioned = await db.provision(ctx(ORG_A, "b1"), { name: "alpha" });
    if (!provisioned.ok) throw new Error("setup failed");

    const backup = await db.backup(ctx(ORG_A, "b1"), provisioned.value);
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    expect(backup.value.resourceType).toBe("backup");

    const restored = await db.restore(ctx(ORG_A, "b1"), {
      backupRef: backup.value,
      targetRef: provisioned.value,
    });
    expect(restored.ok).toBe(true);
  });

  it("rotates credentials through the PATCH route and never returns the password", async () => {
    seen.length = 0;
    const db = adapter();
    const provisioned = await db.provision(ctx(ORG_A, "r1"), { name: "alpha" });
    if (!provisioned.ok) throw new Error("setup failed");

    const rotated = await db.rotateCredentials(ctx(ORG_A, "r1"), provisioned.value);
    expect(rotated.ok).toBe(true);
    // The engine has no rotate route; the password is written by PATCH.
    const call = seen.at(-1)!;
    expect(call.method).toBe("PATCH");
    expect(call.path).toBe("/api/v1/databases/db-a-1");
    expect(call.body).toMatchObject({ postgres_password: "super-secret-new-password" });
    // The password the control plane minted must not appear in the adapter's result.
    expect(JSON.stringify(rotated)).not.toContain("super-secret-new-password");
  });

  it("restores by importing the filename the engine recorded", async () => {
    seen.length = 0;
    const db = adapter();
    const provisioned = await db.provision(ctx(ORG_A, "i1"), { name: "alpha" });
    if (!provisioned.ok) throw new Error("setup failed");
    const backup = await db.backup(ctx(ORG_A, "i1"), provisioned.value);
    if (!backup.ok) throw new Error("backup failed");

    const restored = await db.restore(ctx(ORG_A, "i1"), {
      backupRef: backup.value,
      targetRef: provisioned.value,
    });
    expect(restored.ok).toBe(true);

    // It reads the executions, then imports the file the engine named.
    const read = seen.find((r) => r.method === "GET" && r.path.endsWith("/executions"));
    expect(read?.path).toBe("/api/v1/databases/db-a-1/backups/backup-1/executions");
    const importCall = seen.at(-1)!;
    expect(importCall.method).toBe("POST");
    expect(importCall.path).toBe("/api/v1/databases/db-a-1/imports");
    expect(importCall.body).toMatchObject({
      source: "server",
      path: "/backups/databases/team-a/db-a-1/pg-dump-all-1.gz",
    });
  });

  it("refuses to restore when the engine has no restorable backup file", async () => {
    const bare = createPostgresDatabase({
      credentials: () => ({ baseUrl, token: TOKEN_A, ...placement }),
      fetchImpl: (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/executions")) {
          return Promise.resolve(
            new Response(JSON.stringify({ executions: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return fetch(input as string, init);
      },
    });
    const provisioned = await bare.provision(ctx(ORG_A, "no-file"), { name: "alpha" });
    if (!provisioned.ok) throw new Error("setup failed");
    const result = await bare.restore(ctx(ORG_A, "no-file"), {
      backupRef: {
        organizationId: ORG_A,
        provider: "postgres",
        resourceType: "backup",
        resourceId: "db-a-1/backup-1",
      },
      targetRef: provisioned.value,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("degraded");
  });

  it("refuses a malformed backup reference", async () => {
    const result = await adapter().restore(ctx(ORG_A, "bad"), {
      backupRef: {
        organizationId: ORG_A,
        provider: "postgres",
        resourceType: "backup",
        resourceId: "no-slash",
      },
      targetRef: {
        organizationId: ORG_A,
        provider: "postgres",
        resourceType: "database",
        resourceId: "db-a-1",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("failed");
  });
});

describe("MinIO storage adapter", () => {
  let server: Server;
  let baseUrl = "";
  const seen: { method: string; path: string; auth?: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      seen.push({ method: req.method ?? "", path: url.pathname, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("<Response/>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const adapter = () =>
    createMinioStorage({
      credentials: (org) =>
        org === ORG_A || org === ORG_B
          ? { endpoint: baseUrl, accessKey: `key-${org}`, secretKey: "secret-value" }
          : null,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

  it("reports not_configured without storage credentials", async () => {
    const result = await adapter().createBucket(ctx("org-x"), { name: "b" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });

  it("namespaces a bucket by organization", () => {
    const name = bucketNameFor(ORG_A, "Uploads");
    expect(name.startsWith(bucketPrefixFor(ORG_A))).toBe(true);
    expect(name).toMatch(/^[a-z0-9-]+$/);
    // Two different logical names must not collide.
    expect(bucketNameFor(ORG_A, "uploads")).not.toBe(bucketNameFor(ORG_A, "other"));
    // Two different organizations must not share a bucket.
    expect(bucketPrefixFor(ORG_A)).not.toBe(bucketPrefixFor(ORG_B));
  });

  it("creates a bucket with a SigV4 authorization header", async () => {
    const result = await adapter().createBucket(ctx(ORG_A, "bucket"), { name: "uploads" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.resourceId).toBe(bucketNameFor(ORG_A, "uploads"));

    const call = seen.at(-1)!;
    expect(call.method).toBe("PUT");
    expect(call.path).toBe(`/${bucketNameFor(ORG_A, "uploads")}`);
    expect(call.auth).toContain(
      "AWS4-HMAC-SHA256 Credential=key-org-a/20260101/us-east-1/s3/aws4_request",
    );
    expect(call.auth).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(call.auth).toMatch(/Signature=[0-9a-f]{64}/);
  });

  it("refuses to delete another organization's bucket", async () => {
    const foreign: ProviderRef = {
      organizationId: ORG_B,
      provider: "minio",
      resourceType: "bucket",
      resourceId: bucketNameFor(ORG_A, "uploads"),
    };
    const result = await adapter().deleteBucket(ctx(ORG_B, "del"), foreign);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("does not belong");
  });

  it("deletes a bucket it owns", async () => {
    const owned: ProviderRef = {
      organizationId: ORG_A,
      provider: "minio",
      resourceType: "bucket",
      resourceId: bucketNameFor(ORG_A, "uploads"),
    };
    const result = await adapter().deleteBucket(ctx(ORG_A, "del-own"), owned);
    expect(result.ok).toBe(true);
    expect(seen.at(-1)?.method).toBe("DELETE");
  });

  it("reports an unreachable storage endpoint as degraded", async () => {
    const offline = createMinioStorage({
      credentials: () => ({ endpoint: "http://127.0.0.1:1", accessKey: "k", secretKey: "s" }),
    });
    const result = await offline.createBucket(ctx(ORG_A), { name: "b" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("degraded");
  });
});
