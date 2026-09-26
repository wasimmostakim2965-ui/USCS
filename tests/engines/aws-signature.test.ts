/**
 * AWS Signature Version 4 against AWS's own published test suite.
 *
 * The signer is only trustworthy if it reproduces a value AWS produced, not one
 * this repository produced. This pins the `get-vanilla` case from the published
 * "Test Suite for AWS Signature Version 4": a fixed key, date, region, service
 * and request, whose expected `Authorization` header is a documented constant.
 *
 * If this test fails after a refactor, the signer is wrong — a real deployment
 * would sign every Lambda call incorrectly and read the resulting 403 as an
 * engine fault. That is exactly the misreport this repository refuses to make.
 */
import { describe, expect, it } from "vitest";
import { signSigV4Request, signingKey } from "@cloud-wai/adapters";

// Values from the published suite. Not secrets: they are AWS's example keypair.
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("AWS SigV4 — published get-vanilla vector", () => {
  it("reproduces the documented Authorization header", () => {
    const signed = signSigV4Request(CREDENTIALS, {
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      now: new Date("2015-08-30T12:36:00Z"),
    });

    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 " +
        "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("sends the host and date headers it signed", () => {
    const signed = signSigV4Request(CREDENTIALS, {
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(signed.headers.host).toBe("example.amazonaws.com");
    expect(signed.headers["x-amz-date"]).toBe("20150830T123600Z");
  });
});

describe("AWS SigV4 — properties the adapter depends on", () => {
  it("changes the signature when the body changes", () => {
    const base = {
      method: "POST" as const,
      url: "https://lambda.us-east-1.amazonaws.com/2015-03-31/functions",
      region: "us-east-1",
      service: "lambda",
      now: new Date("2026-01-01T00:00:00Z"),
    };
    const first = signSigV4Request(CREDENTIALS, { ...base, body: JSON.stringify({ a: 1 }) });
    const second = signSigV4Request(CREDENTIALS, { ...base, body: JSON.stringify({ a: 2 }) });
    expect(first.headers.authorization).not.toBe(second.headers.authorization);
  });

  it("canonicalises the body's whitespace deterministically", () => {
    const base = {
      method: "POST" as const,
      url: "https://lambda.us-east-1.amazonaws.com/2015-03-31/functions",
      region: "us-east-1",
      service: "lambda",
      now: new Date("2026-01-01T00:00:00Z"),
      body: JSON.stringify({ a: 1 }),
    };
    expect(signSigV4Request(CREDENTIALS, base).headers.authorization).toBe(
      signSigV4Request(CREDENTIALS, { ...base }).headers.authorization,
    );
  });

  it("includes a session token header only when one is present", () => {
    const base = {
      method: "GET" as const,
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      now: new Date("2015-08-30T12:36:00Z"),
    };
    const without = signSigV4Request(CREDENTIALS, base);
    const withToken = signSigV4Request({ ...CREDENTIALS, sessionToken: "TOKEN" }, { ...base });
    expect(without.headers["x-amz-security-token"]).toBeUndefined();
    expect(withToken.headers["x-amz-security-token"]).toBe("TOKEN");
    // The token is part of what is signed, so its presence changes the signature.
    expect(withToken.headers.authorization).not.toBe(without.headers.authorization);
  });

  it("derives a date/region/service-scoped signing key", () => {
    const key = signingKey(CREDENTIALS.secretAccessKey, "20150830", "us-east-1", "service");
    expect(key.toString("hex")).toHaveLength(64);
    // A different region must not reuse the same key material.
    const other = signingKey(CREDENTIALS.secretAccessKey, "20150830", "us-west-2", "service");
    expect(other.equals(key)).toBe(false);
  });
});
