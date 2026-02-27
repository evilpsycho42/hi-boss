/**
 * Session close helpers.
 *
 * Session close is intentionally summary-free. We only mark endedAtMs so
 * session lifecycle bookkeeping remains correct.
 */

import type { ConversationHistory } from "./conversation-history.js";
import { closeSessionFile } from "./session-file-io.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";

export function closeSessionByPath(params: {
  filePath: string;
  agentName: string;
  endedAtMs?: number;
}): void {
  const endedAtMs = params.endedAtMs ?? Date.now();
  closeSessionFile(params.filePath, endedAtMs);
  logEvent("info", "session-closed", {
    "agent-name": params.agentName,
    "file-path": params.filePath,
  });
}

export function closeActiveSession(params: {
  history: ConversationHistory;
  agentName: string;
  endedAtMs?: number;
}): void {
  const endedAtMs = params.endedAtMs ?? Date.now();
  const filePath = params.history.getCurrentSessionFilePath(params.agentName);
  if (filePath) {
    closeSessionFile(filePath, endedAtMs);
    logEvent("info", "session-closed", {
      "agent-name": params.agentName,
      "file-path": filePath,
    });
  }
  params.history.clearActiveSession(params.agentName);
}

export function closeAllActiveSessions(params: {
  history: ConversationHistory;
  agentNames: string[];
  endedAtMs?: number;
}): void {
  for (const agentName of params.agentNames) {
    try {
      closeActiveSession({
        history: params.history,
        agentName,
        endedAtMs: params.endedAtMs,
      });
    } catch (err) {
      logEvent("warn", "session-close-failed", {
        "agent-name": agentName,
        error: errorMessage(err),
      });
    }
  }
}
