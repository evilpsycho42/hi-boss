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

test("/sessions accepts --tab/--page syntax", async () => {
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
      args: "--tab agent-all --page 2",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.ok(response?.text?.includes("scope: agent-all"));
    assert.ok(response?.text?.includes("page: 1"));
  });
});

test("/sessions for non-telegram channel is text-only", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex", role: "speaker" });
    db.getOrCreateChannelActiveSession({
      agentName: "nex",
      adapterType: "wechatpadpro",
      chatId: "room-1",
      ownerUserId: "boss-1",
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
      args: "--tab current-chat --page 1",
      adapterType: "wechatpadpro",
      chatId: "room-1",
      authorId: "boss-1",
      authorUsername: "boss-1",
      agentName: "nex",
    } as any);

    assert.ok(response?.text?.includes("usage-text-flags: /sessions"));
    assert.ok(response?.text?.includes("usage-cli-flags: /sessions --tab"));
    assert.equal(response?.telegram, undefined);
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

test("/abort uses adapter-specific reason", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex", role: "speaker" });
    let abortReason = "";

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: (_agent: string, reason: string) => {
          abortReason = reason;
          return false;
        },
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: { routeEnvelope: async () => undefined } as any,
    });

    await handler({
      command: "abort",
      args: "",
      adapterType: "slack",
      chatId: "channel-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.equal(abortReason, "slack:/abort");
  });
});

test("/session not-found uses distinct message from invalid-id", async () => {
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

    const invalid = await handler({
      command: "session",
      args: "not-a-hex-id",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);
    const notFound = await handler({
      command: "session",
      args: "aaaaaaaa",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
    } as any);

    assert.equal(invalid?.text, "error: Invalid session id");
    assert.equal(notFound?.text, "error: Session not found");
  });
});

test("/isolated acknowledgement does not include one-shot metadata lines", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex", role: "speaker" });
    let routed = 0;

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: {
        routeEnvelope: async () => {
          routed += 1;
          return undefined;
        },
      } as any,
    });

    const response = await handler({
      command: "isolated",
      args: "hello",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
      messageId: "123",
    } as any);

    assert.equal(routed, 1);
    assert.equal(typeof response?.text, "string");
    assert.equal(response?.text?.includes("oneshot-mode:"), false);
    assert.equal(response?.text?.includes("active-session-changed:"), false);
  });
});

test("/clone records source active session id in oneshot metadata", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex", role: "speaker" });
    const active = db.getOrCreateChannelActiveSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "u-1",
      provider: "codex",
    });
    let routedPayload: any = null;

    const handler = createChannelCommandHandler({
      db,
      executor: {
        isAgentBusy: () => false,
        abortCurrentRun: () => false,
        invalidateChannelSessionCache: () => undefined,
      } as any,
      router: {
        routeEnvelope: async (payload: unknown) => {
          routedPayload = payload;
          return undefined;
        },
      } as any,
    });

    await handler({
      command: "clone",
      args: "hello",
      chatId: "chat-1",
      authorId: "u-1",
      authorUsername: "alice",
      agentName: "nex",
      messageId: "123",
    } as any);

    assert.equal(routedPayload?.metadata?.oneshotType, "clone");
    assert.equal(routedPayload?.metadata?.oneshotSourceSessionId, active.session.id);
  });
});
