/**
 * Agent executor for running agent sessions with the unified agent SDK.
 */
import { createRuntime } from "@unified-agent-sdk/runtime";
import type { Agent } from "./types.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import { getAgentHomePath, getAgentInternalSpaceDir, getHiBossDir } from "./home-setup.js";
import {
  generateSystemInstructions,
  writeInstructionFiles,
} from "./instruction-generator.js";
import { buildTurnInput } from "./turn-input.js";
import { HIBOSS_TOKEN_ENV } from "../shared/env.js";
import {
  parseSessionPolicyConfig,
} from "../shared/session-policy.js";
import {
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PROVIDER,
} from "../shared/defaults.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import {
  getBossInfo,
  getRefreshReasonForPolicy,
  queueAgentTask,
  type AgentSession,
  type SessionRefreshRequest,
  type TurnTokenUsage,
} from "./executor-support.js";
import { readPersistedAgentSession, writePersistedAgentSession } from "./persisted-session.js";
import type { AgentRunTrigger } from "./executor-triggers.js";
import { getTriggerFields } from "./executor-triggers.js";
import { openOrResumeUnifiedSession } from "./session-resume.js";
import { countDuePendingEnvelopesForAgent } from "./executor-db.js";
import { executeUnifiedTurn } from "./executor-turn.js";

/**
 * Maximum number of pending envelopes to process in a single turn.
 */
const MAX_ENVELOPES_PER_TURN = 10;

/**
 * Agent executor manages agent sessions and runs.
 */
export class AgentExecutor {
  private sessions: Map<string, AgentSession> = new Map();
  private agentLocks: Map<string, Promise<void>> = new Map();
  private pendingSessionRefresh: Map<string, SessionRefreshRequest> = new Map();
  private db: HiBossDatabase | null;
  private hibossDir: string;
  private onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;

  constructor(
    options: {
      db?: HiBossDatabase;
      hibossDir?: string;
      onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
    } = {}
  ) {
    this.db = options.db ?? null;
    this.hibossDir = options.hibossDir ?? getHiBossDir();
    this.onEnvelopesDone = options.onEnvelopesDone;
  }

  /**
   * True if the daemon currently has a queued or in-flight task for this agent.
   *
   * This is a busy-ness signal (used for operator UX); it is not persisted.
   */
  isAgentBusy(agentName: string): boolean {
    return this.agentLocks.has(agentName);
  }

  /**
   * Request a session refresh for an agent.
   *
   * Safe to call at any time (including during a run). The refresh will be applied
   * at the next safe point (before the next run, or after the current queue drains).
   *
   * Non-blocking: callers should not await this for interactive UX (e.g., Telegram /new).
   */
  requestSessionRefresh(agentName: string, reason: string): void {
    const existing = this.pendingSessionRefresh.get(agentName);
    if (existing) {
      existing.reasons.push(reason);
    } else {
      this.pendingSessionRefresh.set(agentName, {
        requestedAtMs: Date.now(),
        reasons: [reason],
      });
    }

    // Ensure the pending refresh gets applied even if no additional turns run.
    queueAgentTask({
      agentLocks: this.agentLocks,
      agentName,
      log: () => undefined,
      task: async () => {
        await this.applyPendingSessionRefresh(agentName);
      },
    }).catch((err) => {
      logEvent("error", "agent-session-remove-queue-failed", {
        "agent-name": agentName,
        error: errorMessage(err),
      });
    });
  }

  private getSessionPolicy(agent: Agent) {
    return parseSessionPolicyConfig(agent.sessionPolicy, { strict: false });
  }

  private getAndClearPendingRefreshReasons(agentName: string): string[] {
    const pending = this.pendingSessionRefresh.get(agentName);
    if (!pending) return [];
    this.pendingSessionRefresh.delete(agentName);
    return pending.reasons;
  }

  private async applyPendingSessionRefresh(agentName: string): Promise<string[]> {
    const reasons = this.getAndClearPendingRefreshReasons(agentName);
    if (reasons.length === 0) return [];
    await this.refreshSession(agentName, reasons.join(","));
    return reasons;
  }

  /**
   * Check and run agent if pending envelopes exist.
   *
   * Non-blocking with queue-safe atomic locks per agent.
   * If an agent is already running, waits for completion then runs.
   */
  async checkAndRun(agent: Agent, db: HiBossDatabase, trigger?: AgentRunTrigger): Promise<void> {
    const agentName = agent.name;

    await queueAgentTask({
      agentLocks: this.agentLocks,
      agentName,
      log: () => undefined,
      task: async () => {
        const acknowledged = await this.runAgent(agent, db, trigger);

        // Self-reschedule if more pending work exists
        if (acknowledged > 0) {
          const pending = db.getPendingEnvelopesForAgent(agent.name, 1);
          if (pending.length > 0) {
            setImmediate(() => {
              this.checkAndRun(agent, db, { kind: "reschedule" }).catch((err) => {
                logEvent("error", "agent-check-and-run-failed", {
                  "agent-name": agent.name,
                  ...getTriggerFields({ kind: "reschedule" }),
                  error: errorMessage(err),
                });
              });
            });
          }
        }
      },
    });
  }

  /**
   * Run the agent with pending envelopes.
   */
  private async runAgent(agent: Agent, db: HiBossDatabase, trigger?: AgentRunTrigger): Promise<number> {
    // Get pending envelopes
    const envelopes = db.getPendingEnvelopesForAgent(
      agent.name,
      MAX_ENVELOPES_PER_TURN
    );

    if (envelopes.length === 0) {
      return 0;
    }

    // Mark envelopes done immediately after read (at-most-once).
    const envelopeIds = envelopes.map((e) => e.id);
    db.markEnvelopesDone(envelopeIds);

    if (this.onEnvelopesDone) {
      try {
        await this.onEnvelopesDone(envelopeIds, db);
      } catch (err) {
        logEvent("error", "agent-on-envelopes-done-failed", {
          "agent-name": agent.name,
          error: errorMessage(err),
        });
      }
    }

    const pendingRemainingCount = countDuePendingEnvelopesForAgent(db, agent.name);

    // Create run record for auditing
    const run = db.createAgentRun(agent.name, envelopeIds);
    const triggerFields = getTriggerFields(trigger);
    let runStartedAtMs: number | null = null;

    try {
      // Get or create session
      const session = await this.getOrCreateSession(agent, db, trigger);

      // Build turn input
      const turnInput = buildTurnInput({
        context: {
          datetimeMs: Date.now(),
          agentName: agent.name,
        },
        envelopes,
      });

      logEvent("info", "agent-run-start", {
        "agent-name": agent.name,
        "agent-run-id": run.id,
        "envelopes-read-count": envelopeIds.length,
        "pending-remaining-count": pendingRemainingCount,
        ...triggerFields,
      });
      runStartedAtMs = Date.now();

      // Execute the turn
      const turn = await executeUnifiedTurn(session, turnInput);
      const response = turn.finalText;
      session.lastRunCompletedAtMs = Date.now();

      // Persist session handle for best-effort resume after daemon restart.
      try {
        const handle = await session.session.snapshot();
        if (handle.sessionId) {
          writePersistedAgentSession(db, agent.name, {
            version: 1,
            provider: session.provider,
            handle,
            createdAtMs: session.createdAtMs,
            lastRunCompletedAtMs: session.lastRunCompletedAtMs,
            updatedAtMs: Date.now(),
          });
        }
      } catch (err) {
        logEvent("warn", "agent-session-snapshot-failed", {
          "agent-name": agent.name,
          error: errorMessage(err),
        });
      }

      // Complete the run record
      db.completeAgentRun(run.id, response, turn.usage.contextLength);

      logEvent("info", "agent-run-complete", {
        "agent-name": agent.name,
        "agent-run-id": run.id,
        state: "success",
        "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
        "context-length": turn.usage.contextLength,
        "input-tokens": turn.usage.inputTokens,
        "output-tokens": turn.usage.outputTokens,
        "cache-read-tokens": turn.usage.cacheReadTokens,
        "cache-write-tokens": turn.usage.cacheWriteTokens,
        "total-tokens": turn.usage.totalTokens,
      });

      // Context-length refresh: if a run grew the context too large, reset the session for the next run.
      const policy = this.getSessionPolicy(agent);
      if (
        typeof policy.maxContextLength === "number" &&
        turn.usage.contextLength !== null &&
        turn.usage.contextLength > policy.maxContextLength
      ) {
        await this.refreshSession(
          agent.name,
          `max-context-length:${turn.usage.contextLength}>${policy.maxContextLength}`
        );
      }
      return envelopeIds.length;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      db.failAgentRun(run.id, errorMessage);
      logEvent("info", "agent-run-complete", {
        "agent-name": agent.name,
        "agent-run-id": run.id,
        state: "failed",
        "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
        "context-length": null,
        error: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Get or create a session for an agent.
   */
  private async getOrCreateSession(
    agent: Agent,
    db: HiBossDatabase,
    trigger?: AgentRunTrigger
  ): Promise<AgentSession> {
    // Apply any pending refresh request at the first safe point (before a run).
    const pendingRefreshReasons = await this.applyPendingSessionRefresh(agent.name);
    const triggerFields = getTriggerFields(trigger);

    let session = this.sessions.get(agent.name);
    let policyRefreshReason: string | null = null;

    // Apply policy-based refreshes before starting a new run.
    if (session) {
      const policy = this.getSessionPolicy(agent);
      const reason = getRefreshReasonForPolicy(session, policy, new Date());
      if (reason) {
        policyRefreshReason = reason;
        await this.refreshSession(agent.name);
        session = undefined;
      }
    }

    if (!session) {
      // Get agent token from database
      const agentRecord = db.getAgentByName(agent.name);
      if (!agentRecord) {
        throw new Error(`Agent ${agent.name} not found in database`);
      }

      const desiredProvider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
      const persisted = readPersistedAgentSession(agentRecord);
      // Experiment: if a resumable session handle exists, prefer its provider even if the agent's provider changed.
      const provider =
        persisted?.handle.sessionId && (persisted.provider === "claude" || persisted.provider === "codex")
          ? persisted.provider
          : desiredProvider;
      const homePath = getAgentHomePath(agent.name, provider, this.hibossDir);
      const workspace = agent.workspace ?? process.cwd();
      const internalSpaceDir = getAgentInternalSpaceDir(agent.name, this.hibossDir);

      try {
        // Generate and write instruction files for new session
        const bindings = db.getBindingsByAgentName(agent.name);
        const boss = getBossInfo(db, bindings);
        const instructions = generateSystemInstructions({
          agent,
          agentToken: agentRecord.token,
          bindings,
          hibossDir: this.hibossDir,
          boss,
        });
        await writeInstructionFiles(agent.name, instructions, { hibossDir: this.hibossDir });

        // Create runtime with provider-specific configuration
        const defaultOpts: Record<string, unknown> = {
          workspace: { cwd: workspace, additionalDirs: [internalSpaceDir, this.hibossDir] },
          access: { auto: this.mapAccessLevel(agent.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL) },
        };
        if (agent.model !== undefined) {
          defaultOpts.model = agent.model;
        }
        if (agent.reasoningEffort !== undefined) {
          defaultOpts.reasoningEffort = agent.reasoningEffort;
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
            agent,
            agentRecord,
            provider,
            runtime,
            db,
            policy: this.getSessionPolicy(agent),
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
        this.sessions.set(agent.name, session);

        const refreshReasons = [...pendingRefreshReasons, ...(policyRefreshReason ? [policyRefreshReason] : [])];
        const event = openMode === "resume" ? "agent-session-load" : "agent-session-create";
        logEvent("info", event, {
          "agent-name": agent.name,
          provider,
          ...(provider !== desiredProvider ? { "desired-provider": desiredProvider } : {}),
          state: "success",
          ...triggerFields,
          "open-mode": openMode,
          "open-reason": openReason,
          "refresh-reasons": refreshReasons.length > 0 ? refreshReasons.join(",") : undefined,
        });
      } catch (err) {
        const provider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
        logEvent("info", "agent-session-create", {
          "agent-name": agent.name,
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

  /**
   * Map auto level to SDK access level.
   */
  private mapAccessLevel(autoLevel: "medium" | "high"): "medium" | "high" {
    // Direct mapping - SDK uses same values
    return autoLevel;
  }

  /**
   * Refresh session for an agent (called by /new command).
   *
   * Clears the existing session so a new one will be created on next run.
   */
  async refreshSession(agentName: string, reason?: string): Promise<void> {
    // If a refresh is requested (or just happened), clear any pending flags to avoid duplicate refreshes.
    this.pendingSessionRefresh.delete(agentName);

    if (this.db) {
      try {
        writePersistedAgentSession(this.db, agentName, null);
      } catch (err) {
        logEvent("warn", "agent-session-handle-clear-failed", {
          "agent-name": agentName,
          reason,
          error: errorMessage(err),
        });
      }
    }

    const session = this.sessions.get(agentName);
    if (session) {
      // Dispose session and close runtime
      await session.session.dispose();
      await session.runtime.close();
      this.sessions.delete(agentName);
    }

    logEvent("info", "agent-session-remove", {
      "agent-name": agentName,
      reason,
      state: "success",
    });
  }

  /**
   * Close all sessions on shutdown.
   */
  async closeAll(): Promise<void> {
    for (const [agentName, session] of this.sessions) {
      await session.session.dispose();
      await session.runtime.close();
    }
    this.sessions.clear();
    this.agentLocks.clear();
  }
}

export function createAgentExecutor(options?: {
  db?: HiBossDatabase;
  hibossDir?: string;
  onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
}): AgentExecutor {
  return new AgentExecutor(options);
}
