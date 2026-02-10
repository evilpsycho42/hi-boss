/**
 * Agent executor for running agent sessions with direct CLI invocation.
 */
import type { ChildProcess } from "node:child_process";
import type { Agent } from "./types.js";
import type { HiBossDatabase } from "../daemon/db/database.js";
import { getHiBossDir } from "./home-setup.js";
import { buildTurnInput } from "./turn-input.js";
import {
  parseSessionPolicyConfig,
} from "../shared/session-policy.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import {
  queueAgentTask,
  type AgentSession,
  type SessionRefreshRequest,
} from "./executor-support.js";
import { writePersistedAgentSession } from "./persisted-session.js";
import type { AgentRunTrigger } from "./executor-triggers.js";
import { getTriggerFields } from "./executor-triggers.js";
import { countDuePendingEnvelopesForAgent } from "./executor-db.js";
import { executeCliTurn } from "./executor-turn.js";
import { getOrCreateAgentSession } from "./executor-session.js";

/**
 * Maximum number of pending envelopes to process in a single turn.
 */
const MAX_ENVELOPES_PER_TURN = 10;

type InFlightAgentRun = {
  runRecordId: string;
  abortController: AbortController;
  childProcess: ChildProcess | null;
  abortReason?: string;
};

/**
 * Agent executor manages agent sessions and runs.
 */
export class AgentExecutor {
  private sessions: Map<string, AgentSession> = new Map();
  private agentLocks: Map<string, Promise<void>> = new Map();
  private inFlightRuns: Map<string, InFlightAgentRun> = new Map();
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
   */
  isAgentBusy(agentName: string): boolean {
    return this.agentLocks.has(agentName);
  }

  /**
   * Cancel the current in-flight run for an agent (best-effort).
   */
  abortCurrentRun(agentName: string, reason: string): boolean {
    const inFlight = this.inFlightRuns.get(agentName);
    if (!inFlight) return false;

    if (!inFlight.abortReason) {
      inFlight.abortReason = reason;
    }

    inFlight.abortController.abort();

    if (inFlight.childProcess) {
      try {
        if (inFlight.childProcess.pid) {
          process.kill(-inFlight.childProcess.pid, "SIGTERM");
        } else {
          inFlight.childProcess.kill("SIGTERM");
        }
      } catch {
        try { inFlight.childProcess.kill("SIGTERM"); } catch { /* best-effort */ }
      }
    }

    return true;
  }

  /**
   * Request a session refresh for an agent.
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

    const inFlight: InFlightAgentRun = {
      runRecordId: run.id,
      abortController: new AbortController(),
      childProcess: null,
    };
    this.inFlightRuns.set(agent.name, inFlight);

    try {
      if (inFlight.abortController.signal.aborted) {
        const reason = inFlight.abortReason ?? "abort-requested";
        db.cancelAgentRun(run.id, reason);
        logEvent("info", "agent-run-complete", {
          "agent-name": agent.name,
          "agent-run-id": run.id,
          state: "cancelled",
          "duration-ms": 0,
          "context-length": null,
          reason,
        });
        return envelopeIds.length;
      }

      // Get or create session
      const session = await this.getOrCreateSession(agent, db, trigger);

      // Build turn input
      const turnInput = buildTurnInput({
        context: {
          datetimeMs: Date.now(),
          agentName: agent.name,
          bossTimezone: db.getBossTimezone(),
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

      // Execute the turn via CLI
      const turn = await executeCliTurn(session, turnInput, {
        hibossDir: this.hibossDir,
        agentName: agent.name,
        signal: inFlight.abortController.signal,
        onChildProcess: (proc) => {
          inFlight.childProcess = proc;
        },
      });

      if (turn.status === "cancelled") {
        const reason = inFlight.abortReason ?? "run-cancelled";
        db.cancelAgentRun(run.id, reason);
        logEvent("info", "agent-run-complete", {
          "agent-name": agent.name,
          "agent-run-id": run.id,
          state: "cancelled",
          "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
          "context-length": null,
          reason,
        });
        return envelopeIds.length;
      }

      const response = turn.finalText;
      session.lastRunCompletedAtMs = Date.now();

      // Update session ID from CLI output (for resume on next turn).
      if (turn.sessionId) {
        session.sessionId = turn.sessionId;
      }

      // Persist session handle for best-effort resume after daemon restart.
      if (session.sessionId) {
        try {
          writePersistedAgentSession(db, agent.name, {
            version: 1,
            provider: session.provider,
            handle: {
              provider: session.provider,
              sessionId: session.sessionId,
              ...(session.provider === "codex" && session.codexCumulativeUsageTotals
                ? { metadata: { codexCumulativeUsage: session.codexCumulativeUsageTotals } }
                : {}),
            },
            createdAtMs: session.createdAtMs,
            lastRunCompletedAtMs: session.lastRunCompletedAtMs,
            updatedAtMs: Date.now(),
          });
        } catch (err) {
          logEvent("warn", "agent-session-snapshot-failed", {
            "agent-name": agent.name,
            error: errorMessage(err),
          });
        }
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
      const errMsg = error instanceof Error ? error.message : String(error);
      db.failAgentRun(run.id, errMsg);
      logEvent("info", "agent-run-complete", {
        "agent-name": agent.name,
        "agent-run-id": run.id,
        state: "failed",
        "duration-ms": runStartedAtMs ? Date.now() - runStartedAtMs : 0,
        "context-length": null,
        error: errMsg,
      });
      throw error;
    } finally {
      const existing = this.inFlightRuns.get(agent.name);
      if (existing && existing.runRecordId === run.id) {
        this.inFlightRuns.delete(agent.name);
      }
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
    return await getOrCreateAgentSession({
      agent,
      db,
      hibossDir: this.hibossDir,
      sessions: this.sessions,
      applyPendingSessionRefresh: (name) => this.applyPendingSessionRefresh(name),
      refreshSession: (name, reason) => this.refreshSession(name, reason),
      getSessionPolicy: (a) => this.getSessionPolicy(a),
      trigger,
    });
  }

  /**
   * Refresh session for an agent (called by /new command).
   *
   * Clears the existing session so a new one will be created on next run.
   */
  async refreshSession(agentName: string, reason?: string): Promise<void> {
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

    // For CLI-based sessions, there's no runtime/session to dispose — just clear the in-memory cache.
    this.sessions.delete(agentName);

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
    // Kill any in-flight CLI processes
    for (const [agentName, inFlight] of this.inFlightRuns) {
      if (inFlight.childProcess) {
        try {
          inFlight.childProcess.kill("SIGTERM");
        } catch {
          // best-effort
        }
      }
    }
    this.sessions.clear();
    this.agentLocks.clear();
    this.inFlightRuns.clear();
  }
}

export function createAgentExecutor(options?: {
  db?: HiBossDatabase;
  hibossDir?: string;
  onEnvelopesDone?: (envelopeIds: string[], db: HiBossDatabase) => void | Promise<void>;
}): AgentExecutor {
  return new AgentExecutor(options);
}
