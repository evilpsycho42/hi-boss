import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { SCHEMA_SQL } from "../../src/daemon/db/schema.js";
import { hashToken } from "../../src/agent/auth.js";
import { Daemon } from "../../src/daemon/daemon.js";
import { isSocketAcceptingConnections } from "../../src/daemon/pid-lock.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");

export interface ExampleFixture {
  homeDir: string;
  hibossDir: string;
  bossToken: string;
  agentToken: string;
  cleanup(): void;
}

export interface ExamplesDaemonHandle {
  daemon: Daemon;
  stop(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startExamplesDaemon(hibossDir: string): Promise<ExamplesDaemonHandle> {
  const prev = process.env.HIBOSS_DAEMON_MODE;
  process.env.HIBOSS_DAEMON_MODE = "examples";

  const daemonDir = path.join(hibossDir, ".daemon");
  const daemon = new Daemon({ dataDir: hibossDir, daemonDir });
  await daemon.start();

  const socketPath = path.join(daemonDir, "daemon.sock");
  const deadline = Date.now() + 5_000;
  let ok = false;
  while (Date.now() < deadline) {
    if (await isSocketAcceptingConnections(socketPath)) {
      ok = true;
      break;
    }
    await sleep(50);
  }
  if (!ok) {
    await daemon.stop().catch(() => undefined);
    if (prev === undefined) delete process.env.HIBOSS_DAEMON_MODE;
    else process.env.HIBOSS_DAEMON_MODE = prev;
    throw new Error("Timed out waiting for daemon socket");
  }

  return {
    daemon,
    async stop() {
      await daemon.stop();
      if (prev === undefined) delete process.env.HIBOSS_DAEMON_MODE;
      else process.env.HIBOSS_DAEMON_MODE = prev;
    },
  };
}

export function runHibossCli(params: {
  homeDir: string;
  token: string;
  args: string[];
}): Promise<{ stdout: string; stderr: string; status: number }> {
  const tsxPath = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
  const cliEntry = path.join(REPO_ROOT, "bin", "hiboss.ts");

  return new Promise((resolve) => {
    const child = spawn(tsxPath, [cliEntry, ...params.args], {
      env: {
        ...process.env,
        HOME: params.homeDir,
        HIBOSS_TOKEN: params.token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, status: code ?? 0 });
    });
  });
}

export async function createExampleFixture(): Promise<ExampleFixture> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-examples-"));
  const hibossDir = path.join(homeDir, "hiboss");
  const daemonDir = path.join(hibossDir, ".daemon");
  fs.mkdirSync(daemonDir, { recursive: true });

  const bossToken = "boss_example_token_for_docs";
  const agentToken = "agt_example_token_for_docs";

  // Customization file placeholders (created empty by setup; not rendered in the minimal system prompt).
  fs.writeFileSync(path.join(hibossDir, "BOSS.md"), "", "utf-8");
  const agentHome = path.join(hibossDir, "agents", "nex");
  fs.mkdirSync(agentHome, { recursive: true });
  fs.writeFileSync(path.join(agentHome, "SOUL.md"), "", "utf-8");
  const internalSpaceDir = path.join(agentHome, "internal_space");
  fs.mkdirSync(internalSpaceDir, { recursive: true });
  // Keep this high-signal + plain text: the system prompt auto-injects this snapshot (may be truncated).
  fs.writeFileSync(
    path.join(internalSpaceDir, "MEMORY.md"),
    [
      "boss-preference:",
      "- concise, pragmatic replies",
      "- default to plain text; use --parse-mode html for long/structured messages",
      "",
      "boss-constraint:",
      "- never leak tokens/keys or sensitive boss info to non-boss users",
      "- do not modify files outside workspace/internal workspace",
    ].join("\n") + "\n",
    "utf-8"
  );

  const dailyDir = path.join(internalSpaceDir, "memories");
  fs.mkdirSync(dailyDir, { recursive: true });
  fs.writeFileSync(
    path.join(dailyDir, "2026-01-28.md"),
    ["Project X: weekly update due Friday 5pm PT.", "Use --parse-mode html for long messages."].join("\n") + "\n",
    "utf-8"
  );
  fs.writeFileSync(
    path.join(dailyDir, "2026-01-29.md"),
    ["Post the latest build status to the Project X Dev group.", "Follow up with Alice about the weekly update."].join("\n") + "\n",
    "utf-8"
  );

  // Seed SQLite
  const dbPath = path.join(daemonDir, "hiboss.db");
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);

  const CRON_ID_1 = "2c3c9c2f-9e8b-4f8a-9b8f-9e8a0f1a2b3c";
  const CRON_ID_2 = "48b4a1d0-6d6a-4d4b-9c7f-2d9d2f3a4b5c";
  const PENDING_ENV_CRON_1 = "9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
  const BINDING_ID_1 = "f0e1d2c3-b4a5-4f6e-8d7c-9b0a1c2d3e4f";

  const upsertConfig = db.prepare(
    `INSERT INTO config (key, value, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  const cfgTime = Date.parse("2026-01-01T00:00:00.000Z");
  upsertConfig.run("setup_completed", "true", cfgTime);
  upsertConfig.run("boss_token_hash", hashToken(bossToken), cfgTime);
  upsertConfig.run("boss_name", "Kevin", cfgTime);
  upsertConfig.run("boss_timezone", "Asia/Shanghai", cfgTime);
  upsertConfig.run("adapter_boss_id_telegram", "@kky1024", cfgTime);

  const insertAgent = db.prepare(
    `INSERT INTO agents
     (name, token, description, workspace, provider, model, reasoning_effort, permission_level, session_policy, created_at, last_seen_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  insertAgent.run(
    "nex",
    agentToken,
    "AI assistant for project management",
    "/home/user/projects/myapp",
    "claude",
    "claude-sonnet-4-20250514",
    "medium",
    "restricted",
    JSON.stringify({ dailyResetAt: "03:00", idleTimeout: "30m", maxContextLength: 180000 }),
    Date.parse("2026-01-15T10:30:00.000Z"),
    Date.parse("2026-01-29T14:22:00.000Z"),
    JSON.stringify({ role: "speaker" })
  );

  insertAgent.run(
    "scheduler",
    "agt_example_scheduler_token",
    "Background scheduler",
    null,
    "codex",
    null,
    "medium",
    "restricted",
    null,
    Date.parse("2026-01-10T09:00:00.000Z"),
    null,
    JSON.stringify({ role: "leader" })
  );

  const insertBinding = db.prepare(
    `INSERT INTO agent_bindings (id, agent_name, adapter_type, adapter_token, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  insertBinding.run(
    BINDING_ID_1,
    "nex",
    "telegram",
    "telegram_bot_token_example",
    Date.parse("2026-01-15T11:00:00.000Z")
  );

  const insertEnvelope = db.prepare(
    `INSERT INTO envelopes
     (id, "from", "to", from_boss, content_text, content_attachments, deliver_at, status, created_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Three pending group messages in the same Telegram group (used by envelope list + turn prompt)
  insertEnvelope.run(
    "a0b1c2d3-0000-4000-8000-000000000001",
    "channel:telegram:-100123456789",
    "agent:nex",
    1,
    "@nex can you post the latest build status?",
    null,
    null,
    "pending",
    Date.parse("2026-01-29T09:00:00.000Z"),
    JSON.stringify({
      platform: "telegram",
      channelMessageId: "335",
      author: { id: "u-123", username: "kky1024", displayName: "Kevin" },
      chat: { id: "-100123456789", name: "Project X Dev" },
    })
  );
  insertEnvelope.run(
    "b1c2d3e4-0000-4000-8000-000000000002",
    "channel:telegram:-100123456789",
    "agent:nex",
    0,
    "@nex what's the ETA on the feature? (need it for the weekly update)",
    JSON.stringify([
      { source: "/home/user/downloads/feature-scope.png", filename: "feature-scope.png" },
      { source: "/home/user/downloads/eta-notes.txt", filename: "eta-notes.txt" },
    ]),
    null,
    "pending",
    Date.parse("2026-01-29T09:15:00.000Z"),
    JSON.stringify({
      platform: "telegram",
      channelMessageId: "336",
      author: { id: "u-456", username: "alice_dev", displayName: "Alice" },
      chat: { id: "-100123456789", name: "Project X Dev" },
    })
  );
  insertEnvelope.run(
    "c2d3e4f5-0000-4000-8000-000000000003",
    "channel:telegram:-100123456789",
    "agent:nex",
    0,
    "@nex FYI: I pushed the latest screenshots to the shared drive.",
    null,
    null,
    "pending",
    Date.parse("2026-01-29T09:30:00.000Z"),
    JSON.stringify({
      platform: "telegram",
      channelMessageId: "337",
      author: { id: "u-789", username: "bob_pm", displayName: "Bob" },
      chat: { id: "-100123456789", name: "Project X Dev" },
    })
  );

  // One pending group message from a different Telegram group (used by turn prompt)
  insertEnvelope.run(
    "d3e4f5a6-0000-4000-8000-000000000004",
    "channel:telegram:-100987654321",
    "agent:nex",
    0,
    "@nex can you check the deploy status for staging?",
    null,
    null,
    "pending",
    Date.parse("2026-01-29T09:20:00.000Z"),
    JSON.stringify({
      platform: "telegram",
      channelMessageId: "444",
      author: { id: "u-999", username: "eve_ops", displayName: "Eve" },
      chat: { id: "-100987654321", name: "Infra Ops" },
    })
  );

  // Direct boss message (used by envelope prompt examples)
  insertEnvelope.run(
    "e4f5a6b7-0000-4000-8000-000000000005",
    "channel:telegram:789012",
    "agent:nex",
    1,
    "Can you summarize the meeting notes from yesterday?",
    JSON.stringify([
      { source: "/home/user/downloads/meeting-notes.pdf", filename: "meeting-notes.pdf" },
      { source: "/home/user/downloads/action-items.md", filename: "action-items.md" },
      { source: "/home/user/downloads/diagram.png", filename: "diagram.png" },
    ]),
    null,
    "pending",
    Date.parse("2026-01-29T09:00:00.000Z"),
    JSON.stringify({
      platform: "telegram",
      channelMessageId: "3001",
      author: { id: "u-123", username: "kky1024", displayName: "Kevin" },
      chat: { id: "789012" },
    })
  );

  // Agent-to-agent message (used by envelope prompt examples + turn prompt)
  insertEnvelope.run(
    "f5a6b7c8-0000-4000-8000-000000000006",
    "agent:scheduler",
    "agent:nex",
    0,
    "Reminder: Review the PR as requested by Kevin.",
    JSON.stringify([
      { source: "/home/user/projects/myapp/pr-247.patch", filename: "pr-247.patch" },
      { source: "/home/user/projects/myapp/ci-log.txt", filename: "ci-log.txt" },
    ]),
    null,
    "pending",
    Date.parse("2026-01-29T09:30:00.000Z"),
    null
  );

  // Cron pending envelope (referenced by cron schedule)
  insertEnvelope.run(
    PENDING_ENV_CRON_1,
    "agent:nex",
    "agent:nex",
    0,
    "Daily standup reminder (cron): post your update in #team.",
    null,
    Date.parse("2026-01-30T17:00:00.000Z"),
    "pending",
    Date.parse("2026-01-15T10:30:00.000Z"),
    JSON.stringify({ cronScheduleId: CRON_ID_1, parseMode: "plain" })
  );

  // Delayed self-message (not cron) (used by turn prompt)
  insertEnvelope.run(
    "0a1b2c3d-0000-4000-8000-000000000007",
    "agent:nex",
    "agent:nex",
    0,
    "Delayed note to self: follow up with Alice about the weekly update.",
    null,
    Date.parse("2026-02-02T09:00:00.000Z"),
    "pending",
    Date.parse("2026-01-29T09:40:00.000Z"),
    JSON.stringify({ parseMode: "plain" })
  );

  // Envelope thread example (done; UUID ids so short ids are valid hex)
  const THREAD_ROOT_ENV = "4b7c2d1a-0000-4000-8000-000000000001";
  const THREAD_ASSIGN_ENV = "1a2b3c4d-0000-4000-8000-000000000002";
  const THREAD_FEEDBACK_ENV = "9d0a61fe-0000-4000-8000-000000000003";
  insertEnvelope.run(
    THREAD_ROOT_ENV,
    "channel:telegram:789012",
    "agent:nex",
    1,
    "Please summarize the attached notes.",
    null,
    null,
    "done",
    Date.parse("2026-01-29T09:00:00.000Z"),
    JSON.stringify({
      platform: "telegram",
      channelMessageId: "4001",
      author: { id: "u-123", username: "kky1024", displayName: "Kevin" },
      chat: { id: "789012" },
    })
  );
  insertEnvelope.run(
    THREAD_ASSIGN_ENV,
    "agent:nex",
    "agent:background",
    0,
    "Summarize the notes in 5 bullets. Return final result only.",
    null,
    null,
    "done",
    Date.parse("2026-01-29T09:02:00.000Z"),
    JSON.stringify({ replyToEnvelopeId: THREAD_ROOT_ENV })
  );
  insertEnvelope.run(
    THREAD_FEEDBACK_ENV,
    "agent:background",
    "agent:nex",
    0,
    "- Key decisions: ...\n- Risks: ...\n- Owners: ...\n- Next steps: ...\n- Open questions: ...",
    null,
    null,
    "done",
    Date.parse("2026-01-29T09:05:00.000Z"),
    JSON.stringify({ replyToEnvelopeId: THREAD_ASSIGN_ENV })
  );

  const insertCron = db.prepare(
    `INSERT INTO cron_schedules
     (id, agent_name, cron, timezone, enabled, to_address, content_text, content_attachments, metadata, pending_envelope_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  insertCron.run(
    CRON_ID_1,
    "nex",
    "0 9 * * 1-5",
    "America/Los_Angeles",
    1,
    "agent:nex",
    "Daily standup reminder: post your update in #team.",
    null,
    JSON.stringify({ parseMode: "plain" }),
    PENDING_ENV_CRON_1,
    Date.parse("2026-01-15T10:30:00.000Z"),
    Date.parse("2026-01-20T08:12:00.000Z")
  );

  insertCron.run(
    CRON_ID_2,
    "nex",
    "@daily",
    null,
    0,
    "channel:telegram:-100123456789",
    "Post the daily build status.",
    JSON.stringify([{ source: "/home/user/reports/build-status.txt" }]),
    null,
    null,
    Date.parse("2026-01-10T11:00:00.000Z"),
    null
  );

  db.close();

  return {
    homeDir,
    hibossDir,
    bossToken,
    agentToken,
    cleanup() {
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}
