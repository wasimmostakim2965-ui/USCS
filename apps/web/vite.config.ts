/**
 * Vite configuration for the dashboard.
 *
 * `tsc -b` remains the typechecker for the whole workspace; Vite only bundles
 * the browser application. Keeping the two separate means adding this renderer
 * did not change how any other package is built or tested.
 *
 * The API base URL is read from `VITE_CLOUD_WAI_API_URL` with a local default.
 * There is no proxy: the browser talks to the Cloud Wai API over CORS, and the
 * API decides which origins are allowed. A proxy would hide that boundary
 * during development and let a misconfiguration ship.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/browser",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
