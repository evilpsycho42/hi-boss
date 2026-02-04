/**
 * flock()-based PID locking for daemon single-instance enforcement.
 *
 * Uses proper-lockfile for atomic lock acquisition with automatic
 * cleanup on process crash (kernel releases file locks).
 */

import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import * as lockfile from "proper-lockfile";
import type { DaemonConfig } from "./daemon.js";
import { getHiBossPaths } from "../shared/hiboss-paths.js";

/**
 * PID lock manager using flock-based locking.
 */
export class PidLock {
  private lockPath: string;
  private pidPath: string;
  private socketPath: string;
  private releaseFn: (() => Promise<void>) | null = null;

  constructor(config: { daemonDir: string }) {
    this.lockPath = path.join(config.daemonDir, "daemon.lock");
    this.pidPath = path.join(config.daemonDir, "daemon.pid");
    this.socketPath = path.join(config.daemonDir, "daemon.sock");
  }

  /**
   * Acquire the PID lock.
   * @throws Error if daemon is already running or lock cannot be acquired.
   */
  async acquire(): Promise<void> {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Ensure lock file exists (proper-lockfile requires it)
    if (!fs.existsSync(this.lockPath)) {
      fs.writeFileSync(this.lockPath, "", "utf-8");
    }

    // Check if socket is accepting connections (daemon already running)
    if (await isSocketAcceptingConnections(this.socketPath)) {
      throw new Error("Daemon is already running");
    }

    try {
      this.releaseFn = await lockfile.lock(this.lockPath, {
        stale: 10000, // Consider lock stale after 10s (for crash recovery)
        update: 5000, // Update lock every 5s to prevent stale detection
        retries: 0, // Don't retry - fail immediately if locked
      });
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === "ELOCKED") {
        // Another process holds the lock - verify it's actually running
        if (await isSocketAcceptingConnections(this.socketPath)) {
          throw new Error("Daemon is already running");
        }

        // Lock exists but socket not responding - stale lock
        // Try to acquire with retries to handle race condition
        try {
          this.releaseFn = await lockfile.lock(this.lockPath, {
            stale: 5000,
            update: 5000,
            retries: {
              retries: 3,
              minTimeout: 100,
              maxTimeout: 500,
            },
          });
        } catch {
          throw new Error("Daemon is already running");
        }
      } else {
        throw err;
      }
    }

    // Write PID file for informational purposes (not used for locking)
    fs.writeFileSync(this.pidPath, String(process.pid), "utf-8");
  }

  /**
   * Release the PID lock.
   */
  async release(): Promise<void> {
    // Remove PID file
    try {
      if (fs.existsSync(this.pidPath)) {
        fs.unlinkSync(this.pidPath);
      }
    } catch {
      // ignore
    }

    // Release flock
    if (this.releaseFn) {
      try {
        await this.releaseFn();
      } catch {
        // ignore - may already be released on crash
      }
      this.releaseFn = null;
    }
  }
}

/**
 * Check if daemon is running (socket-first, PID fallback).
 */
export async function isDaemonRunning(
  config: Pick<DaemonConfig, "daemonDir"> = { daemonDir: getHiBossPaths().daemonDir }
): Promise<boolean> {
  const pidPath = path.join(config.daemonDir, "daemon.pid");
  const socketPath = path.join(config.daemonDir, "daemon.sock");

  // Prefer checking the socket directly; PID files can be stale or missing.
  if (await isSocketAcceptingConnections(socketPath)) {
    return true;
  }

  if (!fs.existsSync(pidPath)) {
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8"), 10);
    // Check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // ignore
    }
    return false;
  }
}

/**
 * Check if a Unix socket is accepting connections.
 */
export async function isSocketAcceptingConnections(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return false;

  return new Promise((resolve) => {
    let resolved = false;
    const socket = net.createConnection({ path: socketPath });

    const finish = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), 200);

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
