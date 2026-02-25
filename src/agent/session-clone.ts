/**
 * Session file cloning for one-shot /clone execution.
 *
 * Clones the current provider session file on disk so a one-shot run can
 * resume from the same context without affecting the original session.
 *
 * Supported providers:
 * - Claude: `~/.claude/projects/<slug>/<session_id>.jsonl`
 * - Codex:  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { findCodexRolloutPathForThread } from "./codex-rollout.js";
import { logEvent, errorMessage } from "../shared/daemon-log.js";

export interface ClonedSession {
  originalSessionId: string;
  clonedSessionId: string;
  clonedFilePath: string;
  provider: "claude" | "codex";
}

function generateCloneId(): string {
  return crypto.randomUUID();
}

/**
 * Resolve the Claude session file path for a given session ID.
 *
 * Claude stores sessions in `~/.claude/projects/<slug>/<session_id>.jsonl`.
 * Since we don't know the exact slug algorithm, we scan all project dirs.
 */
async function findClaudeSessionFile(sessionId: string): Promise<string | null> {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
  const targetFile = `${sessionId}.jsonl`;

  let slugDirs: string[];
  try {
    slugDirs = await fs.readdir(claudeProjectsDir);
  } catch {
    return null;
  }

  for (const slug of slugDirs) {
    const candidate = path.join(claudeProjectsDir, slug, targetFile);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // not found in this slug dir
    }
  }

  return null;
}

/**
 * Validate a JSONL file: if the last line is incomplete (truncated),
 * remove it so the session is consistent.
 */
async function trimTruncatedLastLine(filePath: string): Promise<void> {
  const content = await fs.readFile(filePath, "utf-8");
  if (!content.trim()) return;

  const lines = content.split("\n");
  // Remove trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }

  if (lines.length === 0) return;

  const lastLine = lines[lines.length - 1]!.trim();
  try {
    JSON.parse(lastLine);
  } catch {
    // Last line is truncated 鈥?remove it
    lines.pop();
    logEvent("info", "oneshot-clone-trim-truncated", {
      "file-path": filePath,
      "trimmed-chars": lastLine.length,
    });
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
  }
}

/**
 * Clone a Claude session file for one-shot use.
 */
async function cloneClaudeSession(sessionId: string): Promise<ClonedSession | null> {
  const sourcePath = await findClaudeSessionFile(sessionId);
  if (!sourcePath) {
    logEvent("warn", "oneshot-clone-source-not-found", {
      provider: "claude",
      "session-id": sessionId,
    });
    return null;
  }

  const clonedSessionId = generateCloneId();
  const sourceDir = path.dirname(sourcePath);
  const clonedFilePath = path.join(sourceDir, `${clonedSessionId}.jsonl`);

  await fs.copyFile(sourcePath, clonedFilePath);
  await trimTruncatedLastLine(clonedFilePath);

  return {
    originalSessionId: sessionId,
    clonedSessionId,
    clonedFilePath,
    provider: "claude",
  };
}

/**
 * Clone a Codex session file for one-shot use.
 */
async function cloneCodexSession(threadId: string): Promise<ClonedSession | null> {
  const sourcePath = await findCodexRolloutPathForThread(threadId);
  if (!sourcePath) {
    logEvent("warn", "oneshot-clone-source-not-found", {
      provider: "codex",
      "thread-id": threadId,
    });
    return null;
  }

  const clonedThreadId = generateCloneId();
  const sourceDir = path.dirname(sourcePath);
  // Preserve rollout naming convention: rollout-<timestamp>-<thread_id>.jsonl
  const ts = Date.now();
  const clonedFilePath = path.join(sourceDir, `rollout-${ts}-${clonedThreadId}.jsonl`);

  await fs.copyFile(sourcePath, clonedFilePath);
  await trimTruncatedLastLine(clonedFilePath);

  return {
    originalSessionId: threadId,
    clonedSessionId: clonedThreadId,
    clonedFilePath,
    provider: "codex",
  };
}

/**
 * Clone a provider session file for one-shot use.
 *
 * Safe to call while main session is idle.
 * Best-effort if main session is running (JSONL lines are atomic).
 *
 * @returns ClonedSession if cloning succeeded, null if source not found.
 */
export async function cloneSessionFile(params: {
  provider: "claude" | "codex";
  sessionId: string;
}): Promise<ClonedSession | null> {
  if (params.provider === "claude") {
    return cloneClaudeSession(params.sessionId);
  }
  return cloneCodexSession(params.sessionId);
}

/**
 * Delete the cloned session file after one-shot completion.
 */
export async function cleanupClonedSession(clone: ClonedSession): Promise<void> {
  try {
    await fs.unlink(clone.clonedFilePath);
  } catch (err) {
    logEvent("warn", "oneshot-clone-cleanup-failed", {
      provider: clone.provider,
      "cloned-session-id": clone.clonedSessionId,
      "cloned-file-path": clone.clonedFilePath,
      error: errorMessage(err),
    });
  }
}

