import type { ChannelCommandResponse } from "../adapters/types.js";
import { formatShortId } from "../shared/id-format.js";
import { formatUnixMsAsTimeZoneOffset } from "../shared/time.js";
import { readAgentRunTrace } from "../shared/agent-run-trace.js";
import type { getUiText } from "../shared/ui-text.js";
import type { HiBossDatabase } from "./db/database.js";

function clipText(raw: string, max = 320): string {
  if (raw.length <= max) return raw;
  return `${raw.slice(0, Math.max(1, max - 3))}...`;
}

export function handleTraceCommand(params: {
  db: HiBossDatabase;
  hibossDir?: string;
  agentName: string;
  args?: string;
  ui: ReturnType<typeof getUiText>;
}): ChannelCommandResponse {
  const rawArgs = (params.args ?? "").trim();
  if (rawArgs) {
    return { text: params.ui.channel.traceUsage };
  }

  const running = params.db.getCurrentRunningAgentRun(params.agentName);
  const run = running ?? params.db.getLastFinishedAgentRun(params.agentName);
  if (!run) {
    return {
      text: [
        "trace: none",
        `agent-name: ${params.agentName}`,
      ].join("\n"),
    };
  }

  if (running) {
    if (!params.hibossDir) {
      return {
        text: [
          "trace: pending",
          `agent-name: ${params.agentName}`,
          `run-id: ${formatShortId(run.id)}`,
          "reason: run-in-progress",
        ].join("\n"),
      };
    }

    const liveTrace = readAgentRunTrace(params.hibossDir, run.id);
    if (!liveTrace || liveTrace.entries.length === 0) {
      return {
        text: [
          "trace: pending",
          `agent-name: ${params.agentName}`,
          `run-id: ${formatShortId(run.id)}`,
          "reason: run-in-progress",
        ].join("\n"),
      };
    }

    const tz = params.db.getBossTimezone();
    const lines: string[] = [];
    lines.push("trace: pending");
    lines.push(`agent-name: ${params.agentName}`);
    lines.push(`run-id: ${formatShortId(run.id)}`);
    lines.push(`provider: ${liveTrace.provider}`);
    lines.push(`status: ${liveTrace.status}`);
    lines.push(`started-at: ${formatUnixMsAsTimeZoneOffset(liveTrace.startedAt, tz)}`);
    lines.push(`updated-at: ${formatUnixMsAsTimeZoneOffset(liveTrace.completedAt, tz)}`);
    lines.push(`entry-count: ${liveTrace.entries.length}`);
    const maxEntries = 20;
    const shown = liveTrace.entries.slice(-maxEntries);
    lines.push(`entries-displayed: ${shown.length}`);
    lines.push(`entries-truncated: ${liveTrace.entries.length > shown.length ? "true" : "false"}`);

    for (let index = 0; index < shown.length; index++) {
      const item = shown[index]!;
      const n = index + 1;
      lines.push(`entry-${n}-type: ${item.type}`);
      if (item.type === "tool-call") {
        lines.push(`entry-${n}-tool: ${item.toolName ?? "unknown"}`);
      }
      lines.push(`entry-${n}-text: ${clipText(item.text, 380)}`);
    }

    return { text: lines.join("\n") };
  }

  if (!params.hibossDir) {
    return {
      text: [
        "trace: unavailable",
        `agent-name: ${params.agentName}`,
        `run-id: ${formatShortId(run.id)}`,
        "reason: missing-hiboss-dir",
      ].join("\n"),
    };
  }

  const trace = readAgentRunTrace(params.hibossDir, run.id);
  if (!trace) {
    return {
      text: [
        "trace: unavailable",
        `agent-name: ${params.agentName}`,
        `run-id: ${formatShortId(run.id)}`,
        "reason: trace-not-found",
      ].join("\n"),
    };
  }

  const tz = params.db.getBossTimezone();
  const lines: string[] = [];
  lines.push("trace: ok");
  lines.push(`agent-name: ${params.agentName}`);
  lines.push(`run-id: ${formatShortId(run.id)}`);
  lines.push(`provider: ${trace.provider}`);
  lines.push(`status: ${trace.status}`);
  lines.push(`started-at: ${formatUnixMsAsTimeZoneOffset(trace.startedAt, tz)}`);
  lines.push(`completed-at: ${formatUnixMsAsTimeZoneOffset(trace.completedAt, tz)}`);
  lines.push(`entry-count: ${trace.entries.length}`);
  const maxEntries = 20;
  const shown = trace.entries.slice(-maxEntries);
  lines.push(`entries-displayed: ${shown.length}`);
  lines.push(`entries-truncated: ${trace.entries.length > shown.length ? "true" : "false"}`);
  if (trace.error) {
    lines.push(`run-error: ${clipText(trace.error, 380)}`);
  }

  for (let index = 0; index < shown.length; index++) {
    const item = shown[index]!;
    const n = index + 1;
    lines.push(`entry-${n}-type: ${item.type}`);
    if (item.type === "tool-call") {
      lines.push(`entry-${n}-tool: ${item.toolName ?? "unknown"}`);
    }
    lines.push(`entry-${n}-text: ${clipText(item.text, 380)}`);
  }

  return { text: lines.join("\n") };
}
