import type { HiBossDatabase } from "../db/database.js";
import type { CronSchedule, CreateCronScheduleInput } from "../../cron/types.js";
import type { Envelope } from "../../envelope/types.js";
import { computeNextCronUtcIso, normalizeTimeZoneInput } from "../../shared/cron.js";
import { formatAgentAddress, parseAddress } from "../../adapters/types.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import type { EnvelopeScheduler } from "./envelope-scheduler.js";

function getCronScheduleIdFromEnvelopeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).cronScheduleId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export class CronScheduler {
  constructor(
    private readonly db: HiBossDatabase,
    private readonly envelopeScheduler: EnvelopeScheduler
  ) {}

  private buildCronEnvelopeMetadata(schedule: CronSchedule): Record<string, unknown> {
    const template =
      schedule.metadata && typeof schedule.metadata === "object" ? { ...schedule.metadata } : {};
    if (typeof (template as Record<string, unknown>).replyToMessageId === "string") {
      delete (template as Record<string, unknown>).replyToMessageId;
    }
    return {
      ...template,
      cronScheduleId: schedule.id,
    };
  }

  private assertChannelBinding(schedule: Pick<CronSchedule, "agentName" | "to">): void {
    const destination = parseAddress(schedule.to);
    if (destination.type !== "channel") return;

    const binding = this.db.getAgentBindingByType(schedule.agentName, destination.adapter);
    if (!binding) {
      throw new Error(
        `Agent '${schedule.agentName}' is not bound to adapter '${destination.adapter}'`
      );
    }
  }

  private createNextEnvelopeForSchedule(schedule: CronSchedule, afterDate?: Date): Envelope {
    this.assertChannelBinding(schedule);

    const deliverAt = computeNextCronUtcIso({
      cron: schedule.cron,
      timezone: schedule.timezone,
      afterDate,
    });

    const envelope = this.db.createEnvelope({
      from: formatAgentAddress(schedule.agentName),
      to: schedule.to,
      fromBoss: false,
      content: schedule.content,
      deliverAt,
      metadata: this.buildCronEnvelopeMetadata(schedule),
    });

    this.db.updateCronSchedulePendingEnvelopeId(schedule.id, envelope.id);
    logEvent("info", "envelope-created", {
      "envelope-id": envelope.id,
      source: "cron",
      "cron-id": schedule.id,
      "agent-name": schedule.agentName,
      from: envelope.from,
      to: envelope.to,
      "deliver-at": envelope.deliverAt ?? "none",
    });
    return envelope;
  }

  createSchedule(input: CreateCronScheduleInput): { schedule: CronSchedule; envelope?: Envelope } {
    // Normalize timezone before persisting.
    const normalizedInput: CreateCronScheduleInput = {
      ...input,
      timezone: normalizeTimeZoneInput(input.timezone),
    };

    // Pre-validate that cron parses and that we can compute a next deliver-at.
    // (Also protects against creating an enabled schedule with no pending envelope.)
    computeNextCronUtcIso({
      cron: normalizedInput.cron,
      timezone: normalizedInput.timezone,
    });

    let createdSchedule!: CronSchedule;
    let createdEnvelope: Envelope | undefined;

    this.db.runInTransaction(() => {
      createdSchedule = this.db.createCronSchedule(normalizedInput);
      if (createdSchedule.enabled) {
        createdEnvelope = this.createNextEnvelopeForSchedule(createdSchedule);
      }
    });

    if (createdEnvelope) {
      this.envelopeScheduler.onEnvelopeCreated(createdEnvelope);
    }

    return { schedule: this.db.getCronScheduleById(createdSchedule.id)!, envelope: createdEnvelope };
  }

  listSchedules(agentName: string): CronSchedule[] {
    return this.db.listCronSchedulesByAgent(agentName);
  }

  getSchedule(agentName: string, id: string): CronSchedule {
    const schedule = this.db.getCronScheduleById(id);
    if (!schedule) {
      throw new Error("Cron schedule not found");
    }
    if (schedule.agentName !== agentName) {
      throw new Error("Access denied");
    }
    return schedule;
  }

  enableSchedule(agentName: string, id: string): { schedule: CronSchedule; envelope?: Envelope } {
    let createdEnvelope: Envelope | undefined;

    this.db.runInTransaction(() => {
      const schedule = this.getSchedule(agentName, id);

      // Cancel any existing pending envelope (best-effort) and materialize a fresh next occurrence.
      if (schedule.pendingEnvelopeId) {
        this.db.updateEnvelopeStatus(schedule.pendingEnvelopeId, "done");
      }

      this.db.updateCronScheduleEnabled(schedule.id, true);
      this.db.updateCronSchedulePendingEnvelopeId(schedule.id, null);
      createdEnvelope = this.createNextEnvelopeForSchedule(schedule);
    });

    if (createdEnvelope) {
      this.envelopeScheduler.onEnvelopeCreated(createdEnvelope);
    }

    return { schedule: this.db.getCronScheduleById(id)!, envelope: createdEnvelope };
  }

  disableSchedule(agentName: string, id: string): CronSchedule {
    this.db.runInTransaction(() => {
      const schedule = this.getSchedule(agentName, id);

      if (schedule.pendingEnvelopeId) {
        this.db.updateEnvelopeStatus(schedule.pendingEnvelopeId, "done");
      }

      this.db.updateCronScheduleEnabled(schedule.id, false);
      this.db.updateCronSchedulePendingEnvelopeId(schedule.id, null);
    });

    return this.db.getCronScheduleById(id)!;
  }

  deleteSchedule(agentName: string, id: string): boolean {
    let deleted = false;

    this.db.runInTransaction(() => {
      const schedule = this.getSchedule(agentName, id);

      if (schedule.pendingEnvelopeId) {
        this.db.updateEnvelopeStatus(schedule.pendingEnvelopeId, "done");
      }

      deleted = this.db.deleteCronSchedule(schedule.id);
    });

    return deleted;
  }

  /**
   * Best-effort: ensure enabled schedules have exactly one pending envelope in the future.
   *
   * On daemon start, call with skipMisfires=true to avoid delivering missed cron runs.
   */
  reconcileAllSchedules(params: { skipMisfires: boolean }): void {
    const now = new Date();
    const nowMs = now.getTime();

    const schedules = this.db.listCronSchedules();
    for (const schedule of schedules) {
      try {
        let created: Envelope | null = null;

        this.db.runInTransaction(() => {
          const current = this.db.getCronScheduleById(schedule.id);
          if (!current) return;

          // Backwards-compat: older versions allowed cron schedules to store a reply-to-channel-message-id.
          // Ensure any existing pending cron envelope doesn't reply, even once.
          if (current.pendingEnvelopeId) {
            const pendingEnvelope = this.db.getEnvelopeById(current.pendingEnvelopeId);
            const md = pendingEnvelope?.metadata;
            if (md && typeof md === "object") {
              const obj = md as Record<string, unknown>;
              if (typeof obj.replyToMessageId === "string") {
                const cleaned = { ...obj };
                delete cleaned.replyToMessageId;
                this.db.updateEnvelopeMetadata(
                  current.pendingEnvelopeId,
                  Object.keys(cleaned).length > 0 ? cleaned : undefined
                );
              }
            }
          }

          // Disabled schedules must not have pending envelopes.
          if (!current.enabled) {
            if (current.pendingEnvelopeId) {
              this.db.updateEnvelopeStatus(current.pendingEnvelopeId, "done");
              this.db.updateCronSchedulePendingEnvelopeId(current.id, null);
            }
            return;
          }

          const deliverAtMs =
            current.nextDeliverAt && !Number.isNaN(Date.parse(current.nextDeliverAt))
              ? Date.parse(current.nextDeliverAt)
              : null;

          const isMissingPendingEnvelope =
            !current.pendingEnvelopeId ||
            current.pendingEnvelopeStatus !== "pending" ||
            deliverAtMs === null;

          const isMisfire =
            params.skipMisfires &&
            current.pendingEnvelopeId &&
            current.pendingEnvelopeStatus === "pending" &&
            deliverAtMs !== null &&
            deliverAtMs <= nowMs;

          if (!isMissingPendingEnvelope && !isMisfire) {
            return;
          }

          if (current.pendingEnvelopeId) {
            this.db.updateEnvelopeStatus(current.pendingEnvelopeId, "done");
            this.db.updateCronSchedulePendingEnvelopeId(current.id, null);
          }

          created = this.createNextEnvelopeForSchedule(current, now);
        });

        if (created) {
          this.envelopeScheduler.onEnvelopeCreated(created);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent("warn", "cron-reconcile-failed", {
          "cron-id": schedule.id,
          error: message,
        });
      }
    }
  }

  onEnvelopeDone(envelope: Envelope): void {
    const scheduleId = getCronScheduleIdFromEnvelopeMetadata(envelope.metadata);
    if (!scheduleId) return;

    try {
      let created: Envelope | null = null;

      this.db.runInTransaction(() => {
        const schedule = this.db.getCronScheduleById(scheduleId);
        if (!schedule) return;
        if (!schedule.enabled) return;

        // Prevent double-advance: only advance when this envelope matches the schedule's current pending envelope.
        if (!schedule.pendingEnvelopeId || schedule.pendingEnvelopeId !== envelope.id) {
          return;
        }

        created = this.createNextEnvelopeForSchedule(schedule, new Date());
      });

      if (created) {
        this.envelopeScheduler.onEnvelopeCreated(created);
      }
    } catch (err) {
      logEvent("error", "cron-advance-failed", {
        "cron-id": scheduleId,
        "envelope-id": envelope.id,
        error: errorMessage(err),
      });
    }
  }

  onEnvelopesDone(envelopeIds: string[]): void {
    for (const id of envelopeIds) {
      const env = this.db.getEnvelopeById(id);
      if (!env) continue;
      this.onEnvelopeDone(env);
    }
  }
}
