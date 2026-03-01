import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ChannelCommand,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelCommandHandler,
  ChannelCommandResponse,
  ChatAdapter,
  MessageContent,
  SendMessageOptions,
} from "../../adapters/types.js";
import { INTERNAL_VERSION } from "../../shared/version.js";
import { HiBossDatabase } from "../db/database.js";
import { ChannelBridge } from "./channel-bridge.js";

class TestAdapter implements ChatAdapter {
  readonly platform = "telegram";
  private messageHandler: ChannelMessageHandler | null = null;
  private commandHandler: ChannelCommandHandler | null = null;

  async sendMessage(_chatId: string, _content: MessageContent, _options?: SendMessageOptions): Promise<void> {}
  onMessage(handler: ChannelMessageHandler): void {
    this.messageHandler = handler;
  }
  onCommand(handler: ChannelCommandHandler): void {
    this.commandHandler = handler;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async emitMessage(message: ChannelMessage): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(message);
    }
  }

  async emitCommand(command: ChannelCommand): Promise<ChannelCommandResponse | void> {
    if (this.commandHandler) {
      return await this.commandHandler(command);
    }
  }

  getCommandHandler(): ChannelCommandHandler | null {
    return this.commandHandler;
  }
}

function withTempDb(run: (db: HiBossDatabase) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-channel-bridge-test-"));
  const dbPath = path.join(dir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);
  return Promise.resolve()
    .then(() => run(db))
    .finally(() => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test("channel bridge stamps channelSessionId at ingest and does not drift owner to non-boss users", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    db.createBinding("nex", "telegram", "bot-token");
    db.setAdapterBossIds("telegram", ["boss_user"]);

    const envelopes: Array<{ metadata?: Record<string, unknown> }> = [];
    const router = {
      registerAdapter: () => undefined,
      routeEnvelope: async (payload: { metadata?: Record<string, unknown> }) => {
        envelopes.push(payload);
      },
    } as any;

    const bridge = new ChannelBridge(router, db, {} as any);
    const adapter = new TestAdapter();
    bridge.connect(adapter, "bot-token");

    await adapter.emitMessage({
      id: "m1",
      platform: "telegram",
      channelUser: { id: "boss-1", username: "boss_user", displayName: "Boss" },
      chat: { id: "chat-1", name: "group-1" },
      content: { text: "hello" },
      raw: {},
    });

    assert.equal(envelopes.length, 1);
    const firstMeta = envelopes[0]?.metadata;
    const firstSessionId = typeof firstMeta?.channelSessionId === "string" ? firstMeta.channelSessionId : null;
    assert.ok(firstSessionId);

    const bindingAfterBoss = db.getChannelSessionBinding("nex", "telegram", "chat-1");
    assert.equal(bindingAfterBoss?.ownerUserId, "boss-1");

    await adapter.emitMessage({
      id: "m2",
      platform: "telegram",
      channelUser: { id: "member-2", username: "alice", displayName: "Alice" },
      chat: { id: "chat-1", name: "group-1" },
      content: { text: "follow-up" },
      raw: {},
    });

    assert.equal(envelopes.length, 2);
    const secondMeta = envelopes[1]?.metadata;
    const secondSessionId = typeof secondMeta?.channelSessionId === "string" ? secondMeta.channelSessionId : null;
    assert.equal(secondSessionId, firstSessionId);

    const bindingAfterMember = db.getChannelSessionBinding("nex", "telegram", "chat-1");
    assert.equal(bindingAfterMember?.ownerUserId, "boss-1");
  });
});

test("channel bridge keeps legacy boss-only command behavior when user policy is not configured", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    db.createBinding("nex", "telegram", "bot-token");
    db.setAdapterBossIds("telegram", ["boss_user"]);

    const router = {
      registerAdapter: () => undefined,
      routeEnvelope: async () => undefined,
    } as any;

    const bridge = new ChannelBridge(router, db, {} as any);
    let commandCalls = 0;
    bridge.setCommandHandler(async () => {
      commandCalls += 1;
      return { text: "command-ok" };
    });
    const adapter = new TestAdapter();
    bridge.connect(adapter, "bot-token");

    const nonBoss = await adapter.emitCommand({
      command: "status",
      args: "",
      chatId: "chat-1",
      channelUserId: "u-1",
      channelUsername: "alice",
    });
    assert.equal(nonBoss, undefined);
    assert.equal(commandCalls, 0);

    const boss = await adapter.emitCommand({
      command: "status",
      args: "",
      chatId: "chat-1",
      channelUserId: "boss-1",
      channelUsername: "boss_user",
    });
    assert.equal(commandCalls, 1);
    assert.equal((boss as ChannelCommandResponse | undefined)?.text, "command-ok");
  });
});

test("channel bridge enforces user-permission-policy for command and message entry points", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    db.createBinding("nex", "telegram", "bot-token");
    db.setAdapterBossIds("telegram", ["boss_user"]);
    db.setConfig(
      "user_permission_policy",
      JSON.stringify({
        version: INTERNAL_VERSION,
        roles: {
          boss: { allow: ["channel.command.*", "channel.message.send"] },
          operator: { allow: ["channel.command.status", "channel.message.send"] },
          blocked: { allow: [] },
        },
        bindings: [
          { "adapter-type": "telegram", "user-id": "op-1", role: "operator" },
          { "adapter-type": "telegram", "user-id": "blocked-1", role: "blocked" },
        ],
        defaults: {
          "unmapped-user-role": "blocked",
        },
      })
    );

    let commandCalls = 0;
    const routedEnvelopes: unknown[] = [];
    const router = {
      registerAdapter: () => undefined,
      routeEnvelope: async (payload: unknown) => {
        routedEnvelopes.push(payload);
      },
    } as any;

    const bridge = new ChannelBridge(router, db, {} as any);
    const adapter = new TestAdapter();
    bridge.setCommandHandler(async () => {
      commandCalls += 1;
      return { text: "command-ok" };
    });
    bridge.connect(adapter, "bot-token");

    const allowed = await adapter.emitCommand({
      command: "status",
      args: "",
      chatId: "chat-1",
      channelUserId: "op-1",
      channelUsername: "alice",
    });
    assert.equal((allowed as ChannelCommandResponse | undefined)?.text, "command-ok");
    assert.equal(commandCalls, 1);

    const denied = await adapter.emitCommand({
      command: "abort",
      args: "",
      chatId: "chat-1",
      channelUserId: "op-1",
      channelUsername: "alice",
    });
    assert.equal((denied as ChannelCommandResponse | undefined)?.text, "error: Access denied");
    assert.equal(commandCalls, 1);

    await adapter.emitMessage({
      id: "m-blocked",
      platform: "telegram",
      channelUser: { id: "blocked-1", username: "blocked", displayName: "Blocked" },
      chat: { id: "chat-1", name: "group-1" },
      content: { text: "denied message" },
      raw: {},
    });
    assert.equal(routedEnvelopes.length, 0);

    await adapter.emitMessage({
      id: "m-allowed",
      platform: "telegram",
      channelUser: { id: "op-1", username: "alice", displayName: "Alice" },
      chat: { id: "chat-1", name: "group-1" },
      content: { text: "allowed message" },
      raw: {},
    });
    assert.equal(routedEnvelopes.length, 1);
    const binding = db.getChannelSessionBinding("nex", "telegram", "chat-1");
    assert.equal(binding?.ownerUserId, "op-1");
  });
});
