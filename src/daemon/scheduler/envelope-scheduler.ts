import type { Envelope } from "../../envelope/types.js";
import type { HiBossDatabase } from "../db/database.js";
import type { MessageRouter } from "../router/message-router.js";
import type { AgentExecutor } from "../../agent/executor.js";
import { delayUntilUtcIso, nowLocalIso } from "../../shared/time.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout max (~24.8 days)
const MAX_CHANNEL_ENVELOPES_PER_TICK = 100;

export class EnvelopeScheduler {
  private nextWakeTimer: NodeJS.Timeout | null = null;
  private running = false;
  private tickInProgress = false;
  private tickQueued = false;

  constructor(
    private readonly db: HiBossDatabase,
    private readonly router: MessageRouter,
    private readonly executor: AgentExecutor,
    private readonly options: { debug?: boolean } = {}
  ) {}

  private log(message: string): void {
    if (this.options.debug) {
      console.log(`[${nowLocalIso()}] [Scheduler] ${message}`);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.log("Started");
    void this.tick("startup");
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    this.log("Stopped");
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
      this.log(`Tick: ${reason}`);

      // 1) Deliver due channel envelopes (scheduled delivery).
      const dueChannel = this.db.listDueChannelEnvelopes(MAX_CHANNEL_ENVELOPES_PER_TICK);
      for (const env of dueChannel) {
        try {
          await this.router.deliverEnvelope(env);
        } catch (err) {
          console.error(`[Scheduler] Channel delivery failed for envelope ${env.id}:`, err);
        }
      }

      // 2) Trigger agents that have due envelopes.
      const agentNames = this.db.listAgentNamesWithDueEnvelopes();
      for (const agentName of agentNames) {
        const agent = this.db.getAgentByName(agentName);
        if (!agent) continue;

        // Non-blocking: agent turns may take a long time (LLM call).
        this.executor.checkAndRun(agent, this.db).catch((err) => {
          console.error(`[Scheduler] Agent ${agentName} run failed:`, err);
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

  scheduleNextWake(): void {
    if (!this.running) return;

    this.clearTimer();

    const next = this.db.getNextScheduledEnvelope();
    const deliverAt = next?.deliverAt;
    if (!deliverAt) {
      this.log("No next scheduled envelope");
      return;
    }

    const delay = delayUntilUtcIso(deliverAt);
    if (delay <= 0) {
      // "First tick after the instant" (best-effort): run on the next event loop tick.
      setImmediate(() => void this.tick("due-now"));
      return;
    }

    const clamped = Math.min(delay, MAX_TIMER_DELAY_MS);
    this.log(`Next wake in ${clamped}ms (deliver-at: ${deliverAt})`);
    this.nextWakeTimer = setTimeout(() => {
      void this.tick("timer");
    }, clamped);
  }
}
