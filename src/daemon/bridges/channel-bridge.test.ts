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
import { HiBossDatabase } from "../db/database.js";
import { ChannelBridge } from "./channel-bridge.js";

const CHANNEL_BATCH_WAIT_MS = 350;

class TestAdapter implements ChatAdapter {
  readonly platform = "telegram";
  private messageHandler: ChannelMessageHandler | null = null;
  private commandHandler: ChannelCommandHandler | null = null;
  readonly sentMessages: Array<{ chatId: string; content: MessageContent }> = [];

  async sendMessage(chatId: string, content: MessageContent, _options?: SendMessageOptions): Promise<void> {
    this.sentMessages.push({ chatId, content });
  }
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

async function waitForChannelBatchFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, CHANNEL_BATCH_WAIT_MS));
}

test("channel bridge requires /login token before routing channel messages", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    db.createBinding("nex", "telegram", "bot-token");
    db.setConfig(
      "user_permission_policy",
      JSON.stringify({
        tokens: [
          {
            name: "Ethan",
            token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            role: "admin",
          },
          {
            name: "LPC",
            token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            role: "user",
            agents: ["nex"],
          },
        ],
      })
    );

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
      channelUser: { id: "user-1", username: "alice", displayName: "Alice" },
      chat: { id: "chat-1", name: "group-1" },
      content: { text: "hello before login" },
      raw: {},
    });
    assert.equal(envelopes.length, 0);
    assert.equal(adapter.sentMessages.length, 1);
    assert.match(adapter.sentMessages[0]!.content.text!, /login/i);

    const login = await adapter.emitCommand({
      command: "login",
      args: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      chatId: "chat-1",
      channelUserId: "any-user",
      channelUsername: "any-name",
    });
    assert.match((login as ChannelCommandResponse | undefined)?.text ?? "", /login:\s*ok/i);

    await adapter.emitMessage({
      id: "m2",
      platform: "telegram",
      channelUser: { id: "any-user", username: "bob", displayName: "Bob" },
      chat: { id: "chat-1", name: "group-1" },
      content: { text: "hello after login" },
      raw: {},
    });
    await waitForChannelBatchFlush();

    assert.equal(envelopes.length, 1);
    const firstMeta = envelopes[0]?.metadata;
    const firstSessionId = typeof firstMeta?.channelSessionId === "string" ? firstMeta.channelSessionId : null;
    assert.ok(firstSessionId);

    const binding = db.getChannelSessionBinding("nex", "telegram", "chat-1");
    assert.equal(binding?.ownerUserId, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});

test("channel bridge batches same-chat messages within 200ms into one envelope", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    db.createBinding("nex", "telegram", "bot-token");
    db.setConfig(
      "user_permission_policy",
      JSON.stringify({
        tokens: [
          {
            name: "LPC",
            token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            role: "user",
            agents: ["nex"],
          },
        ],
      })
    );
    db.setChannelUserAuth({
      adapterType: "telegram",
      channelUserId: "tg-u-1",
      token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    const envelopes: Array<{
      content: { text?: string; attachments?: Array<{ source: string }> };
      metadata?: Record<string, unknown>;
    }> = [];
    const router = {
      registerAdapter: () => undefined,
      routeEnvelope: async (payload: {
        content: { text?: string; attachments?: Array<{ source: string }> };
        metadata?: Record<string, unknown>;
      }) => {
        envelopes.push(payload);
      },
    } as any;

    const bridge = new ChannelBridge(router, db, {} as any);
    const adapter = new TestAdapter();
    bridge.connect(adapter, "bot-token");

    await adapter.emitMessage({
      id: "m1",
      platform: "telegram",
      channelUser: { id: "tg-u-1", username: "alice", displayName: "Alice" },
      chat: { id: "chat-1", name: "group-1" },
      content: { text: "hello" },
      raw: {},
    });
    await adapter.emitMessage({
      id: "m2",
      platform: "telegram",
      channelUser: { id: "tg-u-1", username: "alice", displayName: "Alice" },
      chat: { id: "chat-1", name: "group-1" },
      content: {
        text: "world",
        attachments: [{ source: "/tmp/test.png", filename: "test.png" }],
      },
      raw: {},
    });

    await waitForChannelBatchFlush();

    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0]?.content.text, "hello\nworld");
    assert.equal(envelopes[0]?.content.attachments?.length, 1);
    assert.equal(envelopes[0]?.metadata?.channelMessageId, "m2");
    assert.deepEqual(envelopes[0]?.metadata?.channelMessageIds, ["m1", "m2"]);
  });
});

test("channel bridge clears metadata.userToken when batching mixed-user messages", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    db.createBinding("nex", "telegram", "bot-token");
    db.setConfig(
      "user_permission_policy",
      JSON.stringify({
        tokens: [
          {
            name: "LPC",
            token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            role: "user",
            agents: ["nex"],
          },
          {
            name: "Alice",
            token: "cccccccccccccccccccccccccccccccc",
            role: "user",
            agents: ["nex"],
          },
        ],
      })
    );
    db.setChannelUserAuth({
      adapterType: "telegram",
      channelUserId: "tg-u-1",
      token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    db.setChannelUserAuth({
      adapterType: "telegram",
      channelUserId: "tg-u-2",
      token: "cccccccccccccccccccccccccccccccc",
    });

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
      channelUser: { id: "tg-u-1", username: "alice", displayName: "Alice" },
      chat: { id: "chat-1", name: "group-1" },
      content: { text: "hello" },
      raw: {},
    });
    await adapter.emitMessage({
      id: "m2",
      platform: "telegram",
      channelUser: { id: "tg-u-2", username: "bob", displayName: "Bob" },
      chat: { id: "chat-1", name: "group-1" },
      content: { text: "world" },
      raw: {},
    });

    await waitForChannelBatchFlush();

    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0]?.metadata?.userToken, undefined);
    assert.deepEqual(envelopes[0]?.metadata?.userTokens, [
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccccccccccccccccccc",
    ]);
  });
});

test("channel bridge authorizes commands by logged-in token agent scope", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "nex", provider: "codex" });
    db.createBinding("nex", "telegram", "bot-token");
    db.setConfig(
      "user_permission_policy",
      JSON.stringify({
        tokens: [
          {
            name: "LPC",
            token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            role: "user",
            agents: ["nex"],
          },
          {
            name: "Nope",
            token: "dddddddddddddddddddddddddddddddd",
            role: "user",
            agents: ["kai"],
          },
          {
            name: "Ethan",
            token: "cccccccccccccccccccccccccccccccc",
            role: "admin",
          },
        ],
      })
    );

    let commandCalls = 0;
    let lastUserToken: string | undefined;
    let lastFromBoss: boolean | undefined;
    const router = {
      registerAdapter: () => undefined,
      routeEnvelope: async (_payload: unknown) => undefined,
    } as any;

    const bridge = new ChannelBridge(router, db, {} as any);
    const adapter = new TestAdapter();
    bridge.setCommandHandler(async (cmd) => {
      commandCalls += 1;
      lastUserToken = cmd.userToken;
      lastFromBoss = cmd.fromBoss;
      return { text: "command-ok" };
    });
    bridge.connect(adapter, "bot-token");

    const beforeLogin = await adapter.emitCommand({
      command: "status",
      args: "",
      chatId: "chat-1",
      channelUserId: "tg-u-1",
      channelUsername: "alice",
    });
    assert.equal((beforeLogin as ChannelCommandResponse | undefined)?.text, "error: Login required. Use /login <token>");
    assert.equal(commandCalls, 0);

    const otherUserLogin = await adapter.emitCommand({
      command: "login",
      args: "dddddddddddddddddddddddddddddddd",
      chatId: "chat-1",
      channelUserId: "tg-u-2",
      channelUsername: "blocked",
    });
    assert.match((otherUserLogin as ChannelCommandResponse | undefined)?.text ?? "", /login:\s*ok/i);
    assert.equal(commandCalls, 0);

    const deniedAfterOtherUserLogin = await adapter.emitCommand({
      command: "abort",
      args: "",
      chatId: "chat-1",
      channelUserId: "tg-u-2",
      channelUsername: "blocked",
    });
    assert.equal((deniedAfterOtherUserLogin as ChannelCommandResponse | undefined)?.text, "error: Access denied");
    assert.equal(commandCalls, 0);

    const okLogin = await adapter.emitCommand({
      command: "login",
      args: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      chatId: "chat-1",
      channelUserId: "tg-u-3",
      channelUsername: "alice",
    });
    assert.match((okLogin as ChannelCommandResponse | undefined)?.text ?? "", /login:\s*ok/i);

    const allowedAfterLogin = await adapter.emitCommand({
      command: "abort",
      args: "",
      chatId: "chat-1",
      channelUserId: "tg-u-3",
      channelUsername: "alice",
    });
    assert.equal((allowedAfterLogin as ChannelCommandResponse | undefined)?.text, "command-ok");
    assert.equal(commandCalls, 1);
    assert.equal(lastUserToken, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(lastFromBoss, false);

    const bossLogin = await adapter.emitCommand({
      command: "login",
      args: "cccccccccccccccccccccccccccccccc",
      chatId: "chat-1",
      channelUserId: "tg-u-5",
      channelUsername: "boss_user",
    });
    assert.match((bossLogin as ChannelCommandResponse | undefined)?.text ?? "", /from-boss:\s*true/i);

    const bossAllowed = await adapter.emitCommand({
      command: "abort",
      args: "",
      chatId: "chat-1",
      channelUserId: "tg-u-5",
      channelUsername: "boss_user",
    });
    assert.equal((bossAllowed as ChannelCommandResponse | undefined)?.text, "command-ok");
    assert.equal(commandCalls, 2);
    assert.equal(lastUserToken, "cccccccccccccccccccccccccccccccc");
    assert.equal(lastFromBoss, true);
  });
});

test("channel bridge resolves auth by channel username fallback", async () => {
  await withTempDb(async (db) => {
    db.registerAgent({ name: "molbot", provider: "codex" });
    db.createBinding("molbot", "telegram", "bot-token");
    db.setConfig(
      "user_permission_policy",
      JSON.stringify({
        tokens: [
          {
            name: "PolyU_CLC",
            token: "ce00e8e768d3ff9e155f7e69153cd541",
            role: "user",
            agents: ["molbot"],
          },
        ],
      })
    );

    db.setChannelUserAuth({
      adapterType: "telegram",
      channelUsername: "polyu_clc",
      token: "ce00e8e768d3ff9e155f7e69153cd541",
    });

    let commandCalls = 0;
    const router = {
      registerAdapter: () => undefined,
      routeEnvelope: async (_payload: unknown) => undefined,
    } as any;
    const bridge = new ChannelBridge(router, db, {} as any);
    const adapter = new TestAdapter();
    bridge.setCommandHandler(async (_cmd) => {
      commandCalls += 1;
      return { text: "command-ok" };
    });
    bridge.connect(adapter, "bot-token");

    const response = await adapter.emitCommand({
      command: "status",
      args: "",
      chatId: "chat-1",
      channelUserId: "6441950931",
      channelUsername: "PolyU_CLC",
    });
    assert.equal((response as ChannelCommandResponse | undefined)?.text, "command-ok");
    assert.equal(commandCalls, 1);
  });
});
