import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live under tests/ and alongside sources as *.test.ts.
    include: ["tests/**/*.test.ts", "{packages,apps}/*/src/**/*.test.ts"],
    environment: "node",
    globals: false,
    reporters: ["default"],
  },
});
