import type { SessionHandle } from "@unified-agent-sdk/runtime";
import type { HiBossDatabase } from "../daemon/db/database.js";
import type { Agent } from "./types.js";

const AGENT_PERSISTED_SESSION_KEY = "sessionHandle";

export type PersistedAgentSessionV1 = {
  version: 1;
  provider: "claude" | "codex";
  handle: SessionHandle;
  createdAtMs: number;
  lastRunCompletedAtMs?: number;
  updatedAtMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseSessionHandle(value: unknown): SessionHandle | null {
  if (!isRecord(value)) return null;
  if (typeof value.provider !== "string" || !value.provider) return null;

  const handle: SessionHandle = { provider: value.provider as SessionHandle["provider"] };

  if (typeof value.sessionId === "string" && value.sessionId.trim()) {
    handle.sessionId = value.sessionId.trim();
  }

  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) return null;
    handle.metadata = value.metadata;
  }

  return handle;
}

export function readPersistedAgentSession(agent: Agent): PersistedAgentSessionV1 | null {
  if (!isRecord(agent.metadata)) return null;
  const raw = agent.metadata[AGENT_PERSISTED_SESSION_KEY];
  if (!isRecord(raw) || raw.version !== 1) return null;

  if (raw.provider !== "claude" && raw.provider !== "codex") return null;
  if (typeof raw.createdAtMs !== "number" || !Number.isFinite(raw.createdAtMs)) return null;
  if (typeof raw.updatedAtMs !== "number" || !Number.isFinite(raw.updatedAtMs)) return null;
  if (raw.lastRunCompletedAtMs !== undefined) {
    if (typeof raw.lastRunCompletedAtMs !== "number" || !Number.isFinite(raw.lastRunCompletedAtMs)) return null;
  }

  const handle = parseSessionHandle(raw.handle);
  if (!handle) return null;

  return {
    version: 1,
    provider: raw.provider,
    handle,
    createdAtMs: raw.createdAtMs,
    lastRunCompletedAtMs: raw.lastRunCompletedAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

export function writePersistedAgentSession(
  db: HiBossDatabase,
  agentName: string,
  session: PersistedAgentSessionV1 | null
): void {
  if (session) {
    db.setAgentMetadataSessionHandle(agentName, session);
  } else {
    db.setAgentMetadataSessionHandle(agentName, null);
  }
}
