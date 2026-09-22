/**
 * Unified type exports.
 *
 * Supabase migrations are the single source of truth for persistence. This
 * file intentionally contains application contracts only; it is not a
 * generated database schema and must not be used for migrations.
 */
export type PlatformUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl?: string | null;
};

export * from "./_core/errors";
