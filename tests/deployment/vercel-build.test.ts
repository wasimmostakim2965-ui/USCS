/**
 * The Vercel build must build the workspace packages the dashboard imports.
 *
 * `apps/web` imports `@cloud-wai/ui` and `@cloud-wai/contracts`, whose package
 * `main`/`exports` point at `dist/` — there is no Vite alias back to their
 * source. `pnpm install` links those packages but does not build them, so a
 * `buildCommand` that runs `vite build` alone fails in Vercel's build container
 * with a module-resolution error, while a local run succeeds because the
 * developer already built the workspace (or `tsc -b` did). That is exactly the
 * trap that made the first Vercel deployment fail: green locally, red on Vercel.
 *
 * This test pins the fix: the build command must build those packages first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = JSON.parse(readFileSync(`${root}vercel.json`, "utf8")) as {
  buildCommand?: string;
  installCommand?: string;
  outputDirectory?: string;
};

describe("the Vercel project configuration", () => {
  it("builds the workspace packages the dashboard imports before bundling", () => {
    const command = config.buildCommand ?? "";
    for (const workspace of ["@cloud-wai/ui", "@cloud-wai/contracts"]) {
      expect(command).toContain(workspace);
    }
    // The bundling step must still be there, and after the workspace builds.
    expect(command).toContain("vite build");
    expect(command.indexOf("@cloud-wai/ui")).toBeLessThan(command.indexOf("vite build"));
  });

  it("publishes the static root Vite actually writes", () => {
    // `apps/web/vite.config.ts` sets `outDir: "dist/browser"`; a mismatch here
    // deploys an empty directory while the build itself succeeds.
    expect(config.outputDirectory).toBe("apps/web/dist/browser");
  });

  it("installs the whole workspace, not just production dependencies", () => {
    // The workspace packages are dev-built here, so `--prod` would omit them.
    expect(config.installCommand ?? "").toContain("--prod=false");
  });
});
