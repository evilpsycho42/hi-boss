import { Daemon, getDefaultConfig } from "./daemon/daemon.js";

/**
 * Daemon entry point for background process.
 */
async function main() {
  const config = getDefaultConfig();

  // Parse --debug flag from command line
  if (process.argv.includes("--debug")) {
    config.debug = true;
  }

  const daemon = new Daemon(config);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[Daemon] Shutting down...");
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await daemon.start();
    if (config.debug) {
      console.log("[Daemon] Debug mode enabled");
    }
  } catch (err) {
    console.error("[Daemon] Failed to start:", err);
    process.exit(1);
  }
}

main();
