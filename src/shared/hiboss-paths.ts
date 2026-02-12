import * as os from "node:os";
import * as path from "node:path";

import { HIBOSS_DIR_ENV } from "./env.js";
import {
  DEFAULT_AGENTS_DIRNAME,
  DEFAULT_DAEMON_DIRNAME,
  DEFAULT_DB_FILENAME,
  DEFAULT_MEDIA_DIRNAME,
  DEFAULT_SOCKET_FILENAME,
  DEFAULT_PID_FILENAME,
  getDefaultHiBossDir,
} from "./defaults.js";

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function resolveRootDirFromEnv(): { ok: true; dir: string } | { ok: false; error: string } {
  const raw = (process.env[HIBOSS_DIR_ENV] ?? "").trim();
  if (!raw) return { ok: true, dir: getDefaultHiBossDir() };

  const expanded = expandTilde(raw);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: `Invalid ${HIBOSS_DIR_ENV} (must be an absolute path or start with ~): ${raw}` };
  }

  return { ok: true, dir: expanded };
}

export interface HiBossPaths {
  rootDir: string;
  daemonDir: string;
  agentsDir: string;
  mediaDir: string;
  dbPath: string;
  socketPath: string;
  pidPath: string;
}

export function getHiBossPaths(): HiBossPaths {
  const resolved = resolveRootDirFromEnv();
  if (!resolved.ok) {
    // Keep CLI output predictable: fail fast with a single-line error.
    console.error("error:", resolved.error);
    process.exit(1);
  }

  const rootDir = resolved.dir;
  const daemonDir = path.join(rootDir, DEFAULT_DAEMON_DIRNAME);

  return {
    rootDir,
    daemonDir,
    agentsDir: path.join(rootDir, DEFAULT_AGENTS_DIRNAME),
    mediaDir: path.join(rootDir, DEFAULT_MEDIA_DIRNAME),
    dbPath: path.join(daemonDir, DEFAULT_DB_FILENAME),
    socketPath: path.join(daemonDir, DEFAULT_SOCKET_FILENAME),
    pidPath: path.join(daemonDir, DEFAULT_PID_FILENAME),
  };
}

export function getHiBossRootDir(): string {
  return getHiBossPaths().rootDir;
}
