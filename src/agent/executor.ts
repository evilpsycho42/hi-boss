/**
 * Agent executor for running agent sessions with the unified agent SDK.
 *
 * Features:
 * - Atomic per-agent queue locks (no concurrent runs for same agent)
 * - Session persistence (reuses sessions until refresh)
 * - Auto-ack of processed envelopes
 * - Auditing via agent_runs table
 */

import {
  createRuntime,
  type UnifiedAgentRuntime,
  type UnifiedSession,
} from "@unified-agent-sdk/runtime";
import type { Agent } from "./types.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import { getAgentHomePath, getAgentInternalSpaceDir, getHiBossDir } from "./home-setup.js";
import {
  generateSystemInstructions,
  writeInstructionFiles,
} from "./instruction-generator.js";
import { buildTurnInput } from "./turn-input.js";
import { HIBOSS_TOKEN_ENV } from "../shared/env.js";
import { computeTokensUsed, parseSessionPolicyConfig } from "../shared/session-policy.js";
import { nowLocalIso } from "../shared/time.js";
import { red } from "../shared/ansi.js";
import {
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_REASONING_EFFORT,
} from "../shared/defaults.js";

/**
 * Maximum number of pending envelopes to process in a single turn.
 */
const MAX_ENVELOPES_PER_TURN = 10;

/**
 * Session state for an agent.
 */
interface AgentSession {
  runtime: UnifiedAgentRuntime<any, any>;
  session: UnifiedSession<any, any>;
  agentToken: string;
  provider: "claude" | "codex";
  createdAtMs: number;
  lastRunCompletedAtMs?: number;
}

interface SessionRefreshRequest {
  requestedAtMs: number;
  reasons: string[];
}

type TurnTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTokenUsage(usageRaw: unknown): TurnTokenUsage {
  const usage = (usageRaw ?? {}) as Record<string, unknown>;
  const inputTokens = asFiniteNumber(usage.input_tokens);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  const cacheReadTokens = asFiniteNumber(usage.cache_read_tokens);
  const cacheWriteTokens = asFiniteNumber(usage.cache_write_tokens);
  const totalTokens =
    asFiniteNumber(usage.total_tokens) ??
    (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

function readTotalUsageMaybe(result: unknown): unknown | undefined {
  const rec = result as Record<string, unknown> | null;
  if (!rec || typeof rec !== "object") return undefined;
  const totalUsage = rec["total_usage"];
  if (!totalUsage || typeof totalUsage !== "object") return undefined;
  return totalUsage;
}

/**
 * Agent executor manages agent sessions and runs.
 */
export class AgentExecutor {
  private sessions: Map<string, AgentSession> = new Map();
  private agentLocks: Map<string, Promise<void>> = new Map();
  private pendingSessionRefresh: Map<string, SessionRefreshRequest> = new Map();
  private debug: boolean;
  private db: HiBossDatabase | null;
  private hibossDir: string;
  private onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;

  constructor(
    options: {
      debug?: boolean;
      db?: HiBossDatabase;
      hibossDir?: string;
      onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
    } = {}
  ) {
    this.debug = options.debug ?? false;
    this.db = options.db ?? null;
    this.hibossDir = options.hibossDir ?? getHiBossDir();
    this.onEnvelopesDone = options.onEnvelopesDone;
  }

  /**
   * Log debug messages.
   */
  private log(message: string, options?: { color?: "red" }): void {
    if (this.debug) {
      const line = `[${nowLocalIso()}] [AgentExecutor] ${message}`;
      if (options?.color === "red") {
        console.log(red(line));
      } else {
        console.log(line);
      }
    }
  }

  /**
   * Fetch boss info from the database.
   */
  private getBossInfo(bindings: { adapterType: string }[]): { name?: string; adapterIds?: Record<string, string> } | undefined {
    if (!this.db) return undefined;

    const name = this.db.getBossName() ?? undefined;
    const adapterIds: Record<string, string> = {};

    // Get boss ID for each bound adapter type
    for (const binding of bindings) {
      const bossId = this.db.getAdapterBossId(binding.adapterType);
      if (bossId) {
        adapterIds[binding.adapterType] = bossId;
      }
    }

    return { name, adapterIds };
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
    this.queueAgentTask(agentName, async () => {
      await this.applyPendingSessionRefresh(agentName);
    }).catch((err) => {
      console.error(`[AgentExecutor] queued refresh failed for ${agentName}:`, err);
    });
  }

  private async queueAgentTask(agentName: string, task: () => Promise<void>): Promise<void> {
    const existingTail = this.agentLocks.get(agentName);
    if (existingTail) {
      this.log(`Queued task behind existing run of ${agentName}`);
    }

    const previous = (existingTail ?? Promise.resolve()).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Previous task/run of ${agentName} failed; continuing queue: ${message}`);
    });

    let current: Promise<void>;
    current = previous
      .then(task)
      .finally(() => {
        if (this.agentLocks.get(agentName) === current) {
          this.agentLocks.delete(agentName);
        }
      });

    this.agentLocks.set(agentName, current);
    return current;
  }

  private getSessionPolicy(agent: Agent) {
    return parseSessionPolicyConfig(agent.sessionPolicy, { strict: false });
  }

  private getMostRecentDailyResetBoundaryMs(
    now: Date,
    dailyResetAt: { hour: number; minute: number }
  ): number {
    const candidate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      dailyResetAt.hour,
      dailyResetAt.minute,
      0,
      0
    );

    if (now.getTime() >= candidate.getTime()) {
      return candidate.getTime();
    }

    // Use yesterday's reset time.
    candidate.setDate(candidate.getDate() - 1);
    return candidate.getTime();
  }

  private getRefreshReasonForPolicy(
    session: AgentSession,
    policy: ReturnType<AgentExecutor["getSessionPolicy"]>,
    now: Date
  ): string | null {
    if (policy.dailyResetAt) {
      const boundaryMs = this.getMostRecentDailyResetBoundaryMs(now, policy.dailyResetAt);
      if (session.createdAtMs < boundaryMs) {
        return `daily-reset-at:${policy.dailyResetAt.normalized}`;
      }
    }

    if (typeof policy.idleTimeoutMs === "number") {
      const lastActiveMs = session.lastRunCompletedAtMs ?? session.createdAtMs;
      if (now.getTime() - lastActiveMs > policy.idleTimeoutMs) {
        return `idle-timeout-ms:${policy.idleTimeoutMs}`;
      }
    }

    return null;
  }

  private getAndClearPendingRefreshReasons(agentName: string): string[] {
    const pending = this.pendingSessionRefresh.get(agentName);
    if (!pending) return [];
    this.pendingSessionRefresh.delete(agentName);
    return pending.reasons;
  }

  private async applyPendingSessionRefresh(agentName: string): Promise<void> {
    const reasons = this.getAndClearPendingRefreshReasons(agentName);
    if (reasons.length === 0) return;

    this.log(
      `Applying pending session refresh for ${agentName} reason=${reasons.join(",")}`,
      { color: "red" }
    );
    await this.refreshSession(agentName);

    // Log the system prompt that will be used for the new session
    if (this.debug && this.db) {
      const agentRecord = this.db.getAgentByName(agentName);
      if (agentRecord) {
        const bindings = this.db.getBindingsByAgentName(agentName);
        const boss = this.getBossInfo(bindings);
        const instructions = generateSystemInstructions({
          agent: agentRecord,
          agentToken: agentRecord.token,
          bindings,
          hibossDir: this.hibossDir,
          boss,
        });
        await writeInstructionFiles(agentName, instructions, { debug: true, hibossDir: this.hibossDir });
      }
    }
  }

  /**
   * Check and run agent if pending envelopes exist.
   *
   * Non-blocking with queue-safe atomic locks per agent.
   * If an agent is already running, waits for completion then runs.
   */
  async checkAndRun(agent: Agent, db: HiBossDatabase): Promise<void> {
    const agentName = agent.name;
    console.log(`[${nowLocalIso()}] [AgentExecutor] checkAndRun called for ${agentName}`);

    await this.queueAgentTask(agentName, async () => {
      const acknowledged = await this.runAgent(agent, db);

      // Self-reschedule if more pending work exists
      if (acknowledged > 0) {
        const pending = db.getPendingEnvelopesForAgent(agent.name, 1);
        if (pending.length > 0) {
          this.log(`More pending envelopes for ${agent.name}, rescheduling`);
          setImmediate(() => {
            this.checkAndRun(agent, db).catch((err) => {
              this.log(`Rescheduled run failed for ${agent.name}: ${err}`);
            });
          });
        }
      }
    });
  }

  /**
   * Run the agent with pending envelopes.
   */
  private async runAgent(agent: Agent, db: HiBossDatabase): Promise<number> {
    // Get pending envelopes
    const envelopes = db.getPendingEnvelopesForAgent(
      agent.name,
      MAX_ENVELOPES_PER_TURN
    );

    if (envelopes.length === 0) {
      this.log(`No pending envelopes for ${agent.name}`);
      return 0;
    }

    this.log(`Running ${agent.name} with ${envelopes.length} envelope(s)`);

    // Create run record for auditing
    const envelopeIds = envelopes.map((e) => e.id);
    const run = db.createAgentRun(agent.name, envelopeIds);

    try {
      // Get or create session
      const session = await this.getOrCreateSession(agent, db);

      // Build turn input
      const turnInput = buildTurnInput({
        context: {
          datetime: new Date().toISOString(),
          agentName: agent.name,
        },
        envelopes,
      });

      // Execute the turn
      const turn = await this.executeTurn(session, turnInput);
      const response = turn.finalText;
      session.lastRunCompletedAtMs = Date.now();

      // Auto-ack all processed envelopes after successful run
      db.markEnvelopesDone(envelopeIds);

      if (this.onEnvelopesDone) {
        try {
          await this.onEnvelopesDone(envelopeIds, db);
        } catch (err) {
          console.error(`[AgentExecutor] onEnvelopesDone failed for ${agent.name}:`, err);
        }
      }

      // Complete the run record
      db.completeAgentRun(run.id, response);

      // Token-based refresh: if a run consumed too many tokens, reset the session for the next run.
      const policy = this.getSessionPolicy(agent);
      if (
        typeof policy.maxTokens === "number" &&
        turn.tokensUsed !== null &&
        turn.tokensUsed > policy.maxTokens
      ) {
        this.log(
          `Refreshing session for ${agent.name} tokens-used=${turn.tokensUsed} max-tokens=${policy.maxTokens}`,
          { color: "red" }
        );
        await this.refreshSession(agent.name);
      }

      this.log(`Completed run for ${agent.name}`);
      return envelopeIds.length;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      db.failAgentRun(run.id, errorMessage);
      this.log(`Failed run for ${agent.name}: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Get or create a session for an agent.
   */
  private async getOrCreateSession(
    agent: Agent,
    db: HiBossDatabase
  ): Promise<AgentSession> {
    // Apply any pending refresh request at the first safe point (before a run).
    await this.applyPendingSessionRefresh(agent.name);

    let session = this.sessions.get(agent.name);

    // Apply policy-based refreshes before starting a new run.
    if (session) {
      const policy = this.getSessionPolicy(agent);
      const reason = this.getRefreshReasonForPolicy(session, policy, new Date());
      if (reason) {
        this.log(`Refreshing session for ${agent.name} policy=${reason}`, { color: "red" });
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

      const provider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
      const homePath = getAgentHomePath(agent.name, provider, this.hibossDir);
      const workspace = agent.workspace ?? process.cwd();
      const internalSpaceDir = getAgentInternalSpaceDir(agent.name, this.hibossDir);

      // Generate and write instruction files for new session
      const bindings = db.getBindingsByAgentName(agent.name);
      const boss = this.getBossInfo(bindings);
      const instructions = generateSystemInstructions({
        agent,
        agentToken: agentRecord.token,
        bindings,
        hibossDir: this.hibossDir,
        boss,
      });
      await writeInstructionFiles(agent.name, instructions, { debug: this.debug, hibossDir: this.hibossDir });

      // Create runtime with provider-specific configuration
      const defaultOpts = {
        workspace: { cwd: workspace, additionalDirs: [internalSpaceDir, this.hibossDir] },
        access: { auto: this.mapAccessLevel(agent.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL) },
        model: agent.model,
        reasoningEffort: agent.reasoningEffort ?? DEFAULT_AGENT_REASONING_EFFORT,
      };

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

      // Open a session (instructions are loaded from home directory files)
      const unifiedSession = await runtime.openSession(
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
              },
            },
          }
          : {}
      );

      session = {
        runtime,
        session: unifiedSession,
        agentToken: agentRecord.token,
        provider,
        createdAtMs: Date.now(),
      };
      this.sessions.set(agent.name, session);

      this.log(`Created new session for ${agent.name} with provider ${provider}`, { color: "red" });
    }

    return session;
  }

  /**
   * Execute a turn using the agent SDK.
   */
  private async executeTurn(
    session: AgentSession,
    turnInput: string
  ): Promise<{ finalText: string; tokensUsed: number | null }> {
    this.log(`Executing turn with ${session.provider} provider`);

    // Debug: display turn input
    if (this.debug) {
      console.log(`[${nowLocalIso()}] Turn input:`);
      console.log("─".repeat(60));
      console.log(turnInput);
      console.log("─".repeat(60));
    }

    const runHandle = await session.session.run({
      input: { parts: [{ type: "text", text: turnInput }] },
    });

    // Drain events silently (required for run completion)
    for await (const _ of runHandle.events) {
      // Events must be consumed for the run to complete
    }

    const result = await runHandle.result;
    this.log("Run completed");

    if (result.status !== "success") {
      throw new Error(`Agent run ${result.status}`);
    }

    if (this.debug) {
      const u = readTokenUsage(result.usage);
      const totalUsage = readTotalUsageMaybe(result);
      const tu = totalUsage ? readTokenUsage(totalUsage) : u;
      const totalUsageSuffix =
        totalUsage && tu.totalTokens !== null && tu.totalTokens !== u.totalTokens
          ? ` total-usage=${tu.totalTokens}`
          : "";

      this.log(
        `Token usage input=${u.inputTokens ?? "n/a"} output=${u.outputTokens ?? "n/a"} cache-read=${u.cacheReadTokens ?? "n/a"} cache-write=${u.cacheWriteTokens ?? "n/a"} total=${u.totalTokens ?? "n/a"}${totalUsageSuffix}`
      );
    }

    const tokensUsed = computeTokensUsed((readTotalUsageMaybe(result) as any) ?? result.usage);
    return { finalText: result.finalText ?? "", tokensUsed };
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
  async refreshSession(agentName: string): Promise<void> {
    // If a refresh is requested (or just happened), clear any pending flags to avoid duplicate refreshes.
    this.pendingSessionRefresh.delete(agentName);

    const session = this.sessions.get(agentName);
    if (session) {
      // Dispose session and close runtime
      await session.session.dispose();
      await session.runtime.close();
      this.sessions.delete(agentName);
      this.log(`Refreshed session for ${agentName}`, { color: "red" });
    }
  }

  /**
   * Close all sessions on shutdown.
   */
  async closeAll(): Promise<void> {
    for (const [agentName, session] of this.sessions) {
      await session.session.dispose();
      await session.runtime.close();
      this.log(`Closed session for ${agentName}`);
    }
    this.sessions.clear();
    this.agentLocks.clear();
  }
}

/**
 * Create a new agent executor instance.
 */
export function createAgentExecutor(options?: {
  debug?: boolean;
  db?: HiBossDatabase;
  hibossDir?: string;
  onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
}): AgentExecutor {
  return new AgentExecutor(options);
}
