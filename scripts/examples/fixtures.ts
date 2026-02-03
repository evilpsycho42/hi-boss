import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Schema, Utf8 } from "apache-arrow";

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

  const daemon = new Daemon({ dataDir: hibossDir });
  await daemon.start();

  const socketPath = path.join(hibossDir, "daemon.sock");
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
        TZ: "UTC",
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
  const hibossDir = path.join(homeDir, ".hiboss");
  fs.mkdirSync(hibossDir, { recursive: true });

  const bossToken = "boss_example_token_for_docs";
  const agentToken = "agt_example_token_for_docs";

  // Customization files (used by prompt examples)
  fs.writeFileSync(
    path.join(hibossDir, "BOSS.md"),
    ["# Boss", "", "Preferred communication style: concise, direct.", ""].join("\n"),
    "utf-8"
  );
  const agentHome = path.join(hibossDir, "agents", "nex");
  fs.mkdirSync(agentHome, { recursive: true });
  fs.writeFileSync(
    path.join(agentHome, "SOUL.md"),
    ["# Soul", "", "You are Nex. You are helpful and pragmatic.", ""].join("\n"),
    "utf-8"
  );

  // Memory model stub file: the daemon checks model-path is set; we avoid loading it in examples.
  const modelsDir = path.join(hibossDir, "models");
  fs.mkdirSync(modelsDir, { recursive: true });
  const modelPath = path.join(modelsDir, "example.gguf");
  fs.writeFileSync(modelPath, "", "utf-8");

  // Seed SQLite
  const dbPath = path.join(hibossDir, "hiboss.db");
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
  const cfgTime = "2026-01-01T00:00:00.000Z";
  upsertConfig.run("setup_completed", "true", cfgTime);
  upsertConfig.run("boss_token_hash", hashToken(bossToken), cfgTime);
  upsertConfig.run("boss_name", "Kevin", cfgTime);
  upsertConfig.run("adapter_boss_id_telegram", "@kky1024", cfgTime);
  upsertConfig.run("memory_enabled", "true", cfgTime);
  upsertConfig.run("memory_model_source", "local", cfgTime);
  upsertConfig.run("memory_model_uri", "", cfgTime);
  upsertConfig.run("memory_model_path", modelPath, cfgTime);
  upsertConfig.run("memory_model_dims", "3", cfgTime);
  upsertConfig.run("memory_model_last_error", "", cfgTime);

  const insertAgent = db.prepare(
    `INSERT INTO agents
     (name, token, description, workspace, provider, model, reasoning_effort, auto_level, permission_level, session_policy, created_at, last_seen_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  insertAgent.run(
    "nex",
    agentToken,
    "AI assistant for project management",
    "/home/user/projects/myapp",
    "claude",
    "claude-sonnet-4-20250514",
    "medium",
    "medium",
    "restricted",
    JSON.stringify({ dailyResetAt: "03:00", idleTimeout: "30m", maxContextLength: 180000 }),
    "2026-01-15T10:30:00.000Z",
    "2026-01-29T14:22:00.000Z",
    JSON.stringify({})
  );

  insertAgent.run(
    "scheduler",
    "agt_example_scheduler_token",
    "Background scheduler",
    null,
    "codex",
    null,
    "medium",
    "medium",
    "restricted",
    null,
    "2026-01-10T09:00:00.000Z",
    null,
    JSON.stringify({})
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
    "2026-01-15T11:00:00.000Z"
  );

  const insertEnvelope = db.prepare(
    `INSERT INTO envelopes
     (id, "from", "to", from_boss, content_text, content_attachments, deliver_at, status, created_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Two pending group messages (used by envelope list + turn prompt)
  insertEnvelope.run(
    "env_group_001",
    "channel:telegram:-100123456789",
    "agent:nex",
    1,
    "@nex can you post the latest build status?",
    null,
    null,
    "pending",
    "2026-01-29T09:00:00.000Z",
    JSON.stringify({
      platform: "telegram",
      channelMessageId: "335",
      author: { id: "u-123", username: "kky1024", displayName: "Kevin" },
      chat: { id: "-100123456789", name: "Project X Dev" },
    })
  );
  insertEnvelope.run(
    "env_group_002",
    "channel:telegram:-100123456789",
    "agent:nex",
    0,
    "@nex what's the ETA on the feature? (need it for the weekly update)",
    null,
    null,
    "pending",
    "2026-01-29T09:15:00.000Z",
    JSON.stringify({
      platform: "telegram",
      channelMessageId: "336",
      author: { id: "u-456", username: "alice_dev", displayName: "Alice" },
      chat: { id: "-100123456789", name: "Project X Dev" },
    })
  );

  // Direct boss message (used by envelope prompt examples)
  insertEnvelope.run(
    "env_direct_001",
    "channel:telegram:789012",
    "agent:nex",
    1,
    "Can you summarize the meeting notes from yesterday?",
    JSON.stringify([{ source: "/home/user/downloads/meeting-notes.pdf", filename: "meeting-notes.pdf" }]),
    null,
    "pending",
    "2026-01-29T09:00:00.000Z",
    JSON.stringify({
      platform: "telegram",
      channelMessageId: "3001",
      author: { id: "u-123", username: "kky1024", displayName: "Kevin" },
      chat: { id: "789012" },
    })
  );

  // Agent-to-agent message (used by envelope prompt examples + turn prompt)
  insertEnvelope.run(
    "env_agent_001",
    "agent:scheduler",
    "agent:nex",
    0,
    "Reminder: Review the PR as requested by Kevin.",
    null,
    "2026-01-29T15:00:00.000Z",
    "pending",
    "2026-01-29T09:30:00.000Z",
    JSON.stringify({ fromName: "scheduler" })
  );

  // Cron pending envelope (referenced by cron schedule)
  insertEnvelope.run(
    PENDING_ENV_CRON_1,
    "agent:nex",
    "agent:nex",
    0,
    "Daily standup reminder: post your update in #team.",
    null,
    "2026-01-30T17:00:00.000Z",
    "pending",
    "2026-01-15T10:30:00.000Z",
    JSON.stringify({ cronScheduleId: CRON_ID_1, parseMode: "plain" })
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
    "2026-01-15T10:30:00.000Z",
    "2026-01-20T08:12:00.000Z"
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
    "2026-01-10T11:00:00.000Z",
    null
  );

  db.close();

  // Seed LanceDB memory store with deterministic rows (no embeddings required for list/categories).
  const dims = 3;
  const schema = new Schema([
    new Field("id", new Utf8(), false),
    new Field("text", new Utf8(), false),
    new Field("vector", new FixedSizeList(dims, new Field("item", new Float32(), false)), false),
    new Field("category", new Utf8(), false),
    new Field("createdAt", new Utf8(), false),
  ]);
  const mem = await lancedb.connect(path.join(hibossDir, "memory.lance"));
  const tableName = "memories__nex";
  const names = await mem.tableNames();
  if (!names.includes(tableName)) {
    await mem.createEmptyTable(tableName, schema);
  }
  const table = await mem.openTable(tableName);
  await table.add([
    {
      id: "c3f9b2b1-4b64-4e67-b25f-92a1d3b4c5d6",
      text: "Project X uses Node.js 22.",
      vector: [1, 0, 0],
      category: "fact",
      createdAt: "2026-01-05T12:00:00.000Z",
    },
    {
      id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      text: "Weekly update is due every Friday 5pm PT.",
      vector: [0, 1, 0],
      category: "process",
      createdAt: "2026-01-06T09:00:00.000Z",
    },
  ]);
  mem.close();

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
