import type { SessionEnvelopeCreatedEvent } from "../daemon/history/types.js";
import { readSessionFile } from "../daemon/history/session-file-io.js";
import { formatShortId } from "../shared/id-format.js";
import { formatUnixMsAsTimeZoneOffset } from "../shared/time.js";

export interface SessionCarryoverContext {
  reason: string;
  sourceSessionId: string;
  messageCount: number;
  text: string;
}

const MAX_EVENTS_SCANNED = 400;
const MAX_CARRYOVER_MESSAGES = 24;
const MAX_LINE_CHARS = 360;
const MAX_TOTAL_CHARS = 8_000;

function normalizeInlineText(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}...`;
}

function shouldIncludeCarryoverReason(reasonPart: string): boolean {
  const normalized = reasonPart.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes("/provider") || normalized.startsWith("provider-mismatch:");
}

export function shouldBuildSessionCarryover(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason.split(",").some(shouldIncludeCarryoverReason);
}

function formatCarryoverLine(params: {
  event: SessionEnvelopeCreatedEvent;
  timezone: string;
}): string | null {
  const env = params.event.envelope;
  const text = normalizeInlineText(env.content.text);
  const attachmentCount = env.content.attachments?.length ?? 0;
  if (!text && attachmentCount === 0) return null;

  const at = formatUnixMsAsTimeZoneOffset(
    params.event.timestampMs || env.createdAt,
    params.timezone,
  );
  const body = text
    ? truncateText(text, MAX_LINE_CHARS)
    : "(attachment-only message)";
  const pieces = [
    `[${at}]`,
    `${env.from} -> ${env.to}`,
    ...(env.fromBoss ? ["[boss]"] : []),
    `text: ${body}`,
    ...(attachmentCount > 0 ? [`attachments: ${attachmentCount}`] : []),
  ];
  return pieces.join(" | ");
}

export function buildSessionCarryoverFromHistory(params: {
  reason: string | undefined;
  oldSessionFilePath: string | null;
  timezone: string;
}): SessionCarryoverContext | null {
  if (!shouldBuildSessionCarryover(params.reason)) return null;
  if (!params.oldSessionFilePath) return null;

  const session = readSessionFile(params.oldSessionFilePath);
  if (!session) return null;

  const envelopeEvents: SessionEnvelopeCreatedEvent[] = [];
  for (const event of session.events) {
    if (event.type !== "envelope-created") continue;
    envelopeEvents.push(event);
  }
  if (envelopeEvents.length === 0) return null;

  const lines: string[] = [];
  const seenEnvelopeIds = new Set<string>();
  let totalChars = 0;
  let scanned = 0;

  for (let index = envelopeEvents.length - 1; index >= 0; index--) {
    if (lines.length >= MAX_CARRYOVER_MESSAGES) break;
    if (scanned >= MAX_EVENTS_SCANNED) break;
    scanned++;

    const event = envelopeEvents[index]!;
    const envelopeId = event.envelope.id;
    if (seenEnvelopeIds.has(envelopeId)) continue;
    seenEnvelopeIds.add(envelopeId);

    const line = formatCarryoverLine({
      event,
      timezone: params.timezone,
    });
    if (!line) continue;

    if (totalChars + line.length > MAX_TOTAL_CHARS && lines.length > 0) break;
    totalChars += line.length;
    lines.push(line);
  }

  if (lines.length === 0) return null;
  lines.reverse();

  return {
    reason: "provider-switch-history",
    sourceSessionId: formatShortId(session.sessionId),
    messageCount: lines.length,
    text: lines.join("\n"),
  };
}
