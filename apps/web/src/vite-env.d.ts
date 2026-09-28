/// <reference types="vite/client" />

/**
 * Environment variables this dashboard reads.
 *
 * Only `VITE_`-prefixed values reach the browser, and both are public:
 * `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` identify the
 * Supabase project. The legacy anon key remains a compatibility fallback. The
 * service-role key is never read here and must never be given a VITE_ prefix.
 */
interface ImportMetaEnv {
  readonly VITE_CLOUD_WAI_API_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
