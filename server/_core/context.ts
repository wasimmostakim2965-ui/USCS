import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { authenticateApiKeyRequest, authenticateSupabaseRequest, type SupabaseIdentity } from "./supabaseAuth";

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
    // Authentication is optional for public procedures.
    identity = null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user: null,
    identity,
  };
}
