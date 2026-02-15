/**
 * Session file I/O — atomic read/write for per-session JSON files.
 *
 * All writes use a temp file + rename pattern to prevent corruption.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionFile, SessionConversationEntry } from "./types.js";
import { SESSION_FILE_VERSION } from "./types.js";
import { logEvent, errorMessage } from "../../shared/daemon-log.js";

// ── Read ──

/**
 * Read and parse a session JSON file.
 * Returns null if the file doesn't exist or is corrupt.
 */
export function readSessionFile(filePath: string): SessionFile | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as SessionFile;
    if (parsed.version !== SESSION_FILE_VERSION) {
      logEvent("warn", "session-file-version-mismatch", {
        path: filePath,
        expected: SESSION_FILE_VERSION,
        got: parsed.version,
      });
      return null;
    }
    return parsed;
  } catch (err) {
    logEvent("warn", "session-file-read-failed", {
      path: filePath,
      error: errorMessage(err),
    });
    return null;
  }
}

// ── Write (atomic) ──

/**
 * Write a session file atomically (write to .tmp, then rename).
 */
export function writeSessionFile(filePath: string, session: SessionFile): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

// ── Append conversation entry ──

/**
 * Append a conversation entry to an existing session file.
 * Creates the file if it doesn't exist (shouldn't happen in normal flow).
 */
export function appendConversation(
  filePath: string,
  entry: SessionConversationEntry,
): void {
  const session = readSessionFile(filePath);
  if (!session) {
    logEvent("warn", "session-file-append-no-file", { path: filePath });
    return;
  }
  session.conversations.push(entry);
  writeSessionFile(filePath, session);
}

// ── Update summary ──

/**
 * Update the summary and endedAtMs fields of a session file.
 */
export function updateSummary(
  filePath: string,
  summary: string | null,
  endedAtMs: number,
): void {
  const session = readSessionFile(filePath);
  if (!session) {
    logEvent("warn", "session-file-update-no-file", { path: filePath });
    return;
  }
  session.summary = summary;
  session.endedAtMs = endedAtMs;
  writeSessionFile(filePath, session);
}

// ── Create new session file ──

/**
 * Create a new empty session JSON file.
 */
export function createSessionFile(params: {
  filePath: string;
  sessionId: string;
  agentName: string;
  startedAtMs: number;
}): void {
  const session: SessionFile = {
    version: SESSION_FILE_VERSION,
    sessionId: params.sessionId,
    agentName: params.agentName,
    startedAtMs: params.startedAtMs,
    endedAtMs: null,
    summary: null,
    conversations: [],
  };
  writeSessionFile(params.filePath, session);
}

// ── List session files in a date directory ──

/**
 * List all session file names (without extension) in a date directory.
 * Returns empty array if the directory doesn't exist.
 */
export function listSessionFiles(dateDirPath: string): string[] {
  try {
    if (!fs.existsSync(dateDirPath)) return [];
    const stat = fs.statSync(dateDirPath);
    if (!stat.isDirectory()) return [];
    return fs
      .readdirSync(dateDirPath)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
