import { getDefaultConfig, getSocketPath } from "../../daemon/daemon.js";
import { IpcClient } from "../ipc-client.js";
import { resolveToken } from "../token.js";
import type { CronSchedule } from "../../cron/types.js";
import { formatUtcIsoAsLocalOffset } from "../../shared/time.js";
import { extractTelegramFileId, normalizeAttachmentSource, resolveText } from "./envelope-input.js";

interface CronCreateResult {
  id: string;
}

interface CronListResult {
  schedules: CronSchedule[];
}

interface CronToggleResult {
  success: boolean;
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
}

export interface CronListOptions {
  token?: string;
}

export interface CronIdOptions {
  token?: string;
  id: string;
}

function formatMaybeLocalIso(utcIso?: string): string {
  if (!utcIso) return "(none)";
  const trimmed = utcIso.trim();
  if (!trimmed) return "(none)";
  return formatUtcIsoAsLocalOffset(trimmed);
}

function formatCronScheduleSummary(schedule: CronSchedule): string {
  const lines: string[] = [];
  lines.push(`cron-id: ${schedule.id}`);
  lines.push(`cron: ${schedule.cron}`);
  lines.push(`timezone: ${schedule.timezone ?? "local"}`);
  lines.push(`enabled: ${schedule.enabled ? "true" : "false"}`);
  lines.push(`to: ${schedule.to}`);
  lines.push(`next-deliver-at: ${formatMaybeLocalIso(schedule.nextDeliverAt)}`);
  lines.push(`pending-envelope-id: ${schedule.pendingEnvelopeId ?? "(none)"}`);
  return lines.join("\n");
}

function formatCronScheduleDetail(schedule: CronSchedule): string {
  const lines: string[] = [];
  lines.push(formatCronScheduleSummary(schedule));
  lines.push(`created-at: ${formatMaybeLocalIso(schedule.createdAt)}`);
  if (schedule.updatedAt) {
    lines.push(`updated-at: ${formatMaybeLocalIso(schedule.updatedAt)}`);
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
    });

    console.log(`cron-id: ${result.id}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function listCrons(options: CronListOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<CronListResult>("cron.list", { token });

    if (result.schedules.length === 0) {
      console.log("no-crons: true");
      return;
    }

    for (const schedule of result.schedules) {
      console.log(formatCronScheduleDetail(schedule));
      console.log();
    }
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function enableCron(options: CronIdOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<CronToggleResult>("cron.enable", { token, id: options.id });
    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`cron-id: ${options.id}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function disableCron(options: CronIdOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<CronToggleResult>("cron.disable", { token, id: options.id });
    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`cron-id: ${options.id}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}

export async function deleteCron(options: CronIdOptions): Promise<void> {
  const config = getDefaultConfig();
  const client = new IpcClient(getSocketPath(config));

  try {
    const token = resolveToken(options.token);
    const result = await client.call<CronToggleResult>("cron.delete", { token, id: options.id });
    console.log(`success: ${result.success ? "true" : "false"}`);
    console.log(`cron-id: ${options.id}`);
  } catch (err) {
    console.error("error:", (err as Error).message);
    process.exit(1);
  }
}
