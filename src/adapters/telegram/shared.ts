import type { OutgoingParseMode } from "../types.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isGetUpdatesConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const typed = err as { response?: { error_code?: number; description?: string } };
  if (typed.response?.error_code !== 409) return false;
  return typed.response?.description?.toLowerCase().includes("getupdates") ?? false;
}

export function isReplyToMessageNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const typed = err as { response?: { error_code?: number; description?: string } };
  if (typed.response?.error_code !== 400) return false;
  return typed.response?.description?.toLowerCase().includes("message to be replied") ?? false;
}

export function computeBackoff(attempt: number): number {
  const initialMs = 2000;
  const maxMs = 30000;
  const factor = 1.8;
  const jitter = 0.25;

  const base = Math.min(initialMs * Math.pow(factor, attempt), maxMs);
  const variance = base * jitter * (Math.random() * 2 - 1);
  return Math.round(base + variance);
}

export function toTelegramParseMode(mode: OutgoingParseMode | undefined): "MarkdownV2" | "HTML" | undefined {
  switch (mode) {
    case "markdownv2":
      return "MarkdownV2";
    case "html":
      return "HTML";
    case "plain":
    case undefined:
      return undefined;
  }
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[...truncated...]\n";
}

// Telegram limits (official API constraints):
// - Text messages: 4096 characters
// - Media captions (photo/video/document/audio, including media groups): 1024 characters
export const TELEGRAM_MAX_TEXT_CHARS = 4096;
export const TELEGRAM_MAX_CAPTION_CHARS = 1024;

export function splitTextForTelegram(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    // Prefer splitting near the end on a natural boundary.
    let cut = maxChars;
    const windowStart = Math.max(0, maxChars - 600);
    const window = remaining.slice(windowStart, maxChars);

    const boundaryIdx = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    if (boundaryIdx > 0) {
      cut = windowStart + boundaryIdx;
    }

    const part = remaining.slice(0, cut).trimEnd();
    if (!part) {
      // Hard cut fallback to avoid infinite loops.
      chunks.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars);
      continue;
    }

    chunks.push(part);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

