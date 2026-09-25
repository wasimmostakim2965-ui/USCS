/**
 * The build's version string.
 *
 * One source, so the landing footer and anything else that prints a version
 * cannot drift. `VITE_APP_VERSION` is set at build time by a deployment that
 * wants its own tag; the fallback mirrors the workspace package version, which
 * is what a local build shows.
 */
export const APP_VERSION: string =
  (import.meta.env as unknown as Record<string, string | undefined>)["VITE_APP_VERSION"] ?? "0.1.0";
