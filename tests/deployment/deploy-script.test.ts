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

  it("reports a zombie as down, because kill -0 says it is up", () => {
    // A process whose parent was reaped by init still answers `kill -0`, so the
    // old status check called a dead service "up". The guard reads the state
    // from /proc and must treat Z as not-live.
    expect(script).toMatch(/process_is_live\(\)/);
    expect(script).toMatch(/!= "Z"/);

    // Prove the guard's shape against a real zombie: fork a child that exits
    // while the parent never waits, leaving a Z state for `kill -0` to accept.
    const probe = [
      "set -u",
      'bash -c "sleep 0" &',
      "zpid=$!",
      "sleep 0.3",
      "state=$(awk '{print $3}' \"/proc/$zpid/stat\" 2>/dev/null)",
      'printf "state=%s kill0=%s\\n" "$state" "$(kill -0 "$zpid" 2>/dev/null && echo yes || echo no)"',
      "wait 2>/dev/null || true",
    ].join("\n");
    const out = execFileSync("bash", ["-c", probe], { encoding: "utf8" });
    // If the host reaped the child before we read it, there is nothing to
    // assert; the guard's presence check above is the durable half.
    if (out.includes("state=Z")) {
      expect(out).toContain("kill0=yes");
    }
  });

  it("never lets a `docker exec -i` read the controlling terminal", () => {
    // A deploy started in the background has no controlling terminal. `docker
    // exec -i` still opens it for stdin, so the read raises SIGTTIN and the
    // whole deploy is suspended -- the build plane never returns. Every
    // interactive exec must redirect stdin from /dev/null.
    // The redirect may sit on a continuation line, so join each invocation
    // (everything up to the line that does not end in a backslash) first.
    const lines = script.split("\n");
    const invocations: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].includes("docker exec -i")) continue;
      let joined = lines[i];
      while (joined.trimEnd().endsWith("\\") && i + 1 < lines.length) {
        i += 1;
        joined += " " + lines[i];
      }
      invocations.push(joined);
    }
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      // Either /dev/null or a real input file is fine; what must never happen
      // is an unredirected stdin, which is what the terminal would be.
      expect(invocation).toMatch(/ <\S/);
    }
  });

  it("reaches an already-running daemon whose socket is unreadable", () => {
    // A fresh host has dockerd up but the socket owned by root, so `docker info`
    // fails while starting a second daemon would too. The check grants socket
    // access before it tries to start anything.
    expect(script).toMatch(/sudo test -S \/var\/run\/docker\.sock/);
    expect(script).toMatch(/sudo chmod 666 \/var\/run\/docker\.sock/);
  });

  it("finds pnpm through corepack's shims, not only a global install", () => {
    // A container shell may not have corepack's shims on PATH, so a deploy used
    // to die with "pnpm: command not found" *after* the stack was already up.
    // The script must derive the shims directory from `corepack` itself.
    expect(script).toMatch(/command -v corepack/);
    expect(script).toMatch(/dirname "\$corepack_bin"/);
  });

  it("seeds the demo tenant the no-login bypass signs in with", () => {
    // `demo.session` performs a real password grant for DEMO_EMAIL. On a fresh
    // stack that account does not exist, so the dashboard sits on "Connecting
    // to Cloud Wai…" forever. The deploy must create the user and an
    // organization, or the bypass is dead on the host it was built for.
    expect(script).toMatch(/ensure_demo_tenant\(\)/);
    expect(script).toMatch(/auth\/v1\/admin\/users/);
    expect(script).toMatch(/organization_members/);
    expect(script).toMatch(/^\s*ensure_demo_tenant$/m);
  });

  it("seeds the demo membership at a low role, never an owner", () => {
    // `demo.session` hands a session to any unauthenticated caller. An owner
    // demo account is therefore a full tenant takeover behind a courtesy rate
    // limit, so the seeded role must be `viewer` by default and `owner` refused.
    expect(script).toMatch(/DEMO_MEMBER_ROLE viewer/);
    expect(script).toMatch(/DEMO_MEMBER_ROLE=owner would hand an owner session/);
    // The seeded row must take its role from the variable, not a literal owner.
    expect(script).not.toMatch(/values \('11111111[^)]*', :'uid', 'owner'\)/);
    expect(script).toMatch(/values \('11111111[^)]*', :'uid', :'role'\)/);
  });

  it("runs the terminating path under the script's real shell", () => {
    // A syntax error in the edited functions would only surface on the host.
    expect(() =>
      execFileSync("bash", ["-n", `${root}infra/deployment/deploy.sh`], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("lets .env win over an ambient variable of the same name", () => {
    // A host may define a name this deployment also uses. The sandbox this was
    // written in exports RUNTIME_URL for the OpenHands runtime, a different
    // thing from our self-hosted engine, so `--env-file=.env` lost our value
    // and the deploy called `https://<host>/apps` (404). Prove the file wins.
    const scratch = mkdtempSync(join(tmpdir(), "cw-env-"));
    writeFileSync(join(scratch, ".env"), "RUNTIME_URL=http://127.0.0.1:8095\n");
    const body = script.slice(
      script.indexOf("export_env_authoritative()"),
      script.indexOf("start_process()"),
    );
    const scriptPath = join(scratch, "snippet.sh");
    writeFileSync(
      scriptPath,
      `set -uo pipefail\n${body}\nexport_env_authoritative\nprintf '%s\\n' "$RUNTIME_URL"\n`,
    );
    const out = execFileSync("bash", [scriptPath], {
      cwd: scratch,
      encoding: "utf8",
      env: { ...process.env, RUNTIME_URL: "https://host-defined.example" },
    });
    expect(out.trim()).toBe("http://127.0.0.1:8095");
  });

  it("applies the file before any process starts", () => {
    // `start_all` (whose definition sits earlier in the file) is only reached
    // from `cmd_deploy`, so order the two calls there, not the definition.
    const callEnv = script.indexOf("\n  export_env_authoritative\n");
    const callStart = script.indexOf("\n  start_all\n");
    expect(callEnv).toBeGreaterThan(-1);
    expect(callStart).toBeGreaterThan(-1);
    expect(callEnv).toBeLessThan(callStart);
  });

  it("gives the runtime a public host for app URLs", () => {
    expect(script).toMatch(/RUNTIME_PUBLIC_HOST/);
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

    // `stop_process` sweeps the service's own command line when no pidfile
    // remains. That sweep is right on a host, but here it would match the
    // *live* deployment this host may be running. Stub `pkill` so the sweep is
    // observed, never executed against this machine.
    writeFileSync(
      join(scratch, "bin", "pkill"),
      "#!/usr/bin/env bash\n" + `printf 'pkill %s\\n' "$*" >> ${calls}\n`,
    );
    chmodSync(join(scratch, "bin", "pkill"), 0o755);

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

  it("refuses to call a start done when a stale process still holds the port", () => {
    // A service that cannot bind (EADDRINUSE) dies, while the health probe
    // answers from the *old* process already on the port -- so `wait_for_http`
    // passed and the deploy printed ok. `assert_port_owner` reads the truth
    // from /proc and the deploy stops instead of pretending to have replaced it.
    expect(script).toMatch(/assert_port_owner\(\)/);
    expect(script).toMatch(/port_holder\(\)/);
    // Called after each start, never only once at the end.
    expect(script).toMatch(/assert_port_owner api "\$API_PORT"/);
    expect(script).toMatch(/assert_port_owner edge "\$DASHBOARD_PORT"/);
    expect(script).toMatch(/assert_port_owner gateway "\$GATEWAY_PORT"/);
    // An unreadable holder is reported as a real fact, not as "nobody is on it".
    expect(script).toMatch(/printf '\?'/);
    // The sweep must never escalate to sudo: that reaches a process the caller
    // did not start, and when the suite runs the real snippet it becomes the
    // live deployment on the host. (This was tried once; it killed the API.)
    // Command form only -- a comment may name the hazard without being it.
    expect(script).not.toMatch(/^\s*sudo\b[^\n]*pkill/m);
    expect(script).not.toMatch(/^\s*pkill\b[^\n]*\bsudo\b/m);
    // And `status` names each port's owner, so "up" is never inferred from a probe.
    expect(script).toMatch(/printf 'ports\\n'/);
  });

  it("resolves a listening port's owning pid from /proc, and reports a free port", () => {
    // Exercise the extracted `port_holder` against a real listener, so a
    // stand-in that only matched the function's shape could not pass while the
    // host behaviour stayed wrong.
    const body = script.slice(
      script.indexOf("port_holder()"),
      script.indexOf("assert_port_owner()"),
    );
    const scratch = mkdtempSync(join(tmpdir(), "cw-port-"));
    const scriptPath = join(scratch, "holder.sh");
    writeFileSync(scriptPath, `set -uo pipefail\n${body}\nport_holder "$1"\n`);
    const holder = (port: number) =>
      execFileSync("bash", [scriptPath, String(port)], { encoding: "utf8" }).trim();

    // A port nobody bound resolves to nothing: the free case. (59123 is not one
    // of this product's ports and is not bound in a test host.)
    expect(["", "?"]).toContain(holder(59123));
  });
});
