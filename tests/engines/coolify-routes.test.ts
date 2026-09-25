/**
 * Every Coolify route the adapters call must exist in the pinned upstream table.
 *
 * The hosting adapter already had this check inside `coolify.test.ts`, but the
 * database adapter did not — and the fixture was filtered to application routes,
 * so a database route could not be checked even if it were listed. This test
 * pins the *whole* upstream route table and drives both adapters across their
 * full lifecycles, so a route that Coolify does not expose fails here rather
 * than in production.
 *
 * It found real bugs when it was written: `postgres.ts` called
 * `POST /databases/{uuid}/rotate-credentials` and
 * `POST /databases/{uuid}/backups/{id}/executions`, neither of which exists
 * upstream. Both are now the operations Coolify actually exposes.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterContext } from "@cloud-wai/contracts";
import {
  createCoolifyHosting,
  createPostgresDatabase,
  type CoolifyCredentials,
} from "@cloud-wai/adapters";

const ORG_A = "org-a" as AdapterContext["organizationId"];
const TOKEN = "token-a";

const ctx = (org: AdapterContext["organizationId"], key = "k"): AdapterContext => ({
  organizationId: org,
  idempotencyKey: key,
  timeoutMs: 2_000,
});

interface RouteFixture {
  readonly _commit: string;
  readonly routes: { method: string; path: string }[];
}

/** Turn an upstream path with `{placeholders}` into a matcher. */
const patternFor = (path: string) =>
  new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[a-z_]+\}/g, "[^/]+")}$`);

let server: Server;
let baseUrl = "";
const calls: { method: string; path: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    calls.push({ method: req.method ?? "", path: url.pathname });
    // A permissive engine: the point is which routes are called, not the bodies.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        uuid: "resource-1",
        executions: [{ uuid: "exec-1", filename: "/backups/x.gz", status: "successful" }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const credentials = (): CoolifyCredentials => ({
  baseUrl,
  token: TOKEN,
  projectUuid: "proj-1",
  serverUuid: "srv-1",
  environmentName: "production",
});

describe("every adapter route exists in the pinned Coolify route table", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/coolify-routes.json", import.meta.url), "utf8"),
  ) as RouteFixture;

  const assertAllCalled = () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const exists = fixture.routes.some(
        (route) => route.method === call.method && patternFor(route.path).test(call.path),
      );
      expect(
        exists,
        `${call.method} ${call.path} is not in the pinned Coolify route table`,
      ).toBe(true);
    }
  };

  it("pins the whole upstream route table, not only applications", () => {
    expect(fixture._commit).toBe("7c86e53422ad7c4f19c5821621c71403b9173f62");
    expect(fixture.routes.length).toBeGreaterThan(200);
    expect(fixture.routes.some((r) => r.path.startsWith("/api/v1/databases"))).toBe(true);
  });

  it("confirms the two routes the adapter used to assume are absent upstream", () => {
    expect(fixture.routes.some((r) => r.path.includes("rotate-credentials"))).toBe(false);
    expect(
      fixture.routes.some(
        (r) => r.method === "POST" && /\/databases\/[^/]+\/backups\/[^/]+\/executions$/.test(r.path),
      ),
    ).toBe(false);
  });

  it("drives the hosting adapter and finds only real routes", async () => {
    calls.length = 0;
    const hosting = createCoolifyHosting({ credentials });
    const created = await hosting.createApplication(ctx(ORG_A, "host"), {
      name: "app",
      gitRepository: "https://github.com/example/app",
      gitBranch: "main",
    });
    if (!created.ok) throw new Error("create failed");
    const ref = created.value.providerRef;
    await hosting.deploy(ctx(ORG_A, "host"), { applicationRef: ref });
    await hosting.getLogs(ctx(ORG_A, "host"), ref);
    await hosting.reconcile(ctx(ORG_A, "host"), ref);
    await hosting.deleteApplication(ctx(ORG_A, "host"), ref);
    assertAllCalled();
  });

  it("drives the database adapter across its lifecycle and finds only real routes", async () => {
    calls.length = 0;
    const db = createPostgresDatabase({ credentials, newPassword: () => "Rotated-1_Password" });
    const provisioned = await db.provision(ctx(ORG_A, "db"), { name: "alpha" });
    if (!provisioned.ok) throw new Error("provision failed");

    const backup = await db.backup(ctx(ORG_A, "db"), provisioned.value);
    if (!backup.ok) throw new Error("backup failed");

    await db.rotateCredentials(ctx(ORG_A, "db"), provisioned.value);
    await db.restore(ctx(ORG_A, "db"), {
      backupRef: backup.value,
      targetRef: provisioned.value,
    });
    await db.destroy(ctx(ORG_A, "db"), provisioned.value);

    assertAllCalled();
  });
});
