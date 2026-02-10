import type { HiBossDatabase } from "../daemon/db/database.js";
import type { ChildProcess } from "node:child_process";

export interface AgentSession {
  provider: "claude" | "codex";
  agentToken: string;
  systemInstructions: string;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  /** CLI child process for the current run (set during executeCliTurn). */
  childProcess?: ChildProcess;
  /** Session ID for resume: session_id (Claude) or thread_id (Codex). */
  sessionId?: string;
  createdAtMs: number;
  lastRunCompletedAtMs?: number;
  /**
   * Codex `turn.completed.usage` values are cumulative across the session thread.
   * Store the last observed cumulative totals so we can compute per-turn deltas.
   */
  codexCumulativeUsageTotals?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
}

export interface SessionRefreshRequest {
  requestedAtMs: number;
  reasons: string[];
}

export type TurnTokenUsage = {
  contextLength: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readTokenUsage(usageRaw: unknown): TurnTokenUsage {
  const usage = (usageRaw ?? {}) as Record<string, unknown>;
  const inputTokens = asFiniteNumber(usage.input_tokens);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  const cacheReadTokens = asFiniteNumber(usage.cache_read_tokens);
  const cacheWriteTokens = asFiniteNumber(usage.cache_write_tokens);
  const contextLength = asFiniteNumber(usage.context_length);
  const totalTokens = asFiniteNumber(usage.total_tokens);
  return { contextLength, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens };
}

export function getBossInfo(
  db: HiBossDatabase | null,
  bindings: { adapterType: string }[]
): { name?: string; adapterIds?: Record<string, string> } | undefined {
  if (!db) return undefined;

  const name = db.getBossName() ?? undefined;
  const adapterIds: Record<string, string> = {};

  // Get boss ID for each bound adapter type
  for (const binding of bindings) {
    const bossId = db.getAdapterBossId(binding.adapterType);
    if (bossId) {
      adapterIds[binding.adapterType] = bossId;
    }
  }

  return { name, adapterIds };
}

export async function queueAgentTask(params: {
  agentLocks: Map<string, Promise<void>>;
  agentName: string;
  log: (message: string) => void;
  task: () => Promise<void>;
}): Promise<void> {
  const existingTail = params.agentLocks.get(params.agentName);
  if (existingTail) {
    params.log(`Queued task behind existing run of ${params.agentName}`);
  }

  const previous = (existingTail ?? Promise.resolve()).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    params.log(`Previous task/run of ${params.agentName} failed; continuing queue: ${message}`);
  });

  let current: Promise<void>;
  current = previous
    .then(params.task)
    .finally(() => {
      if (params.agentLocks.get(params.agentName) === current) {
        params.agentLocks.delete(params.agentName);
      }
    });

  params.agentLocks.set(params.agentName, current);
  return current;
}

export function getMostRecentDailyResetBoundaryMs(
  now: Date,
  dailyResetAt: { hour: number; minute: number }
): number {
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    dailyResetAt.hour,
    dailyResetAt.minute,
    0,
    0
  );

  if (now.getTime() >= candidate.getTime()) {
    return candidate.getTime();
  }

  // Use yesterday's reset time.
  candidate.setDate(candidate.getDate() - 1);
  return candidate.getTime();
}

export function getRefreshReasonForPolicy(
  session: AgentSession,
  policy: { dailyResetAt?: { hour: number; minute: number; normalized: string }; idleTimeoutMs?: number },
  now: Date
): string | null {
  if (policy.dailyResetAt) {
    const boundaryMs = getMostRecentDailyResetBoundaryMs(now, policy.dailyResetAt);
    if (session.createdAtMs < boundaryMs) {
      return `daily-reset-at:${policy.dailyResetAt.normalized}`;
    }
  }

  if (typeof policy.idleTimeoutMs === "number") {
    const lastActiveMs = session.lastRunCompletedAtMs ?? session.createdAtMs;
    if (now.getTime() - lastActiveMs > policy.idleTimeoutMs) {
      return `idle-timeout-ms:${policy.idleTimeoutMs}`;
    }
  }

  return null;
}
