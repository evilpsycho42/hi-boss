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

test("envelope lifecycle hooks emit created and status-changed events", () => {
  withTempDb((db) => {
    const created: Array<{ id: string; origin: string }> = [];
    const statusChanged: Array<{ id: string; fromStatus: string; toStatus: string; reason?: string; outcome?: string }> = [];

    db.setEnvelopeLifecycleHooks({
      onEnvelopeCreated: (event) => {
        created.push({
          id: event.envelope.id,
          origin: event.origin,
        });
      },
      onEnvelopeStatusChanged: (event) => {
        statusChanged.push({
          id: event.envelopeId,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          reason: event.reason,
          outcome: event.outcome,
        });
      },
    });

    const env = db.createEnvelope({
      from: "agent:sender",
      to: "agent:receiver",
      content: { text: "hi" },
      metadata: { origin: "cli" },
    });
    db.updateEnvelopeStatus(env.id, "done", {
      reason: "test-status",
      outcome: "ok",
      origin: "internal",
    });

    assert.deepEqual(created, [{ id: env.id, origin: "cli" }]);
    assert.deepEqual(statusChanged, [{
      id: env.id,
      fromStatus: "pending",
      toStatus: "done",
      reason: "test-status",
      outcome: "ok",
    }]);
  });
});

test("markEnvelopesDone emits only pending->done status transitions", () => {
  withTempDb((db) => {
    const statusChanged: Array<{ id: string; fromStatus: string; toStatus: string }> = [];
    db.setEnvelopeLifecycleHooks({
      onEnvelopeStatusChanged: (event) => {
        statusChanged.push({
          id: event.envelopeId,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
        });
      },
    });

    const e1 = db.createEnvelope({
      from: "agent:a",
      to: "agent:b",
      content: { text: "p1" },
    });
    const e2 = db.createEnvelope({
      from: "agent:a",
      to: "agent:b",
      content: { text: "p2" },
    });
    db.updateEnvelopeStatus(e2.id, "done");

    db.markEnvelopesDone([e1.id, e2.id], { reason: "bulk-ack" });

    assert.deepEqual(
      statusChanged.map((item) => `${item.id}:${item.fromStatus}->${item.toStatus}`),
      [
        `${e2.id}:pending->done`,
        `${e1.id}:pending->done`,
      ]
    );
  });
});
