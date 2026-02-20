import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";
import type { CronSchedule } from "../../cron/types.js";
import { getCronExecutionMode } from "../../cron/types.js";
import { formatUnixMsAsTimeZoneOffset } from "../../shared/time.js";
import { computeNextCronUnixMsSeries } from "../../shared/cron.js";
import { isValidIanaTimeZone } from "../../shared/timezone.js";
import { extractTelegramFileId, normalizeAttachmentSource, resolveText } from "./envelope-input.js";
import { tryPrintAmbiguousIdPrefixError } from "../ambiguous-id.js";
import { formatShortId } from "../../shared/id-format.js";
import { getDaemonTimeContext } from "../time-context.js";

interface CronCreateResult {
  id: string;
}

interface CronListResult {
  schedules: CronSchedule[];
}

interface CronToggleResult {
  success: boolean;
  id: string;
}

export interface CronCreateOptions {
  token?: string;
  cron: string;
  timezone?: string;
  to: string;
  text?: string;
  textFile?: string;
  attachment?: string[];
  parseMode?: string;
  executionMode?: string;
  isolated?: boolean;
  clone?: boolean;
  inline?: boolean;
}

export interface CronListOptions {
  token?: string;
}

export interface CronIdOptions {
  token?: string;
  id: string;
}

export interface CronExplainOptions {
  token?: string;
  cron: string;
  timezone?: string;
  count?: number;
}

function formatMaybeOffset(ms: number | undefined, bossTimezone: string): string {
  if (typeof ms !== "number") return "(none)";
  return formatUnixMsAsTimeZoneOffset(ms, bossTimezone);
}

function formatMaybeShortId(uuid?: string): string {
  if (!uuid) return "(none)";
  const trimmed = uuid.trim();
  if (!trimmed) return "(none)";
  return formatShortId(trimmed);
}

function formatCronScheduleSummary(schedule: CronSchedule, bossTimezone: string): string {
  const lines: string[] = [];
  lines.push(`cron-id: ${formatShortId(schedule.id)}`);
  lines.push(`cron: ${schedule.cron}`);
  lines.push(`timezone: ${schedule.timezone ?? "boss"}`);
  lines.push(`enabled: ${schedule.enabled ? "true" : "false"}`);
  lines.push(`execution-mode: ${getCronExecutionMode(schedule.metadata)}`);
  lines.push(`to: ${schedule.to}`);
  lines.push(`next-deliver-at: ${formatMaybeOffset(schedule.nextDeliverAt, bossTimezone)}`);
  lines.push(`pending-envelope-id: ${formatMaybeShortId(schedule.pendingEnvelopeId)}`);
  return lines.join("\n");
}

function formatCronScheduleDetail(schedule: CronSchedule, bossTimezone: string): string {
  const lines: string[] = [];
  lines.push(formatCronScheduleSummary(schedule, bossTimezone));
  lines.push(`created-at: ${formatMaybeOffset(schedule.createdAt, bossTimezone)}`);
  if (schedule.updatedAt) {
    lines.push(`updated-at: ${formatMaybeOffset(schedule.updatedAt, bossTimezone)}`);
  }

  const md = schedule.metadata;
  if (md && typeof md === "object") {
    const parseMode = (md as Record<string, unknown>).parseMode;
    if (typeof parseMode === "string" && parseMode.trim()) {
      lines.push(`parse-mode: ${parseMode.trim()}`);
    }
  }

  lines.push("text:");
  lines.push(schedule.content.text?.trimEnd() ? schedule.content.text.trimEnd() : "(none)");

  const attachments = schedule.content.attachments ?? [];
  if (attachments.length > 0) {
    lines.push("attachments:");
    for (const att of attachments) {
      lines.push(`- ${att.source}`);
    }
  }

  return lines.join("\n");
}

export async function createCron(options: CronCreateOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const text = await resolveText(options.text, options.textFile);
    const parseMode = options.parseMode?.trim();
    if (parseMode && parseMode !== "plain" && parseMode !== "markdownv2" && parseMode !== "html") {
      throw new Error("Invalid --parse-mode (expected plain, markdownv2, or html)");
    }

    // Resolve execution mode from flags (--isolated, --clone, --inline) or --execution-mode.
    const executionMode = resolveExecutionMode(options);

    const result = await client.call<CronCreateResult>("cron.create", {
      token,
      cron: options.cron,
      timezone: options.timezone,
      to: options.to,
      text,
      attachments: options.attachment?.map((source) => {
        const telegramFileId = extractTelegramFileId(source);
        return {
          source: normalizeAttachmentSource(source),
          ...(telegramFileId ? { telegramFileId } : {}),
        };
      }),
      parseMode,
      executionMode,
    });

    console.log(`cron-id: ${formatShortId(result.id)}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

function resolveExecutionMode(options: CronCreateOptions): string {
  const flags = [options.isolated, options.clone, options.inline].filter(Boolean);
  if (flags.length > 1) {
    throw new Error("Only one of --isolated, --clone, or --inline may be specified");
  }

  if (options.isolated) return "isolated";
  if (options.clone) return "clone";
  if (options.inline) return "inline";

  if (options.executionMode) {
    const mode = options.executionMode.trim();
    if (mode !== "isolated" && mode !== "clone" && mode !== "inline") {
      throw new Error("Invalid --execution-mode (expected isolated, clone, or inline)");
    }
    return mode;
  }

  return "isolated"; // default
}

export async function listCrons(options: CronListOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const time = await getDaemonTimeContext({ client, token });
    const result = await client.call<CronListResult>("cron.list", { token });

    if (result.schedules.length === 0) {
      console.log("no-crons: true");
      return;
    }

    for (const schedule of result.schedules) {
      console.log(formatCronScheduleDetail(schedule, time.bossTimezone));
      console.log();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function explainCron(options: CronExplainOptions): Promise<void> {
  const requestedTimezone = options.timezone?.trim();

  try {
    const count = (() => {
      const raw = options.count;
      if (raw === undefined || raw === null) return 5;
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error("Invalid --count");
      }
      const n = Math.trunc(raw);
      if (n <= 0) throw new Error("Invalid --count (must be >= 1)");
      if (n > 20) throw new Error("Invalid --count (max 20)");
      return n;
    })();

    if (typeof options.cron !== "string" || !options.cron.trim()) {
      throw new Error("Invalid --cron");
    }

    if (requestedTimezone) {
      if (!isValidIanaTimeZone(requestedTimezone)) {
        throw new Error("Invalid --timezone (expected IANA timezone)");
      }
    }

    const config = getDefaultConfig();
    const client = new IpcClient(getSocketPath(config));

    let effectiveTimezone = requestedTimezone;
    if (!effectiveTimezone) {
      const token = resolveToken(options.token);
      effectiveTimezone = (
        await getDaemonTimeContext({
          client,
          token,
        })
      ).bossTimezone;
    }
    if (!effectiveTimezone) {
      throw new Error("Failed to resolve timezone");
    }

    const now = Date.now();
    const runs = computeNextCronUnixMsSeries({
      cron: options.cron.trim(),
      timezone: effectiveTimezone,
      bossTimezone: effectiveTimezone,
      afterDate: new Date(now),
      count,
    });

    console.log(`cron: ${options.cron.trim()}`);
    console.log(`timezone: ${effectiveTimezone}`);
    console.log(`count: ${count}`);
    console.log(`evaluated-at: ${formatUnixMsAsTimeZoneOffset(now, effectiveTimezone)}`);
    for (let i = 0; i < runs.length; i++) {
      console.log(`next-run-${i + 1}: ${formatUnixMsAsTimeZoneOffset(runs[i], effectiveTimezone)}`);
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function enableCron(options: CronIdOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  const token = resolveToken(options.token);
  const time = await getDaemonTimeContext({ client, token }).catch(() => null);

  try {
    const result = await client.call<CronToggleResult>("cron.enable", { token, id: options.id });
    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`cron-id: ${formatShortId(result.id)}`);
  } catch (err) {
    if (tryPrintAmbiguousIdPrefixError(err, { displayTimeZone: time?.bossTimezone })) {
      process.exit(1);
    }
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function disableCron(options: CronIdOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  const token = resolveToken(options.token);
  const time = await getDaemonTimeContext({ client, token }).catch(() => null);

  try {
    const result = await client.call<CronToggleResult>("cron.disable", { token, id: options.id });
    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`cron-id: ${formatShortId(result.id)}`);
  } catch (err) {
    if (tryPrintAmbiguousIdPrefixError(err, { displayTimeZone: time?.bossTimezone })) {
      process.exit(1);
    }
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function deleteCron(options: CronIdOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  const token = resolveToken(options.token);
  const time = await getDaemonTimeContext({ client, token }).catch(() => null);

  try {
    const result = await client.call<CronToggleResult>("cron.delete", { token, id: options.id });
    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`cron-id: ${formatShortId(result.id)}`);
  } catch (err) {
    if (tryPrintAmbiguousIdPrefixError(err, { displayTimeZone: time?.bossTimezone })) {
      process.exit(1);
    }
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
