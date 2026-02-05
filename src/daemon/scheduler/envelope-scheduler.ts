import type { Envelope } from "../../envelope/types.js";
import type { HiBossDatabase } from "../db/database.js";
import type { MessageRouter } from "../router/message-router.js";
import type { AgentExecutor } from "../../agent/executor.js";
import { delayUntilUnixMs } from "../../shared/time.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout max (~24.8 days)
const MAX_CHANNEL_ENVELOPES_PER_TICK = 100;
const ORPHAN_AGENT_ENVELOPES_BATCH_SIZE = 100;
const MAX_ORPHAN_AGENT_ENVELOPES_PER_TICK = 2000;

export class EnvelopeScheduler {
  private nextWakeTimer: NodeJS.Timeout | null = null;
  private running = false;
  private tickInProgress = false;
  private tickQueued = false;

  constructor(
    private readonly db: HiBossDatabase,
    private readonly router: MessageRouter,
    private readonly executor: AgentExecutor
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick("startup");
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  onEnvelopeCreated(_envelope: Envelope): void {
    // Recalculate the next wake time; delivery itself is handled by the router
    // (immediate) or by scheduler ticks (future).
    this.scheduleNextWake();
  }

  private clearTimer(): void {
    if (this.nextWakeTimer) {
      clearTimeout(this.nextWakeTimer);
      this.nextWakeTimer = null;
    }
  }

  private tick(reason: string): Promise<void> {
    if (!this.running) return Promise.resolve();

    if (this.tickInProgress) {
      this.tickQueued = true;
      return Promise.resolve();
    }

    return this.runTick(reason);
  }

  private async runTick(reason: string): Promise<void> {
    this.tickInProgress = true;
    this.tickQueued = false;

    try {
      // 1) Deliver due channel envelopes (scheduled delivery).
      const dueChannel = this.db.listDueChannelEnvelopes(MAX_CHANNEL_ENVELOPES_PER_TICK);
      for (const env of dueChannel) {
        try {
          await this.router.deliverEnvelope(env);
        } catch (err) {
          logEvent("error", "scheduler-channel-delivery-failed", {
            "envelope-id": env.id,
            error: errorMessage(err),
          });
        }
      }

      // 2) Trigger agents that have due envelopes.
      const agentNames = this.db.listAgentNamesWithDueEnvelopes();
      for (const agentName of agentNames) {
        const agent = this.db.getAgentByNameCaseInsensitive(agentName);
        if (!agent) {
          this.cleanupOrphanAgentEnvelopes(agentName);
          continue;
        }

        // Non-blocking: agent turns may take a long time (LLM call).
        this.executor.checkAndRun(agent, this.db, { kind: "scheduler", reason }).catch((err) => {
          logEvent("error", "scheduler-agent-run-failed", {
            "agent-name": agentName,
            error: errorMessage(err),
          });
        });
      }
    } finally {
      this.tickInProgress = false;

      // If anything queued another tick while we were running, run it once more.
      if (this.tickQueued) {
        this.tickQueued = false;
        void this.tick("queued");
        return;
      }

      // Always reschedule based on the latest DB state.
      this.scheduleNextWake();
    }
  }

  private cleanupOrphanAgentEnvelopes(agentName: string): void {
    const raw = agentName;
    const toAddress = `agent:${raw}`;
    let cleaned = 0;

    while (cleaned < MAX_ORPHAN_AGENT_ENVELOPES_PER_TICK) {
      const batch = this.db.listEnvelopes({
        address: toAddress,
        box: "inbox",
        status: "pending",
        limit: ORPHAN_AGENT_ENVELOPES_BATCH_SIZE,
        dueOnly: true,
      });

      if (batch.length === 0) break;

      const nowMs = Date.now();
      this.db.runInTransaction(() => {
        for (const env of batch) {
          const current =
            env.metadata && typeof env.metadata === "object"
              ? (env.metadata as Record<string, unknown>)
              : {};
          const next = {
            ...current,
            lastDeliveryError: {
              atMs: nowMs,
              kind: "agent-not-found",
              message: `Agent '${raw || "(empty)"}' not found`,
              to: toAddress,
            },
          };
          this.db.updateEnvelopeMetadata(env.id, next);
          this.db.updateEnvelopeStatus(env.id, "done");
        }
      });

      cleaned += batch.length;
      if (batch.length < ORPHAN_AGENT_ENVELOPES_BATCH_SIZE) break;
    }

    if (cleaned > 0) {
      logEvent("warn", "scheduler-orphan-agent-envelopes-cleaned", {
        "agent-name": raw || "(empty)",
        to: toAddress,
        cleaned,
      });
    }
  }

  scheduleNextWake(): void {
    if (!this.running) return;

    this.clearTimer();

    const next = this.db.getNextScheduledEnvelope();
    const deliverAt = next?.deliverAt;
    if (!deliverAt) {
      return;
    }

    const delay = delayUntilUnixMs(deliverAt);
    if (delay <= 0) {
      // "First tick after the instant" (best-effort): run on the next event loop tick.
      setImmediate(() => void this.tick("due-now"));
      return;
    }

    const clamped = Math.min(delay, MAX_TIMER_DELAY_MS);
    this.nextWakeTimer = setTimeout(() => {
      void this.tick("timer");
    }, clamped);
  }
}
