/**
 * The serverless (Lambda) adapter, against a local stub AWS endpoint.
 *
 * What is asserted here is the adapter's own behaviour, not AWS's: which route
 * it calls, with whose credentials, and — the point of the engine — that it
 * refuses a deploy with nothing to deploy rather than reporting a success that
 * built nothing. Lambda does not build from a git repository; a serverless
 * deploy needs a built artifact, and an adapter that invented one would violate
 * the honesty rule this repository is built on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AdapterContext } from "@cloud-wai/contracts";
import { createLambdaServerless, validateArtifact, mapLambdaStatus } from "@cloud-wai/adapters";

const ORG_A = "org-a" as AdapterContext["organizationId"];
const ORG_B = "org-b" as AdapterContext["organizationId"];

const CREDS = {
  [ORG_A]: {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    executionRoleArn: "arn:aws:iam::111:role/lambda-exec",
  },
  // A second organization, with a token that must never be used for the first.
  [ORG_B]: {
    accessKeyId: "AKIDOTHER",
    secretAccessKey: "other-secret",
    region: "eu-west-1",
    executionRoleArn: "arn:aws:iam::222:role/lambda-exec",
  },
} as const;

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
  host: string | undefined;
  body: unknown;
}

let server: Server;
let base: string;
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seen.push({
        method: req.method ?? "",
        path: new URL(req.url ?? "/", "http://x").pathname,
        authorization: req.headers.authorization,
        host: req.headers.host,
        body: raw ? JSON.parse(raw) : undefined,
      });

      const url = req.url ?? "/";
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && url === "/2015-03-31/functions") {
        res.statusCode = 201;
        res.end(JSON.stringify({ FunctionName: "my-fn", State: "Pending" }));
        return;
      }
      if (req.method === "PUT" && url.startsWith("/2015-03-31/functions/")) {
        res.statusCode = 200;
        res.end(JSON.stringify({ FunctionName: "my-fn", State: "Active" }));
        return;
      }
      if (req.method === "DELETE") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (url.endsWith("/configuration")) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            FunctionName: "my-fn",
            State: "Active",
            LastUpdateStatus: "Successful",
          }),
        );
        return;
      }
      if (url.endsWith("/url")) {
        res.statusCode = 200;
        res.end(JSON.stringify({ FunctionUrl: "https://abc.lambda-url.us-east-1.on.aws/" }));
        return;
      }
      if (url === "/") {
        res.statusCode = 200;
        res.end(JSON.stringify({ events: [{ message: "hello" }, { message: "world" }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "no such function" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const CTX = (org: AdapterContext["organizationId"]): AdapterContext => ({
  organizationId: org,
  idempotencyKey: "idem-1",
  timeoutMs: 2000,
});

function adapter() {
  seen.length = 0;
  return createLambdaServerless({
    credentials: (org) => CREDS[org as keyof typeof CREDS] ?? null,
    endpointFor: () => base,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
}

const ARTIFACT = { kind: "s3" as const, bucket: "builds", key: "fn.zip" };

describe("Lambda adapter — honest refusals", () => {
  it("reports not_configured for an organization with no credentials", async () => {
    const result = await adapter().createFunction(CTX("org-none"), {
      name: "x",
      artifact: ARTIFACT,
      runtime: "nodejs20.x",
      handler: "index.handler",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
    // Nothing reached the engine.
    expect(seen).toHaveLength(0);
  });

  it("refuses a deploy with no artifact instead of reporting success", async () => {
    const result = await adapter().deploy(CTX(ORG_A), {
      functionRef: {
        organizationId: ORG_A,
        provider: "lambda",
        resourceType: "function",
        resourceId: "my-fn",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("failed");
    expect(seen).toHaveLength(0);
  });

  it("requires an execution role to create a function", async () => {
    const noRole = createLambdaServerless({
      credentials: () => ({
        accessKeyId: "A",
        secretAccessKey: "B",
        region: "us-east-1",
      }),
      endpointFor: () => base,
    });
    const result = await noRole.createFunction(CTX(ORG_A), {
      name: "x",
      artifact: ARTIFACT,
      runtime: "nodejs20.x",
      handler: "index.handler",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe("not_configured");
  });
});

describe("Lambda adapter — request shape", () => {
  it("creates a function at the documented route, signed", async () => {
    const result = await adapter().createFunction(CTX(ORG_A), {
      name: "my-fn",
      artifact: ARTIFACT,
      runtime: "nodejs20.x",
      handler: "index.handler",
    });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.path).toBe("/2015-03-31/functions");
    expect(seen[0]!.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/lambda\/aws4_request/,
    );
    expect((seen[0]!.body as Record<string, unknown>)["FunctionName"]).toBe("my-fn");
  });

  it("publishes new code to an existing function's /code route", async () => {
    const result = await adapter().deploy(CTX(ORG_A), {
      functionRef: {
        organizationId: ORG_A,
        provider: "lambda",
        resourceType: "function",
        resourceId: "my-fn",
      },
      artifact: ARTIFACT,
      publish: true,
    });
    expect(result.ok).toBe(true);
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.path).toBe("/2015-03-31/functions/my-fn/code");
  });

  it("reads the function's state and its URL back", async () => {
    const result = await adapter().getDeployment(CTX(ORG_A), {
      organizationId: ORG_A,
      provider: "lambda",
      resourceType: "function",
      resourceId: "my-fn",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("succeeded");
      expect(result.value.url).toBe("https://abc.lambda-url.us-east-1.on.aws/");
    }
  });

  it("reads a function's logs", async () => {
    const result = await adapter().getLogs(CTX(ORG_A), {
      organizationId: ORG_A,
      provider: "lambda",
      resourceType: "function",
      resourceId: "my-fn",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lines).toEqual(["hello", "world"]);
  });
});

describe("Lambda adapter — tenant isolation", () => {
  it("signs with the calling organization's key, never another's", async () => {
    // Build both adapters first: `adapter()` clears `seen` for the next test.
    const a = adapter();
    const b = adapter();
    await a.getDeployment(CTX(ORG_A), {
      organizationId: ORG_A,
      provider: "lambda",
      resourceType: "function",
      resourceId: "my-fn",
    });
    await b.getDeployment(CTX(ORG_B), {
      organizationId: ORG_B,
      provider: "lambda",
      resourceType: "function",
      resourceId: "my-fn",
    });

    // Two distinct keys produced two distinct signatures for the same route.
    const forA = seen.find((s) => s.authorization?.includes("AKIDEXAMPLE"));
    const forB = seen.find((s) => s.authorization?.includes("AKIDOTHER"));
    expect(forA).toBeDefined();
    expect(forB).toBeDefined();
    expect(forB!.authorization).toContain("/eu-west-1/lambda/aws4_request");
  });
});

describe("serverless status mapping and artifact validation", () => {
  it("maps Lambda's own state onto Cloud Wai's vocabulary", () => {
    expect(mapLambdaStatus("Active", "Successful")).toBe("succeeded");
    expect(mapLambdaStatus("Pending", undefined)).toBe("running");
    expect(mapLambdaStatus("Active", "InProgress")).toBe("running");
    // A function whose last update failed is not a success.
    expect(mapLambdaStatus("Active", "Failed")).toBe("degraded");
    expect(mapLambdaStatus("Failed", undefined)).toBe("failed");
    expect(mapLambdaStatus(undefined, undefined)).toBe("pending");
  });

  it("rejects an artifact it cannot actually deploy", () => {
    expect(validateArtifact(undefined).ok).toBe(false);
    expect(validateArtifact({ kind: "s3", bucket: "", key: "x" }).ok).toBe(false);
    expect(validateArtifact({ kind: "image", uri: "not-an-ecr-uri" }).ok).toBe(false);
    expect(validateArtifact(ARTIFACT).ok).toBe(true);
    expect(
      validateArtifact({ kind: "image", uri: "111.dkr.ecr.us-east-1.amazonaws.com/fn:1" }).ok,
    ).toBe(true);
  });
});
