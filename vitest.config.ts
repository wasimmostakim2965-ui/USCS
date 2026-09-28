import { defineConfig } from "vitest/config";

// Tests are never production, but a production host exports NODE_ENV=production
// and Vite then runs in production mode, where `node:*` builtins are
// externalized as empty modules even under the jsdom environment: `import {
// createServer } from "node:http"` resolves to undefined and every test that
// binds a real HTTP server fails. Pin the mode before Vite reads it.
process.env.NODE_ENV = "test";

export default defineConfig({
  // Vitest transpiles with esbuild, which defaults to the classic JSX runtime
  // and would require `React` in scope in every test file. The automatic
  // runtime matches how the app itself is compiled.
  esbuild: { jsx: "automatic" },
  test: {
    // Tests live under tests/ and alongside sources as *.test.ts(x).
    // The dashboard tests render React, so .tsx is included as well.
    include: ["tests/**/*.test.{ts,tsx}", "{packages,apps}/*/src/**/*.test.{ts,tsx}"],
    environment: "node",
    globals: false,
    reporters: ["default"],
  },
});
