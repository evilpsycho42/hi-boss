import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { getDefaultConfig, isDaemonRunning, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { authorizeCliOperation } from "../authz.js";
import { resolveToken } from "../token.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface DaemonStatusResult {
  running: boolean;
  startTime?: string;
  adapters: string[];
  dataDir: string;
  debug?: boolean;
}

export interface StartDaemonOptions {
  debug?: boolean;
  token?: string;
}

export interface StopDaemonOptions {
  token?: string;
}

export interface DaemonStatusOptions {
  token?: string;
}

/**
 * Start the daemon.
 */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<void> {
  const config = getDefaultConfig();

  try {
    const token = resolveToken(options.token);
    authorizeCliOperation("daemon.start", token);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }

  // Ensure data directory exists
  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  // Acquire PID file lock before spawning to prevent race condition.
  // This is atomic at the filesystem level - only one process can create the file.
  const pidPath = path.join(config.dataDir, "daemon.pid");
  try {
    const fd = fs.openSync(pidPath, "wx");
    try {
      // Write placeholder; daemon will overwrite with its actual PID
      fs.writeFileSync(fd, "starting", "utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      // PID file exists - check if daemon is actually running
      if (await isDaemonRunning(config)) {
        console.log("Daemon is already running");
        return;
      }
      // Stale PID file - remove and retry
      try {
        fs.unlinkSync(pidPath);
        const fd = fs.openSync(pidPath, "wx");
        try {
          fs.writeFileSync(fd, "starting", "utf-8");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        console.error("Failed to acquire daemon lock");
        process.exit(1);
      }
    } else {
      throw err;
    }
  }

  // Find the daemon entry script
  // When running with tsx, use .ts files; when running compiled, use .js files
  let daemonScript: string;
  let args: string[];

  const tsPath = path.resolve(__dirname, "../../daemon-entry.ts");
  const jsPath = path.resolve(__dirname, "../../daemon-entry.js");

  if (fs.existsSync(tsPath) && process.argv[0].includes("tsx")) {
    // Running via tsx - use tsx to run the TypeScript file
    daemonScript = "tsx";
    args = [tsPath];
  } else if (fs.existsSync(jsPath)) {
    // Running compiled JavaScript
    daemonScript = process.execPath;
    args = [jsPath];
  } else if (fs.existsSync(tsPath)) {
    // TypeScript file exists, try to run it with tsx
    daemonScript = "npx";
    args = ["tsx", tsPath];
  } else {
    console.error("Daemon entry script not found");
    process.exit(1);
  }

  const logPath = path.join(config.dataDir, "daemon.log");
  const logFile = fs.openSync(logPath, "a");

  // Pass debug flag via environment variable
  const env = { ...process.env };
  if (options.debug) {
    args.push("--debug");
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(daemonScript, args, {
      detached: true,
      stdio: ["ignore", logFile, logFile],
      env,
      shell: daemonScript === "npx",
    });
  } catch (error) {
    // Clean up PID file on spawn failure
    try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
    console.error("Failed to spawn daemon process:", error);
    process.exit(1);
  } finally {
    fs.closeSync(logFile);
  }

  child.unref();

  // Wait for daemon to start
  let attempts = 0;
  const maxAttempts = 30;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 100));

    if (await isDaemonRunning(config)) {
      console.log("Daemon started successfully");
      console.log(`Log file: ${logPath}`);
      return;
    }

    attempts++;
  }

  // Clean up PID file if daemon failed to start
  try { fs.unlinkSync(pidPath); } catch { /* ignore */ }
  console.error("Failed to start daemon. Check logs at:", logPath);
  process.exit(1);
}

/**
 * Stop the daemon.
 */
export async function stopDaemon(options: StopDaemonOptions = {}): Promise<void> {
  const config = getDefaultConfig();
  const pidPath = path.join(config.dataDir, "daemon.pid");

  try {
    const token = resolveToken(options.token);
    authorizeCliOperation("daemon.stop", token);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }

  if (!fs.existsSync(pidPath)) {
    console.log("Daemon is not running");
    return;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8"), 10);
    process.kill(pid, "SIGTERM");

    // Wait for process to exit
    let attempts = 0;
    while (attempts < 30) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        process.kill(pid, 0);
      } catch {
        // Process has exited
        console.log("Daemon stopped");
        return;
      }
      attempts++;
    }

    // Force kill if still running
    process.kill(pid, "SIGKILL");
    console.log("Daemon forcefully stopped");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // Process doesn't exist, clean up PID file
      fs.unlinkSync(pidPath);
      console.log("Daemon was not running (cleaned up stale PID file)");
    } else {
      throw err;
    }
  }
}

/**
 * Get daemon status.
 */
export async function daemonStatus(options: DaemonStatusOptions = {}): Promise<void> {
  const config = getDefaultConfig();

  let token: string;
  try {
    token = resolveToken(options.token);
    authorizeCliOperation("daemon.status", token);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }

  if (!(await isDaemonRunning(config))) {
    console.log("running: false");
    console.log("start-time: (none)");
    console.log(`debug: ${(config.debug ?? false) ? "enabled" : "disabled"}`);
    console.log("adapters: (none)");
    console.log(`data-dir: ${config.dataDir}`);
    return;
  }

  try {
    const client = new IpcClient(getSocketPath(config));
    const status = await client.call<DaemonStatusResult>("daemon.status", { token });

    console.log(`running: ${status.running ? "true" : "false"}`);
    console.log(`start-time: ${status.startTime ?? "(none)"}`);
    console.log(`debug: ${status.debug ? "enabled" : "disabled"}`);
    console.log(`adapters: ${status.adapters.join(", ") || "(none)"}`);
    console.log(`data-dir: ${status.dataDir}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
