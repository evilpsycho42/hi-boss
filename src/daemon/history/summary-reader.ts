/**
 * Summary reader — reads recent session summaries for system prompt injection.
 *
 * Scans date directories under internal_space/history/, collects non-null
 * summaries from the last N days, and returns them formatted for the prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { readSessionFile } from "./session-file-io.js";
import {
  DEFAULT_SESSION_SUMMARY_RECENT_DAYS,
  DEFAULT_SESSION_SUMMARY_MAX_CHARS_TOTAL,
  DEFAULT_SESSION_SUMMARY_MAX_CHARS_PER_SESSION,
} from "../../shared/defaults.js";

// ── Types ──

export interface SessionSummaryForPrompt {
  sessionId: string;
  startedAt: string; // ISO 8601 with timezone offset
  summary: string;
}

// ── Core reader ──

const DATE_DIR_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read recent session summaries for prompt injection.
 * Returns summaries sorted chronologically (oldest first).
 */
export function readRecentSessionSummaries(params: {
  agentsDir: string;
  agentName: string;
  timezone: string;
  recentDays?: number;
  maxTotalChars?: number;
  maxPerSessionChars?: number;
}): SessionSummaryForPrompt[] {
  const recentDays = params.recentDays ?? DEFAULT_SESSION_SUMMARY_RECENT_DAYS;
  const maxTotalChars = params.maxTotalChars ?? DEFAULT_SESSION_SUMMARY_MAX_CHARS_TOTAL;
  const maxPerSessionChars = params.maxPerSessionChars ?? DEFAULT_SESSION_SUMMARY_MAX_CHARS_PER_SESSION;

  const historyDir = path.join(
    params.agentsDir,
    params.agentName,
    "internal_space",
    "history",
  );

  if (!fs.existsSync(historyDir)) return [];

  // Find date directories, sort descending, take last N days.
  const dateDirs = listDateDirectories(historyDir);
  const recentDateDirs = dateDirs.slice(0, recentDays);

  // Collect summaries from all selected date directories.
  const summaries: SessionSummaryForPrompt[] = [];

  for (const dateDir of recentDateDirs) {
    const dateDirPath = path.join(historyDir, dateDir);
    const sessionSummaries = readSummariesFromDateDir(
      dateDirPath,
      params.timezone,
      maxPerSessionChars,
    );
    summaries.push(...sessionSummaries);
  }

  // Sort chronologically (oldest first).
  summaries.sort((a, b) => {
    const timeA = new Date(a.startedAt).getTime();
    const timeB = new Date(b.startedAt).getTime();
    return timeA - timeB;
  });

  // Truncate total output to budget.
  return truncateSummariesToBudget(summaries, maxTotalChars);
}

// ── Format for prompt injection ──

/**
 * Render summaries as XML-tagged text for system prompt injection.
 */
export function formatSummariesForPrompt(
  summaries: SessionSummaryForPrompt[],
): string {
  if (summaries.length === 0) return "";

  const escapeXml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return summaries
    .map(
      (s) =>
        `<session id="${s.sessionId}" time="${s.startedAt}">\n${escapeXml(s.summary)}\n</session>`,
    )
    .join("\n\n");
}

// ── Internals ──

function listDateDirectories(historyDir: string): string[] {
  try {
    return fs
      .readdirSync(historyDir)
      .filter((name) => {
        if (!DATE_DIR_REGEX.test(name)) return false;
        const fullPath = path.join(historyDir, name);
        try {
          return fs.statSync(fullPath).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse(); // Most recent first.
  } catch {
    return [];
  }
}

function readSummariesFromDateDir(
  dateDirPath: string,
  timezone: string,
  maxPerSessionChars: number,
): SessionSummaryForPrompt[] {
  const results: SessionSummaryForPrompt[] = [];

  try {
    const files = fs
      .readdirSync(dateDirPath)
      .filter((name) => name.endsWith(".json"));

    for (const file of files) {
      const filePath = path.join(dateDirPath, file);
      const session = readSessionFile(filePath);
      if (!session) continue;
      if (!session.summary) continue;

      let summary = session.summary;
      if (maxPerSessionChars > 0 && summary.length > maxPerSessionChars) {
        summary = summary.slice(0, maxPerSessionChars - 1) + "…";
      }

      results.push({
        sessionId: session.sessionId,
        startedAt: formatTimestamp(session.startedAtMs, timezone),
        summary,
      });
    }
  } catch {
    // Best-effort: skip unreadable directories.
  }

  return results;
}

function formatTimestamp(unixMs: number, timezone: string): string {
  try {
    const date = new Date(unixMs);
    // Build ISO-like string with timezone offset.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);

    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? "";

    const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
    const timeStr = `${get("hour")}:${get("minute")}:${get("second")}`;

    // Get timezone offset.
    const offsetStr = getTimezoneOffsetString(date, timezone);
    return `${dateStr}T${timeStr}${offsetStr}`;
  } catch {
    return new Date(unixMs).toISOString();
  }
}

function getTimezoneOffsetString(date: Date, timezone: string): string {
  try {
    // Use Intl to get the offset.
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    if (tzPart) {
      // Format like "GMT+08:00" → "+08:00"
      const match = tzPart.value.match(/GMT([+-]\d{2}:\d{2})/);
      if (match) return match[1];
      if (tzPart.value === "GMT") return "+00:00";
    }
    return "Z";
  } catch {
    return "Z";
  }
}

function truncateSummariesToBudget(
  summaries: SessionSummaryForPrompt[],
  maxTotalChars: number,
): SessionSummaryForPrompt[] {
  const result: SessionSummaryForPrompt[] = [];
  let totalChars = 0;

  for (const s of summaries) {
    const entryChars = s.summary.length + s.sessionId.length + s.startedAt.length + 40; // Overhead for XML tags.
    if (totalChars + entryChars > maxTotalChars && result.length > 0) break;
    result.push(s);
    totalChars += entryChars;
  }

  return result;
}
