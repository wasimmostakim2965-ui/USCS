import type { IncomingMessage, ServerResponse } from "node:http";
import { start } from "@cloud-wai/api";

/**
 * Same-origin Vercel adapter for the control-plane API.
 *
 * The browser must never fall back to 127.0.0.1 in production: on a phone that
 * address means the phone itself. The long-lived API server is started once per
 * warm function and the function forwards only the authenticated RPC request to
 * its loopback listener. Secrets remain server-side in Vercel environment vars.
 */
type VercelRequest = IncomingMessage & { body?: unknown };
type VercelResponse = ServerResponse & {
  status?: (code: number) => VercelResponse;
  json?: (body: unknown) => void;
};

let apiPromise: ReturnType<typeof start> | null = null;

function apiInstance() {
  apiPromise ??= start({ host: "127.0.0.1", port: 0 });
  return apiPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST, OPTIONS");
    res.end(
      JSON.stringify({
        ok: false,
        status: 405,
        error: { code: "method_not_allowed", message: "Use POST." },
      }),
    );
    return;
  }

  try {
    const result = await apiInstance();
    if (!("server" in result)) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: false,
          status: 503,
          error: { code: "unavailable", message: "Control-plane API is not configured." },
        }),
      );
      return;
    }

    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const response = await fetch(`${result.server.url}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(typeof req.headers.authorization === "string"
          ? { authorization: req.headers.authorization }
          : {}),
      },
      body,
    });
    const payload = await response.text();
    res.statusCode = response.status;
    res.setHeader(
      "content-type",
      response.headers.get("content-type") ?? "application/json; charset=utf-8",
    );
    res.setHeader("cache-control", "no-store");
    res.end(payload);
  } catch {
    res.statusCode = 503;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        status: 503,
        error: { code: "unavailable", message: "Control-plane API is temporarily unavailable." },
      }),
    );
  }
}
