import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import type { Agent } from "../src/agent/types.js";
import type { CronSchedule } from "../src/cron/types.js";
import type { Envelope } from "../src/envelope/types.js";
import { formatEnvelopeInstruction } from "../src/cli/instructions/format-envelope.js";
import { formatUtcIsoAsLocalOffset } from "../src/shared/time.js";

// Make outputs deterministic across machines.
process.env.TZ ??= "UTC";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.resolve(__dirname, "../examples/cli");

function ensureOutputDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function clearOldExampleDocs(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".DOC.md")) continue;
    fs.rmSync(path.join(dir, entry.name));
  }
}

function writeDoc(params: {
  filename: string;
  title: string;
  command: string;
  output: string;
}): void {
  const outPath = path.join(OUTPUT_DIR, params.filename);
  const doc = [
    `# ${params.title}`,
    "",
    "```bash",
    `$ ${params.command}`,
    "```",
    "",
    "```text",
    params.output.trimEnd(),
    "```",
    "",
  ].join("\n");
  fs.writeFileSync(outPath, doc, "utf-8");
  console.log(`  ${params.filename}`);
}

function formatCronScheduleDetail(schedule: CronSchedule): string {
  function formatMaybeLocalIso(utcIso?: string): string {
    if (!utcIso) return "(none)";
    const trimmed = utcIso.trim();
    if (!trimmed) return "(none)";
    return formatUtcIsoAsLocalOffset(trimmed);
  }

  const lines: string[] = [];
  lines.push(`cron-id: ${schedule.id}`);
  lines.push(`cron: ${schedule.cron}`);
  lines.push(`timezone: ${schedule.timezone ?? "local"}`);
  lines.push(`enabled: ${schedule.enabled ? "true" : "false"}`);
  lines.push(`to: ${schedule.to}`);
  lines.push(`next-deliver-at: ${formatMaybeLocalIso(schedule.nextDeliverAt)}`);
  lines.push(`pending-envelope-id: ${schedule.pendingEnvelopeId ?? "(none)"}`);
  lines.push(`created-at: ${formatMaybeLocalIso(schedule.createdAt)}`);
  if (schedule.updatedAt) {
    lines.push(`updated-at: ${formatMaybeLocalIso(schedule.updatedAt)}`);
  }

  const md = schedule.metadata;
  if (md && typeof md === "object") {
    const parseMode = (md as Record<string, unknown>).parseMode;
    if (typeof parseMode === "string" && parseMode.trim()) {
      lines.push(`parse-mode: ${parseMode.trim()}`);
    }
  }

  lines.push("text:");
  lines.push(schedule.content.text?.trimEnd() ? schedule.content.text.trimEnd() : "(none)");

  const attachments = schedule.content.attachments ?? [];
  if (attachments.length > 0) {
    lines.push("attachments:");
    for (const att of attachments) {
      lines.push(`- ${att.source}`);
    }
  }

  return lines.join("\n");
}

type AgentListItem = Omit<Agent, "token"> & { bindings: string[] };

function formatAgentListBlock(agent: AgentListItem): string {
  const lines: string[] = [];
  lines.push(`name: ${agent.name}`);
  if (agent.description) {
    lines.push(`description: ${agent.description}`);
  }
  if (agent.workspace) {
    lines.push(`workspace: ${agent.workspace}`);
  }
  if (agent.model) {
    lines.push(`model: ${agent.model}`);
  }
  if (agent.reasoningEffort) {
    lines.push(`reasoning-effort: ${agent.reasoningEffort}`);
  }
  if (agent.sessionPolicy && typeof agent.sessionPolicy === "object") {
    if (typeof agent.sessionPolicy.dailyResetAt === "string") {
      lines.push(`session-daily-reset-at: ${agent.sessionPolicy.dailyResetAt}`);
    }
    if (typeof agent.sessionPolicy.idleTimeout === "string") {
      lines.push(`session-idle-timeout: ${agent.sessionPolicy.idleTimeout}`);
    }
    if (typeof agent.sessionPolicy.maxContextLength === "number") {
      lines.push(`session-max-context-length: ${agent.sessionPolicy.maxContextLength}`);
    }
  }
  lines.push(`created-at: ${formatUtcIsoAsLocalOffset(agent.createdAt)}`);
  return lines.join("\n");
}

function formatMemoryItem(item: {
  id: string;
  category: string;
  createdAt: string;
  text: string;
}): string {
  return [
    `id: ${item.id}`,
    `category: ${item.category}`,
    `created-at: ${item.createdAt}`,
    `text-json: ${JSON.stringify(item.text)}`,
  ].join("\n");
}

ensureOutputDir(OUTPUT_DIR);
clearOldExampleDocs(OUTPUT_DIR);

console.log("Generating CLI command output examples...");

// =============================================================================
// hiboss envelope list
// =============================================================================

{
  const envelopes: Envelope[] = [
    {
      id: "env_01HZYZQ3VJ3E1S7TQ3Y5H0B4K1",
      from: "channel:telegram:-100123456789",
      to: "agent:nex",
      fromBoss: true,
      status: "pending",
      createdAt: "2026-01-29T09:00:00.000Z",
      content: {
        text: "@nex can you post the latest build status?",
        attachments: [],
      },
      metadata: {
        platform: "telegram",
        channelMessageId: "4001",
        author: { id: "u-123", username: "kky1024", displayName: "Kevin" },
        chat: { id: "-100123456789", name: "Project X Dev" },
      },
    },
    {
      id: "env_01HZYZQ4M2FZKQ1H6V5Q0YJ4P7",
      from: "channel:telegram:-100123456789",
      to: "agent:nex",
      fromBoss: false,
      status: "pending",
      createdAt: "2026-01-29T09:15:00.000Z",
      content: {
        text: "@nex what's the ETA on the feature? (need it for the weekly update)",
        attachments: [],
      },
      metadata: {
        platform: "telegram",
        channelMessageId: "4002",
        author: { id: "u-456", username: "alice_dev", displayName: "Alice" },
        chat: { id: "-100123456789", name: "Project X Dev" },
      },
    },
  ];

  const output = envelopes
    .map((env) => formatEnvelopeInstruction(env))
    .join("\n\n")
    .trimEnd();

  writeDoc({
    filename: "envelope_list.DOC.md",
    title: "hiboss envelope list",
    command: "hiboss envelope list --from channel:telegram:-100123456789 --status pending",
    output,
  });
}

// =============================================================================
// hiboss cron list
// =============================================================================

{
  const schedules: CronSchedule[] = [
    {
      id: "cron_01HZYZQ8PRV0XG5E5FZ9PS1WQK",
      agentName: "nex",
      cron: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
      enabled: true,
      to: "agent:nex",
      content: {
        text: "Daily standup reminder: post your update in #team.",
        attachments: [],
      },
      metadata: { parseMode: "plain" },
      pendingEnvelopeId: "env_01HZYZQ9J9Q0F1D8Y5Y0S8E2VT",
      nextDeliverAt: "2026-01-30T17:00:00.000Z",
      createdAt: "2026-01-15T10:30:00.000Z",
      updatedAt: "2026-01-20T08:12:00.000Z",
    },
    {
      id: "cron_01HZYZQB3K5P3JX0G1NQH1X5QG",
      agentName: "nex",
      cron: "@daily",
      enabled: false,
      to: "channel:telegram:-100123456789",
      content: {
        text: "Post the daily build status.",
        attachments: [{ source: "/home/user/reports/build-status.txt", filename: "build-status.txt" }],
      },
      createdAt: "2026-01-10T11:00:00.000Z",
    },
  ];

  const output = schedules.map((s) => formatCronScheduleDetail(s)).join("\n\n").trimEnd();

  writeDoc({
    filename: "cron_list.DOC.md",
    title: "hiboss cron list",
    command: "hiboss cron list",
    output,
  });
}

// =============================================================================
// hiboss memory categories
// =============================================================================

{
  const categories = ["fact", "preference", "project", "contact"];
  const output = [`count: ${categories.length}`, ...categories.map((c) => `category: ${c}`)].join("\n");

  writeDoc({
    filename: "memory_categories.DOC.md",
    title: "hiboss memory categories",
    command: "hiboss memory categories",
    output,
  });
}

// =============================================================================
// hiboss memory list
// =============================================================================

{
  const memories = [
    {
      id: "mem_01HZYZR0V7NY9J3GNN17B7K5Q9",
      category: "project",
      createdAt: "2026-01-22T18:05:11.123Z",
      text: "Project X: shipping target is Feb 15; prioritize reliability fixes.",
    },
    {
      id: "mem_01HZYZR2D1Q1E8Q9FZ8Q1S6F3N",
      category: "preference",
      createdAt: "2026-01-25T03:41:02.000Z",
      text: "Kevin prefers short weekly status updates with bullets and owners.",
    },
  ];

  const output = [
    `count: ${memories.length}`,
    ...memories.map((m) => formatMemoryItem(m)),
  ].join("\n");

  writeDoc({
    filename: "memory_list.DOC.md",
    title: "hiboss memory list",
    command: "hiboss memory list --limit 2",
    output,
  });
}

// =============================================================================
// hiboss agent list
// =============================================================================

{
  const agents: AgentListItem[] = [
    {
      name: "nex",
      description: "AI assistant for project management",
      workspace: "/home/user/projects/myapp",
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      reasoningEffort: "medium",
      permissionLevel: "standard",
      sessionPolicy: { dailyResetAt: "03:00", idleTimeout: "30m", maxContextLength: 180000 },
      createdAt: "2026-01-15T10:30:00.000Z",
      lastSeenAt: "2026-01-29T14:22:00.000Z",
      bindings: ["telegram"],
      metadata: {},
    },
    {
      name: "scheduler",
      description: "Background scheduler",
      provider: "codex",
      permissionLevel: "privileged",
      createdAt: "2026-01-10T09:00:00.000Z",
      bindings: [],
      metadata: {},
    },
  ];

  const output = agents.map((a) => formatAgentListBlock(a)).join("\n\n").trimEnd();

  writeDoc({
    filename: "agent_list.DOC.md",
    title: "hiboss agent list",
    command: "hiboss agent list",
    output,
  });
}

console.log("\n---");
console.log("Generated 5 CLI output examples");
