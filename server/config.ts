import { z } from "zod";

const optionalUrl = z.string().url().optional();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SUPABASE_URL: optionalUrl,
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_PREMIUM_MONTHLY: z.string().min(1).optional(),
  CONTROL_PLANE_PUBLIC_URL: optionalUrl,
  DATA_PLANE_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
  SECURITY_EDGE_ENABLED: z.enum(["true", "false"]).default("false").transform(v => v === "true"),
});

export const serverConfig = envSchema.parse(process.env);

export function getSupabaseServerKey() {
  return serverConfig.SUPABASE_SERVICE_ROLE_KEY ?? serverConfig.SUPABASE_SECRET_KEY;
}

export function getConfigurationStatus() {
  return {
    supabaseServerVerification: Boolean(getSupabaseServerKey()),
    stripeBilling: Boolean(serverConfig.STRIPE_SECRET_KEY && serverConfig.STRIPE_WEBHOOK_SECRET && serverConfig.STRIPE_PRICE_PREMIUM_MONTHLY),
    dataPlane: serverConfig.DATA_PLANE_ENABLED,
    securityEdge: serverConfig.SECURITY_EDGE_ENABLED,
  };
}

export function assertProductionConfiguration() {
  if (serverConfig.NODE_ENV !== "production") return;
  const missing: string[] = [];
  if (!serverConfig.SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!getSupabaseServerKey()) missing.push("SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY");
  if (missing.length) throw new Error(`Missing production server configuration: ${missing.join(", ")}`);
}
