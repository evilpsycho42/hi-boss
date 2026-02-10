/**
 * Session resume logic for CLI-based provider sessions.
 *
 * Determines whether to resume an existing session (by passing session/thread ID
 * to the CLI) or start fresh.
 */

import type { HiBossDatabase } from "../daemon/db/database.js";
import type { Agent } from "./types.js";
import type { AgentSession } from "./executor-support.js";
import { getRefreshReasonForPolicy } from "./executor-support.js";
import { readPersistedAgentSession, writePersistedAgentSession } from "./persisted-session.js";
import { logEvent } from "../shared/daemon-log.js";

export type OpenMode = "open" | "resume";

/**
 * Determine session open mode and resolve session ID for resume.
 *
 * For CLI-based sessions, "resume" means passing the session/thread ID
 * to the CLI (claude -r / codex exec resume). The actual CLI invocation
 * happens in executor-turn.ts.
 */
export function resolveSessionOpenMode(params: {
  agent: Agent;
  agentRecord: Agent;
  provider: "claude" | "codex";
  db: HiBossDatabase;
  policy: { dailyResetAt?: { hour: number; minute: number; normalized: string }; idleTimeoutMs?: number };
}): {
  sessionId?: string;
  createdAtMs: number;
  lastRunCompletedAtMs?: number;
  openMode: OpenMode;
  openReason: string;
} {
  let persisted = readPersistedAgentSession(params.agentRecord);
  let openMode: OpenMode = "open";
  let openReason = "no-session-handle";

  if (persisted && persisted.provider !== params.provider) {
    openReason = `persisted-provider-mismatch:${persisted.provider}!=${params.provider}`;
  }

  if (persisted) {
    const reason = getRefreshReasonForPolicy(
      { createdAtMs: persisted.createdAtMs, lastRunCompletedAtMs: persisted.lastRunCompletedAtMs } as AgentSession,
      params.policy,
      new Date()
    );
    if (reason) {
      openReason = `persisted-policy:${reason}`;
      writePersistedAgentSession(params.db, params.agent.name, null);
      persisted = null;
    }
  }

  let sessionId: string | undefined;
  if (persisted?.handle.sessionId && persisted.provider === params.provider) {
    sessionId = persisted.handle.sessionId;
    openMode = "resume";
    openReason = "resume";
  } else {
    if (persisted?.handle.sessionId && persisted.provider !== params.provider) {
      openReason = "session-handle-provider-mismatch";
    } else if (persisted && !persisted.handle.sessionId) {
      openReason = "missing-session-id";
    }
  }

  return {
    sessionId,
    createdAtMs: persisted?.createdAtMs ?? Date.now(),
    lastRunCompletedAtMs: persisted?.lastRunCompletedAtMs,
    openMode,
    openReason,
  };
}
