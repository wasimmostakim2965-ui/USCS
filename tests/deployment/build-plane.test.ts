/**
 * The build plane's shape, pinned as tests because every property here broke at
 * least once in a way nothing else caught:
 *
 * 1. The server drove Nixpacks with `docker run <nixpacks-image> build …`. The
 *    published `ghcr.io/railwayapp/nixpacks` images are the generated
 *    Dockerfiles' *base* images — CMD `/bin/bash`, no `nixpacks` executable — so
 *    every build died with `exec: "build": executable file not found in $PATH`.
 *    The fix is to run the pinned binary.
 * 2. The framework was read from `plan.providers[0]`, which is empty for the
 *    languages Nixpacks auto-detects, so every ordinary app reported `null`. The
 *    detected language is `plan.variables.NIXPACKS_METADATA`.
 * 3. The builder had no concurrency, timeout, log or retention bounds, so one
 *    tenant's repository could hold the daemon or the process's memory.
 *
 * These are source-level assertions rather than a live build: a real Nixpacks
 * build needs the Docker daemon and the network, which a unit test must not
 * assume. The properties are all local to the file, so reading it is enough to
 * catch a regression.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const server = readFileSync(
  fileURLToPath(new URL("../../infra/deployment/builder-server.mjs", import.meta.url)),
  "utf8",
);
const dockerfile = readFileSync(
  fileURLToPath(new URL("../../infra/deployment/builder.Dockerfile", import.meta.url)),
  "utf8",
);
const compose = readFileSync(
  fileURLToPath(new URL("../../infra/deployment/docker-compose.yml", import.meta.url)),
  "utf8",
);

describe("builder server", () => {
  it("runs the nixpacks binary, not `docker run <nixpacks-image>`", () => {
    // The invocation is `run(NIXPACKS_BIN, ["build", …])`. Assert the binary is
    // the command and that the broken `docker run … nixpacks … build` form is
    // gone, because that form is the exact bug this test exists for.
    expect(server).toContain('const NIXPACKS_BIN = process.env.NIXPACKS_BIN ?? "nixpacks"');
    expect(server).toMatch(/run\(NIXPACKS_BIN,/);
    expect(server).toMatch(/const args = \["build", sourceDir, "--name", tag\]/);
    expect(server).not.toMatch(/NIXPACKS_IMAGE/);
    expect(server).not.toMatch(/"run",\s*"--rm"/);
  });

  it("reads the detected framework from the field Nixpacks actually sets", () => {
    expect(server).toContain("plan.variables?.NIXPACKS_METADATA");
  });

  it("applies the build-time environment the adapter forwards", () => {
    // The adapter sends `environment`; dropping it would build a configured
    // project without its configuration, silently.
    expect(server).toMatch(/args\.push\("--env", `\$\{key\}=\$\{value\}`\)/);
  });

  it("bounds concurrency, duration, log volume and retention", () => {
    for (const key of [
      "BUILDER_CONCURRENCY",
      "BUILDER_BUILD_TIMEOUT_MS",
      "BUILDER_MAX_LOG_LINES",
      "BUILDER_JOB_TTL_MS",
    ]) {
      expect(server, `the builder must read ${key}`).toContain(key);
    }
    // The timeout must actually kill the child, or it holds a slot forever.
    expect(server).toMatch(/child\.kill\("SIGKILL"\)/);
    // Finished jobs must be swept, or the process grows without bound.
    expect(server).toContain("function sweepJobs");
  });

  it("refuses to start without a token", () => {
    expect(server).toMatch(/if \(!TOKEN\)\s*\{[\s\S]*process\.exit\(1\)/);
  });
});

describe("builder image", () => {
  it("installs a pinned nixpacks binary and verifies its digest", () => {
    expect(dockerfile).toContain("NIXPACKS_VERSION");
    expect(dockerfile).toContain("NIXPACKS_SHA256");
    expect(dockerfile).toMatch(/sha256sum -c/);
    expect(dockerfile).toMatch(/tar -xzf[^\n]*nixpacks/);
  });

  it("installs the docker CLI and the buildx plugin nixpacks needs", () => {
    // Without buildx, nixpacks fails with "BuildKit is enabled but the buildx
    // component is missing or broken" and every build stops.
    expect(dockerfile).toContain("docker-ce-cli");
    expect(dockerfile).toContain("docker-buildx-plugin");
  });

  it("puts the binary on PATH and points the server at it", () => {
    expect(dockerfile).toMatch(/ENV NIXPACKS_BIN=\/usr\/local\/bin\/nixpacks/);
  });
});

describe("builder compose service", () => {
  it("is opt-in, so a host without a build plane stays honest", () => {
    expect(compose).toMatch(/builder:[\s\S]*?profiles:\s*\["build"\]/);
  });

  it("gives the docker socket to exactly the two privileged services, only on loopback", () => {
    // A bind mount names the socket twice (`src:dst`), so count mount *lines*,
    // not occurrences. Exactly two services run untrusted work and need the
    // daemon: the build plane (turns source into an image) and the runtime
    // (runs that image). Each is its own image, so neither can read the API's
    // or worker's environment. Adding a third mount is a change to this
    // boundary and must update this test deliberately.
    const socketMounts = compose.match(/^\s*-\s*\/var\/run\/docker\.sock:/gm) ?? [];
    expect(socketMounts.length).toBe(2);
    expect(compose).toMatch(/builder:[\s\S]*?\/var\/run\/docker\.sock:/);
    expect(compose).toMatch(/runtime:[\s\S]*?\/var\/run\/docker\.sock:/);
    expect(compose).toMatch(/ports:\s*\n\s*-\s*"127\.0\.0\.1:8090:8090"/);
    // The runtime shares the host network so the app ports it publishes on
    // 127.0.0.1 are reachable by the router on the same loopback. It therefore
    // has no ports mapping and binds loopback itself (RUNTIME_HOST), which is
    // the same "not on a public interface" guarantee by another mechanism.
    expect(compose).toMatch(/runtime:[\s\S]*?network_mode:\s*host/);
    expect(compose).toMatch(/runtime:[\s\S]*?RUNTIME_HOST:\s*"127\.0\.0\.1"/);
  });
});
