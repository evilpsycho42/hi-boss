import * as path from "node:path";
import { createRuntime } from "@unified-agent-sdk/runtime";
import type { Agent } from "./types.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import { getAgentHomePath, getAgentInternalSpaceDir } from "./home-setup.js";
import { generateSystemInstructions, writeInstructionFiles } from "./instruction-generator.js";
import { HIBOSS_TOKEN_ENV } from "../shared/env.js";
import {
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_DAEMON_DIRNAME,
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
import { openOrResumeUnifiedSession } from "./session-resume.js";
import { syncProviderSkillsForNewSession } from "./skills-sync.js";

type SessionPolicy = {
  dailyResetAt?: { hour: number; minute: number; normalized: string };
  idleTimeoutMs?: number;
  maxContextLength?: number;
};

export async function getOrCreateAgentSession(params: {
  agent: Agent;
  db: HiBossDatabase;
  hibossDir: string;
  sessions: Map<string, AgentSession>;
  applyPendingSessionRefresh: (agentName: string) => Promise<string[]>;
  refreshSession: (agentName: string, reason?: string) => Promise<void>;
  getSessionPolicy: (agent: Agent) => SessionPolicy;
  mapAccessLevel: (autoLevel: "medium" | "high") => "medium" | "high";
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
    // Experiment: if a resumable session handle exists, prefer its provider even if the agent's provider changed.
    const provider =
      persisted?.handle.sessionId && (persisted.provider === "claude" || persisted.provider === "codex")
        ? persisted.provider
        : desiredProvider;
    const homePath = getAgentHomePath(params.agent.name, provider, params.hibossDir);
    const workspace = params.agent.workspace ?? process.cwd();
    const internalSpaceDir = getAgentInternalSpaceDir(params.agent.name, params.hibossDir);
    const daemonDir = path.join(params.hibossDir, DEFAULT_DAEMON_DIRNAME);

    try {
      // Generate and write instruction files for new session
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

      const skillSync = syncProviderSkillsForNewSession({
        hibossDir: params.hibossDir,
        agentName: params.agent.name,
        provider,
        providerHomePath: homePath,
      });
      if (skillSync.warnings.length > 0) {
        logEvent("warn", "skills-sync-provider-warning", {
          "agent-name": params.agent.name,
          provider,
          warnings: skillSync.warnings,
        });
      }

      await writeInstructionFiles(params.agent.name, instructions, { hibossDir: params.hibossDir });

      // Create runtime with provider-specific configuration
      const defaultOpts: Record<string, unknown> = {
        workspace: { cwd: workspace, additionalDirs: [internalSpaceDir, daemonDir] },
        access: { auto: params.mapAccessLevel(params.agent.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL) },
      };
      if (params.agent.model !== undefined) {
        defaultOpts.model = params.agent.model;
      }
      if (params.agent.reasoningEffort !== undefined) {
        defaultOpts.reasoningEffort = params.agent.reasoningEffort;
      }

      const runtime =
        provider === "claude"
          ? createRuntime({
            provider: "@anthropic-ai/claude-agent-sdk",
            home: homePath,
            env: { [HIBOSS_TOKEN_ENV]: agentRecord.token },
            defaultOpts,
          })
          : createRuntime({
            provider: "@openai/codex-sdk",
            home: homePath,
            env: { [HIBOSS_TOKEN_ENV]: agentRecord.token },
            defaultOpts,
          });

      const openSessionOpts =
        provider === "claude"
          ? {
            config: {
              provider: {
                // Allow the agent to send envelopes via the Hi-Boss CLI without permission prompts.
                allowedTools: [
                  // Claude Code often permission-gates Bash at the command-prefix level (e.g. `git diff`).
                  // Hi-Boss replies are sent via `hiboss envelope send`, so allow the full prefix and a
                  // couple of best-effort fallbacks for prefix extractors that truncate.
                  "Bash(hiboss envelope send:*)",
                  "Bash(hiboss envelope:*)",
                  "Bash(hiboss:*)",
                ],
                // Only use project settings, not user settings from ~/.claude which may conflict
                // with the agent's CLAUDE_CONFIG_DIR settings (e.g., different ANTHROPIC_BASE_URL).
                settingSources: ["project", "user"],
              },
            },
          }
          : {};

      const { unifiedSession, createdAtMs, lastRunCompletedAtMs, openMode, openReason } =
        await openOrResumeUnifiedSession({
          agent: params.agent,
          agentRecord,
          provider,
          runtime,
          db: params.db,
          policy: params.getSessionPolicy(params.agent),
          openSessionOpts,
        });

      session = {
        runtime,
        session: unifiedSession,
        agentToken: agentRecord.token,
        provider,
        homePath,
        createdAtMs,
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
