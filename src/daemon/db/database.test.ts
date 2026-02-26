import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { HiBossDatabase } from "./database.js";

function withTempDb(run: (db: HiBossDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-db-test-"));
  const dbPath = path.join(dir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);
  try {
    run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("registerAgent persists and lists agents", () => {
  withTempDb((db) => {
    db.registerAgent({
      name: "agent-a",
      provider: "codex",
    });
    db.registerAgent({
      name: "agent-b",
      provider: "codex",
    });

    const names = db.listAgents().map((agent) => agent.name).sort();
    assert.deepEqual(names, ["agent-a", "agent-b"]);
  });
});

test("envelopes default priority to 0", () => {
  withTempDb((db) => {
    const env = db.createEnvelope({
      from: "agent:sender",
      to: "agent:receiver",
      content: { text: "hello" },
    });

    const stored = db.getEnvelopeById(env.id);
    assert.ok(stored);
    assert.equal(stored.priority, 0);
  });
});

test("getPendingEnvelopesForAgent prioritizes higher priority envelopes first", () => {
  withTempDb((db) => {
    db.registerAgent({
      name: "nex",
      provider: "codex",
    });

    const low1 = db.createEnvelope({
      from: "agent:sender",
      to: "agent:nex",
      content: { text: "low-1" },
      priority: 0,
    });
    const high = db.createEnvelope({
      from: "agent:sender",
      to: "agent:nex",
      content: { text: "high" },
      priority: 1,
    });
    const low2 = db.createEnvelope({
      from: "agent:sender",
      to: "agent:nex",
      content: { text: "low-2" },
      priority: 0,
    });

    const pending = db.getPendingEnvelopesForAgent("nex", 10);
    assert.deepEqual(
      pending.map((item) => item.id),
      [high.id, low1.id, low2.id]
    );
  });
});

test("legacy envelopes table without priority is auto-migrated on startup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-db-legacy-priority-test-"));
  const dbPath = path.join(dir, "hiboss.db");

  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE envelopes (
      id TEXT PRIMARY KEY,
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      from_boss INTEGER DEFAULT 0,
      content_text TEXT,
      content_attachments TEXT,
      deliver_at INTEGER,
      status TEXT,
      created_at INTEGER,
      metadata TEXT
    );
  `);
  legacyDb.close();

  const db = new HiBossDatabase(dbPath);
  try {
    const probe = db.createEnvelope({
      from: "agent:sender",
      to: "agent:receiver",
      content: { text: "probe" },
      priority: 1,
    });
    const stored = db.getEnvelopeById(probe.id);
    assert.ok(stored);
    assert.equal(stored.priority, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
