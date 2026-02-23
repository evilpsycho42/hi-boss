/**
 * One-shot executor for /clone and /isolated envelope execution.
 *
 * Runs envelopes independently of the main agent session queue:
 * - Full agent identity (HIBOSS_TOKEN, system instructions, Hi-Boss tools)
 * - Does NOT block or pollute the main session
 * - Concurrent execution (configurable max, default 4)
 * - Results routed back to the originating channel
 */

import type { HiBossDatabase } from "../daemon/db/database.js";
import type { MessageRouter } from "../daemon/router/message-router.js";
import type { Envelope, OneshotType } from "../envelope/types.js";
import type { Agent } from "./types.js";
import type { AgentSession } from "./executor-support.js";
import { getBossInfo } from "./executor-support.js";
import { generateSystemInstructions } from "./instruction-generator.js";
import { buildTurnInput } from "./turn-input.js";
import { executeCliTurn } from "./executor-turn.js";
import { readPersistedAgentSession } from "./persisted-session.js";
import { cloneSessionFile, cleanupClonedSession, type ClonedSession } from "./session-clone.js";
import { formatAgentAddress } from "../adapters/types.js";
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_ONESHOT_MAX_CONCURRENT,
  getDefaultRuntimeWorkspace,
} from "../shared/defaults.js";
import { errorMessage, logEvent } from "../shared/daemon-log.js";
import { getHiBossDir } from "./home-setup.js";
import { resolveUiLocale } from "../shared/ui-locale.js";
import { getUiText } from "../shared/ui-text.js";

interface OneShotJob {
  envelope: Envelope;
  agent: Agent;
  mode: OneshotType;
}

export class OneShotExecutor {
  private readonly maxConcurrent: number;
  private readonly queue: OneShotJob[] = [];
  private inFlight = 0;

  constructor(
    private readonly deps: {
      db: HiBossDatabase;
      router: MessageRouter;
      hibossDir: string;
      onEnvelopeDone?: (envelope: Envelope) => void;
    },
    options: { maxConcurrent?: number } = {},
  ) {
    const raw = options.maxConcurrent ?? DEFAULT_ONESHOT_MAX_CONCURRENT;
    const n = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_ONESHOT_MAX_CONCURRENT;
    this.maxConcurrent = Math.max(1, Math.min(32, n));
  }

  /**
   * Enqueue a one-shot envelope for execution.
   *
   * The envelope is ACKed immediately (marked `done`) so it doesn't re-trigger
   * the main agent queue.
   */
  enqueue(envelope: Envelope, agent: Agent, mode: OneshotType): void {
    try {
      this.deps.db.updateEnvelopeStatus(envelope.id, "done");
    } catch (err) {
      logEvent("error", "oneshot-envelope-ack-failed", {
        "envelope-id": envelope.id,
        error: errorMessage(err),
      });
      // If ACK fails the envelope stays "pending" — don't enqueue the job
      // to avoid double execution on daemon restart.
      return;
    }

    // Notify cron scheduler so it can advance to the next occurrence.
    if (this.deps.onEnvelopeDone) {
      try {
        this.deps.onEnvelopeDone(envelope);
      } catch (err) {
        logEvent("error", "oneshot-on-envelope-done-failed", {
          "envelope-id": envelope.id,
          error: errorMessage(err),
        });
      }
    }

    this.queue.push({ envelope, agent, mode });
    this.drain();
  }

  private drain(): void {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.inFlight++;
      void this.runOne(job)
        .catch((err) => {
          logEvent("error", "oneshot-job-failed", {
            "envelope-id": job.envelope.id,
            "agent-name": job.agent.name,
            mode: job.mode,
            error: errorMessage(err),
          });
        })
        .finally(() => {
          this.inFlight--;
          this.drain();
        });
    }
  }

  private async runOne(job: OneShotJob): Promise<void> {
    const { envelope, agent, mode } = job;
    const startedAtMs = Date.now();
    const ui = getUiText(resolveUiLocale(this.deps.db.getConfig("ui_locale")));
    let clone: ClonedSession | null = null;
    let effectiveMode = mode;

    logEvent("info", "oneshot-job-start", {
      "envelope-id": envelope.id,
      "agent-name": agent.name,
      mode,
      from: envelope.from,
      to: envelope.to,
    });

    try {
      // For clone mode: attempt to clone the session file.
      let cloneSessionId: string | undefined;
      if (mode === "clone") {
        clone = await this.tryCloneSession(agent);
        if (clone) {
          cloneSessionId = clone.clonedSessionId;
        } else {
          // No session to clone — fall back to isolated.
          effectiveMode = "isolated";
          logEvent("info", "oneshot-clone-fallback-isolated", {
            "envelope-id": envelope.id,
            "agent-name": agent.name,
          });
        }
      }

      // Build an ephemeral session (not stored in executor.sessions)
      const session = this.buildEphemeralSession(agent, cloneSessionId);

      // Build turn input from the single envelope
      const turnInput = buildTurnInput({
        context: {
          datetimeMs: Date.now(),
          agentName: agent.name,
          bossTimezone: this.deps.db.getBossTimezone(),
        },
        envelopes: [envelope],
      });

      let finalText: string;
      try {
        const turn = await executeCliTurn(session, turnInput, {
          hibossDir: this.deps.hibossDir,
          agentName: agent.name,
        });

        finalText = turn.finalText?.trim() ? turn.finalText.trim() : ui.channel.emptyAssistantReply;

        logEvent("info", "oneshot-job-complete", {
          "envelope-id": envelope.id,
          "agent-name": agent.name,
          mode: effectiveMode,
          state: "success",
          "duration-ms": Date.now() - startedAtMs,
          "context-length": turn.usage.contextLength,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finalText = ui.channel.oneShotExecutionFailed(effectiveMode);

        logEvent("info", "oneshot-job-complete", {
          "envelope-id": envelope.id,
          "agent-name": agent.name,
          mode: effectiveMode,
          state: "failed",
          "duration-ms": Date.now() - startedAtMs,
          error: msg,
        });
      }

      // NOTE: Do NOT persist session handle — one-shot sessions are ephemeral.
      // NOTE: Do NOT append to conversation history — one-shot doesn't pollute main context.

      // Route response back to the originating address.
      // For cron one-shot: metadata.cronResponseTo overrides the default reply-to.
      const md = envelope.metadata as Record<string, unknown> | undefined;
      const cronResponseTo = typeof md?.cronResponseTo === "string" ? md.cronResponseTo : null;
      const replyTo = cronResponseTo ?? envelope.from;

      await this.deps.router.routeEnvelope({
        from: formatAgentAddress(agent.name),
        to: replyTo,
        fromBoss: false,
        content: { text: finalText },
        metadata: {
          ...(cronResponseTo ? {} : { replyToEnvelopeId: envelope.id }),
          oneshotResponse: true,
          oneshotMode: effectiveMode,
        },
      });
    } finally {
      // Always clean up cloned session files.
      if (clone) {
        await cleanupClonedSession(clone);
      }
    }
  }

  /**
   * Attempt to clone the current session for an agent.
   *
   * Returns the cloned session info, or null if no session exists to clone.
   */
  private async tryCloneSession(agent: Agent): Promise<ClonedSession | null> {
    const agentRecord = this.deps.db.getAgentByName(agent.name);
    if (!agentRecord) return null;

    const persisted = readPersistedAgentSession(agentRecord);
    if (!persisted?.handle.sessionId) return null;

    const provider = persisted.provider;
    const sessionId = persisted.handle.sessionId;

    try {
      return await cloneSessionFile({ provider, sessionId });
    } catch (err) {
      logEvent("warn", "oneshot-clone-failed", {
        "agent-name": agent.name,
        provider,
        "session-id": sessionId,
        error: errorMessage(err),
      });
      return null;
    }
  }

  /**
   * Build an ephemeral AgentSession for a one-shot run.
   *
   * @param sessionId If provided (clone mode), the CLI will resume from this session ID.
   */
  private buildEphemeralSession(agent: Agent, sessionId?: string): AgentSession {
    const agentRecord = this.deps.db.getAgentByName(agent.name);
    if (!agentRecord) {
      throw new Error(`Agent ${agent.name} not found in database`);
    }

    const provider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
    const workspace = agent.workspace ?? getDefaultRuntimeWorkspace();

    const bindings = this.deps.db.getBindingsByAgentName(agent.name);
    const boss = getBossInfo(this.deps.db, bindings);
    const instructions = generateSystemInstructions({
      agent,
      agentToken: agentRecord.token,
      bindings,
      bossTimezone: this.deps.db.getBossTimezone(),
      hibossDir: this.deps.hibossDir,
      boss,
    });

    return {
      provider,
      agentToken: agentRecord.token,
      systemInstructions: instructions,
      workspace,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      sessionId,
      createdAtMs: Date.now(),
    };
  }
}

export function createOneShotExecutor(params: {
  db: HiBossDatabase;
  router: MessageRouter;
  hibossDir?: string;
  maxConcurrent?: number;
  onEnvelopeDone?: (envelope: Envelope) => void;
}): OneShotExecutor {
  return new OneShotExecutor(
    {
      db: params.db,
      router: params.router,
      hibossDir: params.hibossDir ?? getHiBossDir(),
      onEnvelopeDone: params.onEnvelopeDone,
    },
    { maxConcurrent: params.maxConcurrent },
  );
}
