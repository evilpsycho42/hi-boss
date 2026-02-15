/**
 * Session summary generation — spawns Claude CLI (Haiku) to summarize
 * a session's conversation on session end.
 *
 * Summary generation is best-effort: failures are logged and result in
 * a null summary. This never blocks session refresh or daemon stop.
 */

import { spawn } from "node:child_process";

import type { SessionFile } from "./types.js";
import type { ConversationHistory } from "./conversation-history.js";
import { readSessionFile, updateSummary } from "./session-file-io.js";
import { logEvent, errorMessage } from "../../shared/daemon-log.js";
import { DEFAULT_SESSION_SUMMARY_TIMEOUT_MS } from "../../shared/defaults.js";

const SUMMARY_PROMPT = `Summarize the following conversation between a user and an AI assistant.
Write 2-5 sentences focusing on key topics discussed and decisions made.
Be concise. Do not start with "The conversation" or "In this conversation".

<conversation>
{{CONVERSATIONS}}
</conversation>`;

// ── Public API ──

/**
 * Generate a summary string for a session file's conversations.
 * Returns null on failure or empty sessions.
 */
export async function generateSessionSummary(params: {
  sessionFile: SessionFile;
  timeoutMs?: number;
}): Promise<string | null> {
  const { sessionFile, timeoutMs = DEFAULT_SESSION_SUMMARY_TIMEOUT_MS } = params;

  if (sessionFile.conversations.length === 0) return null;

  const conversationText = sessionFile.conversations
    .map((c) => `${c.role}: ${c.text}`)
    .join("\n");

  const prompt = SUMMARY_PROMPT.replace("{{CONVERSATIONS}}", conversationText);

  try {
    const result = await spawnClaudeHaiku(prompt, timeoutMs);
    if (!result || result.trim().length === 0) return null;
    return result.trim();
  } catch (err) {
    logEvent("warn", "session-summary-generation-failed", {
      "session-id": sessionFile.sessionId,
      error: errorMessage(err),
    });
    return null;
  }
}

/**
 * Summarize and close a single agent's active session.
 * Reads the session file, generates a summary, writes it back, and clears tracking.
 */
export async function summarizeAndCloseSession(params: {
  history: ConversationHistory;
  agentName: string;
}): Promise<void> {
  const { history, agentName } = params;
  const filePath = history.getCurrentSessionFilePath(agentName);
  if (!filePath) return;

  const sessionFile = readSessionFile(filePath);
  if (!sessionFile) return;
  if (sessionFile.conversations.length === 0) {
    // Close without summary for empty sessions.
    history.withFileLock(agentName, () => {
      updateSummary(filePath, null, Date.now());
    });
    history.clearActiveSession(agentName);
    return;
  }

  const summary = await generateSessionSummary({ sessionFile });
  history.withFileLock(agentName, () => {
    updateSummary(filePath, summary, Date.now());
  });
  history.clearActiveSession(agentName);

  logEvent("info", "session-summary-generated", {
    "agent-name": agentName,
    "session-id": sessionFile.sessionId,
    "summary-length": summary?.length ?? 0,
  });
}

/**
 * Summarize and close a session by file path (no dependency on activeSessionIds).
 * Used by refreshSession() which creates the new session first, then closes the old one.
 */
export async function summarizeAndCloseSessionByPath(params: {
  filePath: string;
  agentName: string;
}): Promise<void> {
  const { filePath, agentName } = params;

  const sessionFile = readSessionFile(filePath);
  if (!sessionFile) return;
  if (sessionFile.conversations.length === 0) {
    updateSummary(filePath, null, Date.now());
    return;
  }

  const summary = await generateSessionSummary({ sessionFile });
  updateSummary(filePath, summary, Date.now());

  logEvent("info", "session-summary-generated", {
    "agent-name": agentName,
    "session-id": sessionFile.sessionId,
    "summary-length": summary?.length ?? 0,
  });
}

/**
 * Summarize all active sessions (used on daemon stop).
 * Runs in parallel with a total timeout.
 */
export async function summarizeAllActiveSessions(params: {
  history: ConversationHistory;
  agentNames: string[];
  timeoutMs?: number;
}): Promise<void> {
  const { history, agentNames, timeoutMs = DEFAULT_SESSION_SUMMARY_TIMEOUT_MS } = params;

  if (agentNames.length === 0) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await Promise.allSettled(
      agentNames.map(async (agentName) => {
        if (controller.signal.aborted) return;
        try {
          await summarizeAndCloseSession({ history, agentName });
        } catch (err) {
          logEvent("warn", "session-summary-close-failed", {
            "agent-name": agentName,
            error: errorMessage(err),
          });
        }
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── CLI spawn ──

/**
 * Spawn `claude -p --model haiku` to generate a summary.
 * Returns the text output or null on failure.
 */
function spawnClaudeHaiku(prompt: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn("claude", ["-p", "--model", "haiku"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env as Record<string, string> },
      });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* best-effort */ }
      finish(null);
    }, timeoutMs);

    const stdoutChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stdin?.write(prompt);
    child.stdin?.end();

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      finish(stdout);
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}
