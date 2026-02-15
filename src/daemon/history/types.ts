/**
 * Session history types — per-session JSON file schema.
 *
 * Layout:
 *   {{agentsDir}}/<agent>/internal_space/history/YYYY-MM-DD/<sessionId>.json
 */

export const SESSION_FILE_VERSION = 1 as const;

export interface SessionConversationEntry {
  role: "User" | "Agent";
  text: string;
  timestampMs: number;
}

export interface SessionFile {
  version: typeof SESSION_FILE_VERSION;
  sessionId: string;
  agentName: string;
  startedAtMs: number;
  endedAtMs: number | null;
  summary: string | null;
  conversations: SessionConversationEntry[];
}
