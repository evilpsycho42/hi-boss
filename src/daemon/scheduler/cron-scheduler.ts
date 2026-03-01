import type { HiBossDatabase } from "../db/database.js";
import type { CronSchedule, CreateCronScheduleInput } from "../../cron/types.js";
import { getCronExecutionMode } from "../../cron/types.js";
import type { Envelope } from "../../envelope/types.js";
import { computeNextCronUnixMs, normalizeTimeZoneInput } from "../../shared/cron.js";
import { formatAgentAddress, parseAddress } from "../../adapters/types.js";
import { errorMessage, logEvent } from "../../shared/daemon-log.js";
import { formatUnixMsAsTimeZoneOffset } from "../../shared/time.js";
import type { EnvelopeScheduler } from "./envelope-scheduler.js";

function getCronScheduleIdFromEnvelopeMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>).cronScheduleId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export interface CronSchedulerOptions {
  onEnvelopeCreated?: (envelope: Envelope) => void;
}

export class CronScheduler {
  private onEnvelopeCreated?: (envelope: Envelope) => void;

  constructor(
    private readonly db: HiBossDatabase,
    private readonly envelopeScheduler: EnvelopeScheduler,
    options?: CronSchedulerOptions
  ) {
    this.onEnvelopeCreated = options?.onEnvelopeCreated;
  }

  private buildCronEnvelopeMetadata(schedule: CronSchedule): Record<string, unknown> {
    const template =
      schedule.metadata && typeof schedule.metadata === "object" ? { ...schedule.metadata } : {};
    if (typeof (template as Record<string, unknown>).replyToMessageId === "string") {
      delete (template as Record<string, unknown>).replyToMessageId;
    }
    if (typeof (template as Record<string, unknown>).replyToEnvelopeId === "string") {
      delete (template as Record<string, unknown>).replyToEnvelopeId;
    }

    // Propagate one-shot execution mode to the envelope.
    // "inline" envelopes enter the normal agent queue (no oneshotType).
    // "isolated"/"clone" get oneshotType so the daemon routes them to OneShotExecutor.
    const execMode = getCronExecutionMode(schedule.metadata);
    const oneshotType = execMode === "inline" ? undefined : execMode;

    return {
      ...template,
      origin: "cron",
      cronScheduleId: schedule.id,
      ...(oneshotType ? { oneshotType } : {}),
    };
  }

  private assertChannelBinding(schedule: Pick<CronSchedule, "agentName" | "to">): void {
    const destination = parseAddress(schedule.to);
    if (destination.type === "team" || destination.type === "team-mention") {
      throw new Error("Cron schedules cannot use team destinations");
    }
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

    const deliverAt = computeNextCronUnixMs({
      cron: schedule.cron,
      timezone: schedule.timezone,
      bossTimezone: this.db.getBossTimezone(),
      afterDate,
    });

    const metadata = this.buildCronEnvelopeMetadata(schedule);
    const execMode = getCronExecutionMode(schedule.metadata);
    const isOneshot = execMode !== "inline";

    // For one-shot cron: route to the agent handler so OneShotExecutor picks it up.
    // Store the original destination in metadata for response routing.
    const from = formatAgentAddress(schedule.agentName);
    const to = isOneshot ? formatAgentAddress(schedule.agentName) : schedule.to;

    if (isOneshot && schedule.to !== to) {
      metadata.cronResponseTo = schedule.to;
    }

    const envelope = this.db.createEnvelope({
      from,
      to,
      fromBoss: false,
      content: schedule.content,
      deliverAt,
      metadata,
    });

    this.db.updateCronSchedulePendingEnvelopeId(schedule.id, envelope.id);
    const bossTz = this.db.getBossTimezone();
    logEvent("info", "envelope-created", {
      "envelope-id": envelope.id,
      source: "cron",
      "cron-id": schedule.id,
      "agent-name": schedule.agentName,
      from: envelope.from,
      to: envelope.to,
      "deliver-at": envelope.deliverAt ? formatUnixMsAsTimeZoneOffset(envelope.deliverAt, bossTz) : "none",
    });

    if (this.onEnvelopeCreated) {
      try {
        this.onEnvelopeCreated(envelope);
      } catch (err) {
        logEvent("error", "cron-on-envelope-created-failed", {
          "envelope-id": envelope.id,
          "cron-id": schedule.id,
          error: errorMessage(err),
        });
      }
    }

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
    computeNextCronUnixMs({
      cron: normalizedInput.cron,
      timezone: normalizedInput.timezone,
      bossTimezone: this.db.getBossTimezone(),
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
        this.db.updateEnvelopeStatus(schedule.pendingEnvelopeId, "done", {
          reason: "cron-enable-replace-pending",
          origin: "cron",
          outcome: "superseded-by-new-pending",
        });
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
        this.db.updateEnvelopeStatus(schedule.pendingEnvelopeId, "done", {
          reason: "cron-disable-clear-pending",
          origin: "cron",
          outcome: "cleared-by-disable",
        });
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
        this.db.updateEnvelopeStatus(schedule.pendingEnvelopeId, "done", {
          reason: "cron-delete-clear-pending",
          origin: "cron",
          outcome: "cleared-by-delete",
        });
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

          // Backwards-compat: older versions allowed cron schedules to store reply-to metadata.
          // Ensure any existing pending cron envelope doesn't reply, even once.
          if (current.pendingEnvelopeId) {
            const pendingEnvelope = this.db.getEnvelopeById(current.pendingEnvelopeId);
            const md = pendingEnvelope?.metadata;
            if (md && typeof md === "object") {
              const obj = md as Record<string, unknown>;
              const hasReplyToMessageId = typeof obj.replyToMessageId === "string";
              const hasReplyToEnvelopeId = typeof obj.replyToEnvelopeId === "string";
              if (hasReplyToMessageId || hasReplyToEnvelopeId) {
                const cleaned = { ...obj };
                delete cleaned.replyToMessageId;
                delete cleaned.replyToEnvelopeId;
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
              this.db.updateEnvelopeStatus(current.pendingEnvelopeId, "done", {
                reason: "cron-reconcile-disable-clear",
                origin: "cron",
                outcome: "cleared-by-reconcile-disable",
              });
              this.db.updateCronSchedulePendingEnvelopeId(current.id, null);
            }
            return;
          }

          const deliverAtMs = typeof current.nextDeliverAt === "number" ? current.nextDeliverAt : null;

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
            this.db.updateEnvelopeStatus(current.pendingEnvelopeId, "done", {
              reason: "cron-reconcile-replace-pending",
              origin: "cron",
              outcome: "superseded-by-reconcile",
            });
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
