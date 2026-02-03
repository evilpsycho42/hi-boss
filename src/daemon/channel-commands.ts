import type { ChannelCommand, ChannelCommandHandler, MessageContent } from "../adapters/types.js";
import type { HiBossDatabase } from "./db/database.js";
import type { AgentExecutor } from "../agent/executor.js";
import {
  DEFAULT_AGENT_AUTO_LEVEL,
  DEFAULT_AGENT_PERMISSION_LEVEL,
  DEFAULT_AGENT_PROVIDER,
} from "../shared/defaults.js";
import { formatUtcIsoAsLocalOffset } from "../shared/time.js";

type EnrichedChannelCommand = ChannelCommand & { agentName?: string };

function formatMsAsLocalOffset(ms: number): string {
  return formatUtcIsoAsLocalOffset(new Date(ms).toISOString());
}

function buildAgentStatusText(params: { db: HiBossDatabase; executor: AgentExecutor; agentName: string }): string {
  const agent = params.db.getAgentByNameCaseInsensitive(params.agentName);
  if (!agent) {
    return "error: Agent not found";
  }

  const effectiveProvider = agent.provider ?? DEFAULT_AGENT_PROVIDER;
  const effectiveAutoLevel = agent.autoLevel ?? DEFAULT_AGENT_AUTO_LEVEL;
  const effectivePermissionLevel = agent.permissionLevel ?? DEFAULT_AGENT_PERMISSION_LEVEL;
  const effectiveWorkspace = agent.workspace ?? process.cwd();

  const isBusy = params.executor.isAgentBusy(agent.name);
  const pendingCount = params.db.countDuePendingEnvelopesForAgent(agent.name);
  const bindings = params.db.getBindingsByAgentName(agent.name).map((b) => b.adapterType);

  const currentRun = isBusy ? params.db.getCurrentRunningAgentRun(agent.name) : null;
  const lastRun = params.db.getLastFinishedAgentRun(agent.name);

  const lines: string[] = [];
  lines.push(`name: ${agent.name}`);
  lines.push(`workspace: ${effectiveWorkspace}`);
  lines.push(`provider: ${effectiveProvider}`);
  lines.push(`model: ${agent.model ?? "default"}`);
  lines.push(`reasoning-effort: ${agent.reasoningEffort ?? "default"}`);
  lines.push(`auto-level: ${effectiveAutoLevel}`);
  lines.push(`permission-level: ${effectivePermissionLevel}`);
  if (bindings.length > 0) {
    lines.push(`bindings: ${bindings.join(", ")}`);
  }

  const agentState = isBusy ? "running" : "idle";
  const agentHealth = !lastRun ? "unknown" : lastRun.status === "failed" ? "error" : "ok";

  lines.push(`agent-state: ${agentState}`);
  lines.push(`agent-health: ${agentHealth}`);
  lines.push(`pending-count: ${pendingCount}`);

  if (currentRun) {
    lines.push(`current-run-id: ${currentRun.id}`);
    lines.push(`current-run-started-at: ${formatMsAsLocalOffset(currentRun.startedAt)}`);
  }

  if (!lastRun) {
    lines.push("last-run-status: none");
    return lines.join("\n");
  }

  lines.push(`last-run-id: ${lastRun.id}`);
  lines.push(`last-run-status: ${lastRun.status === "failed" ? "failed" : "completed"}`);
  lines.push(`last-run-started-at: ${formatMsAsLocalOffset(lastRun.startedAt)}`);
  if (typeof lastRun.completedAt === "number") {
    lines.push(`last-run-completed-at: ${formatMsAsLocalOffset(lastRun.completedAt)}`);
  }
  if (typeof lastRun.contextLength === "number") {
    lines.push(`last-run-context-length: ${lastRun.contextLength}`);
  }
  if (lastRun.status === "failed" && lastRun.error) {
    lines.push(`last-run-error: ${lastRun.error}`);
  }

  return lines.join("\n");
}

export function createChannelCommandHandler(params: {
  db: HiBossDatabase;
  executor: AgentExecutor;
}): ChannelCommandHandler {
  return (command): MessageContent | void => {
    const c = command as EnrichedChannelCommand;
    if (typeof c.command !== "string") return;

    if (c.command === "new" && typeof c.agentName === "string" && c.agentName) {
      params.executor.requestSessionRefresh(c.agentName, "telegram:/new");
      return { text: "Session refresh requested." };
    }

    if (c.command === "status" && typeof c.agentName === "string" && c.agentName) {
      return { text: buildAgentStatusText({ db: params.db, executor: params.executor, agentName: c.agentName }) };
    }
  };
}

