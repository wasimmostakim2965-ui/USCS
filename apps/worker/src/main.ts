/**
 * Worker entry point.
 *
 * Kept small and mirroring the API's: it starts the loop and reports, in
 * operator language, why it could not. `startWorker` fails closed when the
 * control-plane database is unset, so an unconfigured worker exits non-zero
 * rather than looping over an empty queue and looking healthy.
 */
import { startWorker } from "./runtime.js";

const result = await startWorker();

if ("reason" in result) {
  process.stderr.write(
    `Cloud Wai worker cannot start: ${result.reason}\n` +
      "This is expected until the control plane is configured. No fake queue is used.\n",
  );
  process.exit(1);
}

process.stdout.write("Cloud Wai worker draining the orchestration queue.\n");

const shutdown = async () => {
  await result.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
