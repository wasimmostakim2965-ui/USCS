/**
 * API entry point.
 *
 * Kept deliberately small: it starts the server and reports, in operator
 * language, why it could not. `start` fails closed when Supabase auth or the
 * control-plane database is unset, so an unconfigured deployment cannot pretend
 * to be an API.
 */
import { start } from "./bootstrap.js";

const result = await start();

if ("reason" in result) {
  // Written to stderr so a supervisor notices and does not treat the process as
  // healthy. The exit code is non-zero for the same reason.
  process.stderr.write(
    `Cloud Wai API cannot start: ${result.reason}\n` +
      "This is expected until the control plane is configured. No fake store is used.\n",
  );
  process.exit(1);
}

process.stdout.write(`Cloud Wai API listening on ${result.server.url}\n`);

const shutdown = async () => {
  await result.server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
