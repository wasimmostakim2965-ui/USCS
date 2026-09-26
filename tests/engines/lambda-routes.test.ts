/**
 * Every AWS route the serverless adapter calls must exist in the pinned model.
 *
 * `coolify-routes.test.ts` proves the hosting and database adapters only call
 * routes the pinned Coolify commit exposes. The serverless adapter makes the
 * same kind of promise but had no such check, and its header comment claimed one
 * that did not exist. This is that check, against botocore's service models —
 * the machine-readable source every AWS SDK is generated from.
 *
 * It found two real bugs when it was written:
 *
 *   * The CloudWatch Logs read omitted `X-Amz-Target`, but Logs is a JSON-RPC
 *     service where every operation is `POST /` and the operation name lives in
 *     that header. AWS answers 400 without it, which the adapter would have
 *     reported as an engine fault.
 *   * `CreateFunction` for an image artifact omitted `PackageType: "Image"`.
 *     Lambda defaults to `Zip`, and a `Zip` package rejects an `ImageUri` code,
 *     so a container-image function could not be created at all.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterContext } from "@cloud-wai/contracts";
import { createLambdaServerless, type LambdaCredentials } from "@cloud-wai/adapters";

const ORG = "org-a" as AdapterContext["organizationId"];

const ctx = (key: string): AdapterContext => ({
  organizationId: ORG,
  idempotencyKey: key,
  timeoutMs: 2_000,
});

interface ServiceFixture {
  readonly protocol: string;
  readonly targetPrefix: string | null;
  readonly operations: { name: string; method: string; requestUri: string }[];
}

interface RouteFixture {
  readonly _commit: string;
  readonly services: Record<string, ServiceFixture>;
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/lambda-routes.json", import.meta.url), "utf8"),
) as RouteFixture;

/** Turn a model URI with `{Placeholders}` into a matcher. */
const patternFor = (uri: string) =>
  new RegExp(`^${uri.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[A-Za-z]+\}/g, "[^/]+")}$`);

interface Seen {
  method: string;
  path: string;
  target: string | undefined;
}

let server: Server;
let base = "";
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: new URL(req.url ?? "/", "http://x").pathname,
        target: req.headers["x-amz-target"] as string | undefined,
      });
      res.setHeader("content-type", "application/json");
      const url = req.url ?? "/";
      if (req.method === "POST" && url === "/2015-03-31/functions") {
        res.statusCode = 201;
        res.end(JSON.stringify({ FunctionName: "fn", State: "Pending" }));
        return;
      }
      if (req.method === "PUT" && url.startsWith("/2015-03-31/functions/")) {
        res.end(JSON.stringify({ FunctionName: "fn", State: "Active" }));
        return;
      }
      if (req.method === "DELETE") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (url.endsWith("/configuration")) {
        res.end(JSON.stringify({ State: "Active", LastUpdateStatus: "Successful" }));
        return;
      }
      if (url.endsWith("/url")) {
        res.end(JSON.stringify({ FunctionUrl: "https://x.lambda-url.us-east-1.on.aws/" }));
        return;
      }
      if (url === "/") {
        res.end(JSON.stringify({ events: [{ message: "hello" }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "not found" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const credentials = (): LambdaCredentials => ({
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret",
  region: "us-east-1",
  executionRoleArn: "arn:aws:iam::111:role/lambda-exec",
});

describe("every serverless adapter route exists in the pinned AWS model", () => {
  const lambda = fixture.services["lambda"]!;
  const logs = fixture.services["logs"]!;

  const assertAllCalled = () => {
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      if (call.path === "/") {
        // A JSON-RPC service: the operation is the target header, not the path.
        expect(
          call.target,
          "a POST / was sent without an X-Amz-Target the logs model names",
        ).toBeDefined();
        expect(
          logs.operations.some((operation) => operation.name === call.target?.split(".")[1]),
          `${call.target} is not an operation of the pinned logs model`,
        ).toBe(true);
        continue;
      }
      const exists = lambda.operations.some(
        (operation) =>
          operation.method === call.method && patternFor(operation.requestUri).test(call.path),
      );
      expect(exists, `${call.method} ${call.path} is not in the pinned AWS Lambda model`).toBe(
        true,
      );
    }
  };

  it("pins the whole model, with the protocol that names each operation", () => {
    expect(fixture._commit).toBe("86201a3e9c58a61369b8bcf4b658bfd4463fc41f");
    expect(lambda.protocol).toBe("rest-json");
    expect(lambda.operations.length).toBeGreaterThan(50);
    expect(logs.protocol).toBe("json");
    expect(logs.targetPrefix).toBe("Logs_20140328");
    expect(logs.operations.some((operation) => operation.name === "FilterLogEvents")).toBe(true);
  });

  it("drives the adapter across its lifecycle and finds only real routes", async () => {
    seen.length = 0;
    const adapter = createLambdaServerless({
      credentials,
      endpointFor: () => base,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const created = await adapter.createFunction(ctx("create"), {
      name: "fn",
      runtime: "nodejs20.x",
      handler: "index.handler",
      artifact: { kind: "s3", bucket: "builds", key: "fn.zip" },
    });
    if (!created.ok) throw new Error("create failed");

    await adapter.deploy(ctx("deploy"), {
      functionRef: created.value.providerRef,
      artifact: { kind: "s3", bucket: "builds", key: "fn-v2.zip" },
    });
    await adapter.getDeployment(ctx("get"), created.value.providerRef);
    await adapter.getLogs(ctx("logs"), created.value.providerRef);
    await adapter.deleteFunction(ctx("delete"), created.value.providerRef);

    assertAllCalled();
  });

  it("creates a container-image function with the package type that image code requires", async () => {
    seen.length = 0;
    const bodies: unknown[] = [];
    const imageServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (req.method === "POST" && req.url === "/2015-03-31/functions") {
          bodies.push(raw ? JSON.parse(raw) : undefined);
          res.statusCode = 201;
          res.end(JSON.stringify({ FunctionName: "fn", State: "Pending" }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => imageServer.listen(0, "127.0.0.1", r));
    const imageBase = `http://127.0.0.1:${(imageServer.address() as AddressInfo).port}`;

    try {
      const adapter = createLambdaServerless({
        credentials,
        endpointFor: () => imageBase,
        now: () => new Date("2026-01-01T00:00:00Z"),
      });
      const created = await adapter.createFunction(ctx("image"), {
        name: "fn",
        runtime: "nodejs20.x",
        handler: "index.handler",
        artifact: {
          kind: "image",
          uri: "111122223333.dkr.ecr.us-east-1.amazonaws.com/fn:latest",
        },
      });
      if (!created.ok) throw new Error("create failed");
      expect((bodies[0] as { PackageType?: string }).PackageType).toBe("Image");
    } finally {
      await new Promise<void>((r) => imageServer.close(() => r()));
    }
  });
});
