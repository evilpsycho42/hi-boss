import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderTraceEntry } from "../agent/provider-cli-parsers.js";
import { INTERNAL_VERSION } from "./version.js";

const AGENT_RUN_TRACE_VERSION = INTERNAL_VERSION;

export interface AgentRunTraceRecord {
  version: typeof AGENT_RUN_TRACE_VERSION;
  runId: string;
  agentName: string;
  provider: "claude" | "codex";
  status: "running" | "success" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number;
  error?: string;
  entries: ProviderTraceEntry[];
}

function getTraceDir(hibossDir: string): string {
  return path.join(hibossDir, ".daemon", "agent_run_traces");
}

function getTracePath(hibossDir: string, runId: string): string {
  return path.join(getTraceDir(hibossDir), `${runId}.json`);
}

export function writeAgentRunTrace(hibossDir: string, record: AgentRunTraceRecord): void {
  const traceDir = getTraceDir(hibossDir);
  fs.mkdirSync(traceDir, { recursive: true });
  fs.writeFileSync(getTracePath(hibossDir, record.runId), JSON.stringify(record), "utf8");
}

export function readAgentRunTrace(hibossDir: string, runId: string): AgentRunTraceRecord | null {
  const tracePath = getTracePath(hibossDir, runId);
  if (!fs.existsSync(tracePath)) return null;

  try {
    const raw = fs.readFileSync(tracePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== AGENT_RUN_TRACE_VERSION ||
      typeof rec.runId !== "string" ||
      typeof rec.agentName !== "string" ||
      (rec.provider !== "claude" && rec.provider !== "codex") ||
      (rec.status !== "running" &&
        rec.status !== "success" &&
        rec.status !== "failed" &&
        rec.status !== "cancelled") ||
      typeof rec.startedAt !== "number" ||
      typeof rec.completedAt !== "number" ||
      !Array.isArray(rec.entries)
    ) {
      return null;
    }

    const entries: ProviderTraceEntry[] = rec.entries
      .map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
        const row = item as Record<string, unknown>;
        if ((row.type !== "assistant" && row.type !== "tool-call") || typeof row.text !== "string") return null;
        const out: ProviderTraceEntry = {
          type: row.type,
          text: row.text,
          ...(typeof row.toolName === "string" && row.toolName ? { toolName: row.toolName } : {}),
        };
        return out;
      })
      .filter((item): item is ProviderTraceEntry => item !== null);

    return {
      version: AGENT_RUN_TRACE_VERSION,
      runId: rec.runId,
      agentName: rec.agentName,
      provider: rec.provider,
      status: rec.status,
      startedAt: rec.startedAt,
      completedAt: rec.completedAt,
      ...(typeof rec.error === "string" && rec.error ? { error: rec.error } : {}),
      entries,
    };
  } catch {
    return null;
  }
}
