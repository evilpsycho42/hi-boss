/**
 * Session summary generation — runs a provider CLI one-shot prompt to summarize
 * a session's conversation on session end.
 *
 * Summary generation is best-effort: failures are logged and result in
 * a null summary. This never blocks session refresh or daemon stop.
 */

import type { SessionFile } from "./types.js";
import type { ConversationHistory } from "./conversation-history.js";
import { readSessionFile, updateSummary } from "./session-file-io.js";
import { executeOneShotPrompt } from "../../agent/oneshot-turn.js";
import { logEvent, errorMessage } from "../../shared/daemon-log.js";
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_SESSION_SUMMARY_TIMEOUT_MS,
  getDefaultRuntimeWorkspace,
} from "../../shared/defaults.js";

export interface SessionSummaryOptions {
  provider?: "claude" | "codex";
  workspace?: string;
  providerEnvOverrides?: Record<string, string>;
  model?: string;
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
}

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
  options?: SessionSummaryOptions;
}): Promise<string | null> {
  const { sessionFile, timeoutMs = DEFAULT_SESSION_SUMMARY_TIMEOUT_MS, options } = params;

  const conversationLines = sessionFile.events
    .filter((event) => event.type === "envelope-created")
    .map((event) => {
      const text = event.envelope.content.text?.trim();
      if (!text) return null;
      const sanitized = text.replace(/<[^>]+>/g, "");
      return `${event.envelope.from} -> ${event.envelope.to}: ${sanitized}`;
    })
    .filter((line): line is string => Boolean(line));

  if (conversationLines.length === 0) return null;

  const conversationText = conversationLines.join("\n");

  const prompt = SUMMARY_PROMPT.replace("{{CONVERSATIONS}}", conversationText);

  try {
    const result = await runSessionSummaryPrompt(prompt, timeoutMs, options);
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
  options?: SessionSummaryOptions;
}): Promise<void> {
  const { history, agentName, options } = params;
  const filePath = history.getCurrentSessionFilePath(agentName);
  if (!filePath) return;

  const sessionFile = readSessionFile(filePath);
  if (!sessionFile) return;
  if (sessionFile.events.length === 0) {
    // Close without summary for empty sessions.
    history.withFileLock(agentName, () => {
      updateSummary(filePath, null, Date.now());
    });
    history.clearActiveSession(agentName);
    return;
  }

  const summary = await generateSessionSummary({ sessionFile, options });
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
  options?: SessionSummaryOptions;
}): Promise<void> {
  const { filePath, agentName, options } = params;

  const sessionFile = readSessionFile(filePath);
  if (!sessionFile) return;
  if (sessionFile.events.length === 0) {
    updateSummary(filePath, null, Date.now());
    return;
  }

  const summary = await generateSessionSummary({ sessionFile, options });
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
  getSummaryOptions?: (agentName: string) => SessionSummaryOptions | undefined;
}): Promise<void> {
  const {
    history,
    agentNames,
    timeoutMs = DEFAULT_SESSION_SUMMARY_TIMEOUT_MS,
    getSummaryOptions,
  } = params;

  if (agentNames.length === 0) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await Promise.allSettled(
      agentNames.map(async (agentName) => {
        if (controller.signal.aborted) return;
        try {
          await summarizeAndCloseSession({
            history,
            agentName,
            options: getSummaryOptions?.(agentName),
          });
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

// ── Provider CLI spawn ──

/**
 * Run a one-shot provider prompt to generate a summary.
 * Returns the text output or null on failure.
 */
async function runSessionSummaryPrompt(
  prompt: string,
  timeoutMs: number,
  options?: SessionSummaryOptions
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await executeOneShotPrompt({
      provider: options?.provider ?? DEFAULT_AGENT_PROVIDER,
      workspace: options?.workspace ?? getDefaultRuntimeWorkspace(),
      prompt,
      envOverrides: options?.providerEnvOverrides,
      model: options?.model,
      reasoningEffort: options?.reasoningEffort,
      signal: controller.signal,
    });
    return result.finalText?.trim() || null;
  } finally {
    clearTimeout(timer);
  }
}
