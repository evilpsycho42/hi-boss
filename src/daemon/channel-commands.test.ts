import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createChannelCommandHandler } from "./channel-commands.js";
import { HiBossDatabase } from "./db/database.js";

function withTempDb(run: (db: HiBossDatabase) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-channel-cmd-test-"));
  const dbPath = path.join(dir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);
  return Promise.resolve()
    .then(() => run(db))
    .finally(() => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test("/new switches current chat session and returns old/new ids", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex", role: "speaker" });
    const initial = db.getOrCreateChannelActiveSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      provider: "codex",
    });

    const executor = {
      isAgentBusy: () => false,
      abortCurrentRun: () => false,
      invalidateChannelSessionCache: () => undefined,
    } as any;

    const handler = createChannelCommandHandler({
      db,
      executor,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const response = await handler({
      command: "new",
      args: "",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.ok(response);
    assert.equal(typeof response?.text, "string");
    assert.equal(response?.text?.includes("session-new: ok"), true);

    const binding = db.getChannelSessionBinding("nex", "telegram", "chat-1");
    assert.ok(binding);
    assert.notEqual(binding.activeSessionId, initial.session.id);
  });
});

test("/sessions returns keyboard with tabs and pager", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex", role: "speaker" });
    db.getOrCreateChannelActiveSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      provider: "codex",
    });

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const response = await handler({
      command: "sessions",
      args: "",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.ok(response);
    assert.equal(typeof response?.text, "string");
    assert.equal(response?.text?.includes("sessions: ok"), true);
    assert.ok(response?.telegram?.inlineKeyboard);
    assert.equal(response?.telegram?.inlineKeyboard?.length, 2);
  });
});

test("/new uses command adapter type instead of hardcoded telegram", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex", role: "speaker" });

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    const response = await handler({
      command: "new",
      args: "",
      adapterType: "slack",
      chatId: "channel-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.ok(response?.text?.includes("session-new: ok"));
    const slackBinding = db.getChannelSessionBinding("nex", "slack", "channel-1");
    const telegramBinding = db.getChannelSessionBinding("nex", "telegram", "channel-1");
    assert.ok(slackBinding);
    assert.equal(telegramBinding, null);
  });
});
