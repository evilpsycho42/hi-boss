import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HiBossDatabase } from "./database.js";

function withTempDb(run: (db: HiBossDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-db-session-test-"));
  const dbPath = path.join(dir, "hiboss.db");
  let db: HiBossDatabase | null = null;
  try {
    db = new HiBossDatabase(dbPath);
    run(db);
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("channel session mapping creates once and switches default session", () => {
  withTempDb((db) => {
    db.registerAgent({
      name: "nex",
      provider: "codex",
    });

    const first = db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      provider: "codex",
    });
    assert.equal(first.created, true);

    const second = db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      provider: "codex",
    });
    assert.equal(second.created, false);
    assert.equal(second.session.id, first.session.id);

    const other = db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-2",
      ownerUserId: "u-1",
      provider: "codex",
    });

    const switched = db.switchChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      targetSessionId: other.session.id,
      ownerUserId: "u-1",
    });

    assert.equal(switched.oldSessionId, first.session.id);
    assert.equal(switched.newSessionId, other.session.id);

    const binding = db.getChannelSessionBinding("nex", "telegram", "chat-1");
    assert.ok(binding);
    assert.equal(binding.defaultSessionId, other.session.id);
  });
});

test("list sessions scope respects current chat, owner, and agent-wide visibility", () => {
  withTempDb((db) => {
    db.registerAgent({
      name: "nex",
      provider: "codex",
    });

    const s1 = db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      provider: "codex",
    }).session;
    const s2 = db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-2",
      ownerUserId: "u-1",
      provider: "codex",
    }).session;
    const s3 = db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-3",
      ownerUserId: "u-2",
      provider: "codex",
    }).session;

    const current = db.listSessionsForScope({
      agentName: "nex",
      scope: "current-chat",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      limit: 10,
      offset: 0,
    });
    assert.equal(current.length, 1);
    assert.equal(current[0]?.session.id, s1.id);

    const mine = db.listSessionsForScope({
      agentName: "nex",
      scope: "my-chats",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      limit: 10,
      offset: 0,
    });
    const mineIds = new Set(mine.map((item) => item.session.id));
    assert.equal(mineIds.has(s1.id), true);
    assert.equal(mineIds.has(s2.id), true);
    assert.equal(mineIds.has(s3.id), false);

    const all = db.listSessionsForScope({
      agentName: "nex",
      scope: "agent-all",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      limit: 10,
      offset: 0,
    });
    const allIds = new Set(all.map((item) => item.session.id));
    assert.equal(allIds.has(s1.id), true);
    assert.equal(allIds.has(s2.id), true);
    assert.equal(allIds.has(s3.id), true);

    assert.equal(
      db.countSessionsForScope({
        agentName: "nex",
        scope: "my-chats",
        adapterType: "telegram",
        chatId: "chat-1",
        ownerUserId: "u-1",
      }),
      2
    );
  });
});

test("runtime session concurrency falls back to defaults and persists configured values", () => {
  withTempDb((db) => {
    assert.deepEqual(db.getRuntimeSessionConcurrency(), { perAgent: 4, global: 16 });

    db.setRuntimeSessionConcurrency({ perAgent: 6, global: 20 });
    assert.deepEqual(db.getRuntimeSessionConcurrency(), { perAgent: 6, global: 20 });

    db.setRuntimeSessionConcurrency({ perAgent: 7, global: 3 });
    assert.deepEqual(db.getRuntimeSessionConcurrency(), { perAgent: 7, global: 7 });
  });
});
