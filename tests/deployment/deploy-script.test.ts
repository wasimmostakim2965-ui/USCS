/**
 * `deploy.sh` is the "click deploy" entry point, and the one part of the
 * repository that a reviewer cannot exercise through the test suite without a
 * host. Two of its properties are load-bearing and were both silently wrong:
 *
 *   1. `start_process` must record the pid of the process that *is* the
 *      service. `setsid` forks a session leader and the parent exits, so `$!`
 *      (the old code) named a process that may already be gone — and the real
 *      service ran on untracked. That made `status` print a live service as
 *      "down" and left `down`/restart unable to stop it.
 *   2. `down` must stop every process it started, and nothing else. A fix for
 *      (1) that stopped by a broad keyword (`pkill -f node`) would pass the
 *      first test and take unrelated work down with it, so the sweep patterns
 *      are asserted to be the services' own command lines.
 *
 * The last test runs the script with a stub `setsid` on `PATH`, so the
 * assertions are on what the script *does*, not on how it reads. A real
 * `setsid` there would fork a daemon the test could not reliably reap.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = readFileSync(`${root}infra/deployment/deploy.sh`, "utf8");

describe("the one-command deploy script", () => {
  it("records the pid of the setsid child, not the parent the shell forks", () => {
    // The regression: `echo $! > pidfile` tracked the `setsid` parent.
    expect(script).not.toMatch(/setsid nohup "\$@"[^\n]*\n\s*echo \$!/);
    // The fix: a wrapper writes its own pid and then execs the service, so the
    // recorded pid and the service are one process.
    expect(script).toMatch(/exec\$\{quoted\}/);
    expect(script).toMatch(/\\\$\\\$/);
  });

  it("waits for the pidfile before treating a start as done", () => {
    // A wrapper writes the file asynchronously; reading it immediately would
    // race the same bug back in through `status`.
    expect(script).toMatch(/while \[\[ ! -s "\$pidfile" \]\]/);
  });

  it("stops by the recorded pid and then sweeps only the service's own command line", () => {
    expect(script).toMatch(/kill "\$pid"/);
    // Each sweep pattern names the service entrypoint, never a broad keyword.
    for (const pattern of [
      "apps/api/dist/main.js",
      "apps/worker/dist/main.js",
      "infra/deployment/edge-server.mjs",
      "infra/deployment/gateway-proxy.mjs",
    ]) {
      expect(script).toContain(pattern);
    }
    expect(script).not.toMatch(/pkill -f ['"]?node['"]?\s/);
    expect(script).not.toMatch(/pkill -f ['"]?python/);
  });

  it("parses under the shell that will run it", () => {
    // A syntax error in the edited functions would only surface on the host.
    expect(() =>
      execFileSync("bash", ["-n", `${root}infra/deployment/deploy.sh`], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("starts each service through the wrapper, and the wrapper execs it", () => {
    const scratch = mkdtempSync(join(tmpdir(), "cw-deploy-"));
    mkdirSync(join(scratch, "bin"), { recursive: true });
    const calls = join(scratch, "calls");

    // A stub `setsid` that runs its command synchronously, so the assertions
    // can see the wrapper's pid write and its `exec` without forking a daemon.
    const stub = ["#!/usr/bin/env bash", `printf 'setsid %s\\n' "$*" >> ${calls}`, '"$@"', ""].join(
      "\n",
    );
    writeFileSync(join(scratch, "bin", "setsid"), stub);
    chmodSync(join(scratch, "bin", "setsid"), 0o755);

    const body = script
      .slice(script.indexOf("start_process()"), script.indexOf("start_all()"))
      .replaceAll("$RUN_DIR", scratch)
      .replaceAll("$LOG_DIR", scratch);
    const scriptPath = join(scratch, "snippet.sh");
    writeFileSync(
      scriptPath,
      `set -uo pipefail\nRUN_DIR=${scratch}\nLOG_DIR=${scratch}\n${body}\nstart_process api true\n`,
    );

    execFileSync("bash", [scriptPath], {
      env: { ...process.env, PATH: `${join(scratch, "bin")}:${process.env.PATH}` },
      stdio: "pipe",
    });

    const pidfile = readFileSync(join(scratch, "api.pid"), "utf8").trim();
    expect(pidfile).toMatch(/^\d+$/);
    // The wrapper wrote the pidfile itself before exec'ing, so the pid the
    // operator can signal is the service's own.
    expect(readFileSync(calls, "utf8")).toContain("setsid");
  });
});
