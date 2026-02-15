/**
 * Conversation history — appends every envelope to a per-session JSON file.
 *
 * Layout:
 *   {{agentsDir}}/<agent>/internal_space/history/YYYY-MM-DD/<sessionId>.json
 *
 * Each session is a self-contained JSON file with conversations array.
 * Session IDs are 8-char hex short IDs (UUID-based).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Envelope } from "../../envelope/types.js";
import { parseAddress } from "../../adapters/types.js";
import { logEvent, errorMessage } from "../../shared/daemon-log.js";
import { formatShortId } from "../../shared/id-format.js";
import type { SessionConversationEntry } from "./types.js";
import {
  createSessionFile,
  appendConversation,
  readSessionFile,
  listSessionFiles,
} from "./session-file-io.js";

export interface ConversationHistoryOptions {
  agentsDir: string;
  timezone?: string;
}

export class ConversationHistory {
  private agentsDir: string;
  private timezone: string;

  /** Current session ID per agent. */
  private activeSessionIds: Map<string, string> = new Map();
  /** Date directory string (YYYY-MM-DD) for each agent's active session. */
  private activeSessionDates: Map<string, string> = new Map();
  /** Per-agent write serialization to prevent concurrent JSON read-modify-write corruption. */
  private fileLocks: Map<string, Promise<void>> = new Map();

  constructor(options: ConversationHistoryOptions) {
    this.agentsDir = options.agentsDir;
    this.timezone = options.timezone ?? "UTC";
  }

  /**
   * Append an envelope to the relevant agent's session file.
   */
  append(envelope: Envelope): void {
    try {
      const agentName = this.resolveAgentName(envelope);
      if (!agentName) return;

      const text = envelope.content.text;
      if (!text) return;

      if (!this.activeSessionIds.has(agentName)) {
        this.ensureActiveSession(agentName);
      }

      const sessionId = this.activeSessionIds.get(agentName)!;
      const dateStr = this.activeSessionDates.get(agentName)!;
      const filePath = this.buildSessionFilePath(agentName, dateStr, sessionId);

      const isAgent = this.isFromAgent(envelope);
      const entry: SessionConversationEntry = {
        role: isAgent ? "Agent" : "User",
        text: this.stripMarkup(text),
        timestampMs: envelope.createdAt,
      };

      this.withFileLock(agentName, () => {
        appendConversation(filePath, entry);
      });
    } catch (err) {
      logEvent("error", "history-append-failed", {
        "envelope-id": envelope.id,
        error: errorMessage(err),
      });
    }
  }

  /**
   * Start a new history session for an agent. Returns the new session ID.
   * Called by the executor when creating a new session.
   */
  startSession(agentName: string): string {
    try {
      const sessionId = formatShortId(crypto.randomUUID());
      const now = Date.now();
      const dateStr = this.getDateString(now);

      const filePath = this.buildSessionFilePath(agentName, dateStr, sessionId);
      createSessionFile({
        filePath,
        sessionId,
        agentName,
        startedAtMs: now,
      });

      this.activeSessionIds.set(agentName, sessionId);
      this.activeSessionDates.set(agentName, dateStr);

      return sessionId;
    } catch (err) {
      logEvent("error", "history-session-mark-failed", {
        "agent-name": agentName,
        error: errorMessage(err),
      });
      // Return a fallback ID so callers don't crash.
      const fallbackId = formatShortId(crypto.randomUUID());
      this.activeSessionIds.set(agentName, fallbackId);
      this.activeSessionDates.set(agentName, this.getDateString(Date.now()));
      return fallbackId;
    }
  }

  /**
   * Get current session ID for an agent (null if none active).
   */
  getCurrentSessionId(agentName: string): string | null {
    return this.activeSessionIds.get(agentName) ?? null;
  }

  /**
   * Get the full file path for a session.
   */
  getSessionFilePath(agentName: string, sessionId: string, dateStr: string): string {
    return this.buildSessionFilePath(agentName, dateStr, sessionId);
  }

  /**
   * Get the file path for the current active session.
   * Returns null if no active session.
   */
  getCurrentSessionFilePath(agentName: string): string | null {
    const sessionId = this.activeSessionIds.get(agentName);
    const dateStr = this.activeSessionDates.get(agentName);
    if (!sessionId || !dateStr) return null;
    return this.buildSessionFilePath(agentName, dateStr, sessionId);
  }

  /**
   * Clear the active session tracking for an agent (after summary + close).
   */
  clearActiveSession(agentName: string): void {
    this.activeSessionIds.delete(agentName);
    this.activeSessionDates.delete(agentName);
  }

  // ── Internals ──

  private buildSessionFilePath(agentName: string, dateStr: string, sessionId: string): string {
    return path.join(
      this.agentsDir,
      agentName,
      "internal_space",
      "history",
      dateStr,
      `${sessionId}.json`,
    );
  }

  /**
   * Try to recover an existing unclosed session from disk.
   * Returns true if a session was found and tracked, false otherwise.
   * Called by the executor on session resume or before closing.
   */
  recoverSession(agentName: string): boolean {
    if (this.activeSessionIds.has(agentName)) return true;

    const historyDir = path.join(this.agentsDir, agentName, "internal_space", "history");

    try {
      if (fs.existsSync(historyDir)) {
        const dateDirs = fs
          .readdirSync(historyDir)
          .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
          .sort()
          .reverse();

        for (const dateDir of dateDirs) {
          const dateDirPath = path.join(historyDir, dateDir);
          const sessionIds = listSessionFiles(dateDirPath);
          if (sessionIds.length === 0) continue;

          let latestSession: { id: string; startedAtMs: number } | null = null;
          for (const sid of sessionIds) {
            const filePath = path.join(dateDirPath, `${sid}.json`);
            const session = readSessionFile(filePath);
            if (!session) continue;
            if (session.endedAtMs !== null) continue;
            if (!latestSession || session.startedAtMs > latestSession.startedAtMs) {
              latestSession = { id: sid, startedAtMs: session.startedAtMs };
            }
          }

          if (latestSession) {
            this.activeSessionIds.set(agentName, latestSession.id);
            this.activeSessionDates.set(agentName, dateDir);
            return true;
          }
        }
      }
    } catch (err) {
      logEvent("warn", "history-session-recover-failed", {
        "agent-name": agentName,
        error: errorMessage(err),
      });
    }

    return false;
  }

  /**
   * Ensure the agent has an active history session (recover from disk or create new).
   * Called by the executor before processing envelopes.
   */
  ensureActiveSession(agentName: string): void {
    if (!this.recoverSession(agentName)) {
      this.startSession(agentName);
    }
  }

  /**
   * Get agent names with currently active (unclosed) history sessions.
   */
  getActiveAgentNames(): string[] {
    return [...this.activeSessionIds.keys()];
  }

  /**
   * Serialize file writes for an agent to prevent concurrent read-modify-write corruption.
   */
  withFileLock(agentName: string, fn: () => void): void {
    const existing = this.fileLocks.get(agentName) ?? Promise.resolve();
    const next = existing.then(() => {
      try {
        fn();
      } catch (err) {
        logEvent("error", "history-file-lock-error", {
          "agent-name": agentName,
          error: errorMessage(err),
        });
      }
    });
    this.fileLocks.set(agentName, next);
    // Clean up the lock reference when done.
    next.then(() => {
      if (this.fileLocks.get(agentName) === next) {
        this.fileLocks.delete(agentName);
      }
    });
  }

  private resolveAgentName(envelope: Envelope): string | null {
    try {
      const to = parseAddress(envelope.to);
      if (to.type === "agent") return to.agentName;
    } catch { /* ignore */ }

    try {
      const from = parseAddress(envelope.from);
      if (from.type === "agent") return from.agentName;
    } catch { /* ignore */ }

    return null;
  }

  private isFromAgent(envelope: Envelope): boolean {
    try {
      const from = parseAddress(envelope.from);
      return from.type === "agent";
    } catch {
      return false;
    }
  }

  private stripMarkup(text: string): string {
    return text.replace(/<[^>]+>/g, "");
  }

  private getDateString(unixMs: number): string {
    const date = new Date(unixMs);
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: this.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(date);
      const y = parts.find((p) => p.type === "year")?.value ?? "";
      const m = parts.find((p) => p.type === "month")?.value ?? "";
      const d = parts.find((p) => p.type === "day")?.value ?? "";
      return `${y}-${m}-${d}`;
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }
}
