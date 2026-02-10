/**
 * Agent session creation for CLI-based provider invocation.
 *
 * Creates AgentSession objects that hold the configuration needed to spawn
 * CLI processes (claude / codex) for each turn.
 */

import type { Agent } from "./types.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import { generateSystemInstructions } from "./instruction-generator.js";
import {
  DEFAULT_AGENT_PROVIDER,
} from "../shared/defaults.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import {
  getBossInfo,
  getRefreshReasonForPolicy,
  type AgentSession,
} from "./executor-support.js";
import { readPersistedAgentSession } from "./persisted-session.js";
import type { AgentRunTrigger } from "./executor-triggers.js";
import { getTriggerFields } from "./executor-triggers.js";
import { resolveSessionOpenMode } from "./session-resume.js";

type SessionPolicy = {
  dailyResetAt?: { hour: number; minute: number; normalized: string };
  idleTimeoutMs?: number;
  maxContextLength?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCodexCumulativeUsageTotals(value: unknown): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
} | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = value.inputTokens;
  const cachedInputTokens = value.cachedInputTokens;
  const outputTokens = value.outputTokens;
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens)) return undefined;
  if (typeof cachedInputTokens !== "number" || !Number.isFinite(cachedInputTokens)) return undefined;
  if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens)) return undefined;
  if (inputTokens < 0 || cachedInputTokens < 0 || outputTokens < 0) return undefined;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

export async function getOrCreateAgentSession(params: {
  agent: Agent;
  db: HiBossDatabase;
  hibossDir: string;
  sessions: Map<string, AgentSession>;
  applyPendingSessionRefresh: (agentName: string) => Promise<string[]>;
  refreshSession: (agentName: string, reason?: string) => Promise<void>;
  getSessionPolicy: (agent: Agent) => SessionPolicy;
  trigger?: AgentRunTrigger;
}): Promise<AgentSession> {
  // Apply any pending refresh request at the first safe point (before a run).
  const pendingRefreshReasons = await params.applyPendingSessionRefresh(params.agent.name);
  const triggerFields = getTriggerFields(params.trigger);

  let session = params.sessions.get(params.agent.name);
  let policyRefreshReason: string | null = null;

  // Apply policy-based refreshes before starting a new run.
  if (session) {
    const policy = params.getSessionPolicy(params.agent);
    const reason = getRefreshReasonForPolicy(session, policy, new Date());
    if (reason) {
      policyRefreshReason = reason;
      await params.refreshSession(params.agent.name);
      session = undefined;
    }
  }

  if (!session) {
    // Get agent token from database
    const agentRecord = params.db.getAgentByName(params.agent.name);
    if (!agentRecord) {
      throw new Error(`Agent ${params.agent.name} not found in database`);
    }

    const desiredProvider = params.agent.provider ?? DEFAULT_AGENT_PROVIDER;
    const persisted = readPersistedAgentSession(agentRecord);
    // If a resumable session handle exists, prefer its provider.
    const provider =
      persisted?.handle.sessionId && (persisted.provider === "claude" || persisted.provider === "codex")
        ? persisted.provider
        : desiredProvider;
    const workspace = params.agent.workspace ?? process.cwd();
    const codexCumulativeUsageTotals =
      provider === "codex"
        ? parseCodexCumulativeUsageTotals(persisted?.handle.metadata?.codexCumulativeUsage)
        : undefined;

    try {
      // Generate system instructions for inline injection
      const bindings = params.db.getBindingsByAgentName(params.agent.name);
      const boss = getBossInfo(params.db, bindings);
      const instructions = generateSystemInstructions({
        agent: params.agent,
        agentToken: agentRecord.token,
        bindings,
        bossTimezone: params.db.getBossTimezone(),
        hibossDir: params.hibossDir,
        boss,
      });

      // Resolve session open mode (fresh vs resume)
      const { sessionId, createdAtMs, lastRunCompletedAtMs, openMode, openReason } =
        resolveSessionOpenMode({
          agent: params.agent,
          agentRecord,
          provider,
          db: params.db,
          policy: params.getSessionPolicy(params.agent),
        });

      session = {
        provider,
        agentToken: agentRecord.token,
        systemInstructions: instructions,
        workspace,
        model: params.agent.model,
        reasoningEffort: params.agent.reasoningEffort,
        sessionId,
        createdAtMs,
        ...(codexCumulativeUsageTotals ? { codexCumulativeUsageTotals } : {}),
        ...(lastRunCompletedAtMs !== undefined ? { lastRunCompletedAtMs } : {}),
      };
      params.sessions.set(params.agent.name, session);

      const refreshReasons = [...pendingRefreshReasons, ...(policyRefreshReason ? [policyRefreshReason] : [])];
      const event = openMode === "resume" ? "agent-session-load" : "agent-session-create";
      logEvent("info", event, {
        "agent-name": params.agent.name,
        provider,
        ...(provider !== desiredProvider ? { "desired-provider": desiredProvider } : {}),
        state: "success",
        ...triggerFields,
        "open-mode": openMode,
        "open-reason": openReason,
        "refresh-reasons": refreshReasons.length > 0 ? refreshReasons.join(",") : undefined,
      });
    } catch (err) {
      const provider = params.agent.provider ?? DEFAULT_AGENT_PROVIDER;
      logEvent("info", "agent-session-create", {
        "agent-name": params.agent.name,
        provider,
        state: "failed",
        ...triggerFields,
        error: errorMessage(err),
      });
      throw err;
    }
  }

  return session;
}
