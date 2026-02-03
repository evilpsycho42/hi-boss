import type { UnifiedAgentRuntime, UnifiedSession } from "@unified-agent-sdk/runtime";
import type { HiBossDatabase } from "../daemon/db/database.js";
import type { Agent } from "./types.js";
import type { AgentSession } from "./executor-support.js";
import { getRefreshReasonForPolicy } from "./executor-support.js";
import { readPersistedAgentSession, writePersistedAgentSession } from "./persisted-session.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";

export type OpenMode = "open" | "resume";

export async function openOrResumeUnifiedSession(params: {
  agent: Agent;
  agentRecord: Agent;
  provider: "claude" | "codex";
  runtime: UnifiedAgentRuntime<any, any>;
  db: HiBossDatabase;
  policy: { dailyResetAt?: { hour: number; minute: number; normalized: string }; idleTimeoutMs?: number };
  openSessionOpts: unknown;
}): Promise<{
  unifiedSession: UnifiedSession<any, any>;
  createdAtMs: number;
  lastRunCompletedAtMs?: number;
  openMode: OpenMode;
  openReason: string;
}> {
  let persisted = readPersistedAgentSession(params.agentRecord);
  let openMode: OpenMode = "open";
  let openReason = "no-session-handle";

  if (persisted && persisted.provider !== params.provider) {
    openReason = `persisted-provider-mismatch:${persisted.provider}!=${params.provider}`;
    // Experiment: do not clear the persisted handle when the agent provider changes.
    // This lets the legacy provider session remain resumable (best-effort) and keeps the handle stable.
  }

  if (persisted) {
    const reason = getRefreshReasonForPolicy(
      { createdAtMs: persisted.createdAtMs, lastRunCompletedAtMs: persisted.lastRunCompletedAtMs } as unknown as AgentSession,
      params.policy,
      new Date()
    );
    if (reason) {
      openReason = `persisted-policy:${reason}`;
      writePersistedAgentSession(params.db, params.agent.name, null);
      persisted = null;
    }
  }

  let unifiedSession: UnifiedSession<any, any>;
  if (persisted?.handle.sessionId && persisted.handle.provider === params.runtime.provider) {
    try {
      unifiedSession = await params.runtime.resumeSession(persisted.handle);
      openMode = "resume";
      openReason = "resume";
    } catch (err) {
      logEvent("warn", "agent-session-resume-failed", {
        "agent-name": params.agent.name,
        provider: params.provider,
        "session-id": persisted.handle.sessionId,
        error: errorMessage(err),
      });
      openReason = "resume-failed";
      writePersistedAgentSession(params.db, params.agent.name, null);
      persisted = null;
      unifiedSession = await params.runtime.openSession(params.openSessionOpts as any);
    }
  } else {
    if (persisted?.handle.sessionId && persisted.handle.provider !== params.runtime.provider) {
      openReason = "session-handle-provider-mismatch";
    } else if (persisted && !persisted.handle.sessionId) {
      openReason = "missing-session-id";
    }

    unifiedSession = await params.runtime.openSession(params.openSessionOpts as any);
  }

  return {
    unifiedSession,
    createdAtMs: persisted?.createdAtMs ?? Date.now(),
    lastRunCompletedAtMs: persisted?.lastRunCompletedAtMs,
    openMode,
    openReason,
  };
}
