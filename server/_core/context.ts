import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { TRPCError } from "@trpc/server";
import { authenticateApiKeyRequest, authenticateSupabaseRequest, hasApiKeyHeader, type SupabaseIdentity } from "./supabaseAuth";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: null;
  identity: SupabaseIdentity | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let identity: SupabaseIdentity | null = null;

  try {
    identity = await authenticateApiKeyRequest(opts.req);
    if (!identity) identity = await authenticateSupabaseRequest(opts.req);
  } catch {
    if (hasApiKeyHeader(opts.req)) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired API key" });
    }
    identity = null;
  }

  if (hasApiKeyHeader(opts.req) && !identity) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired API key" });
  }

  return {
    req: opts.req,
    res: opts.res,
    user: null,
    identity,
  };
}
