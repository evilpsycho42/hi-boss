import { Daemon, getDefaultConfig } from "./daemon/daemon.js";
import { errorMessage, logEvent } from "./shared/daemon-log.js";

/**
 * Daemon entry point for background process.
 */
async function main() {
  const config = getDefaultConfig();

  const daemon = new Daemon(config);

  // Graceful shutdown
  const shutdown = async () => {
    logEvent("info", "daemon-shutdown-requested");
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await daemon.start();
  } catch (err) {
    logEvent("error", "daemon-start-failed", { error: errorMessage(err) });
    process.exit(1);
  }
}

main();
