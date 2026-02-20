import assert from "assert/strict";
import test from "node:test";
import type { ChatAdapter, ChannelMessageHandler, MessageContent } from "../adapters/types.js";
import type { Envelope } from "../envelope/types.js";
import { TelegramTypingManager } from "./telegram-typing.js";

class FakeAdapter implements ChatAdapter {
  readonly platform = "telegram";
  readonly typingCalls: Array<{ chatId: string; active: boolean }> = [];

  async sendMessage(_chatId: string, _content: MessageContent): Promise<void> {}
  onMessage(_handler: ChannelMessageHandler): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async setTyping(chatId: string, active: boolean): Promise<void> {
    this.typingCalls.push({ chatId, active });
  }
}

function makeEnvelope(from: string): Envelope {
  return {
    id: `env-${Math.random()}`,
    from,
    to: "agent:nex",
    fromBoss: true,
    content: { text: "hi" },
    status: "pending",
    createdAt: Date.now(),
  };
}

test("typing starts and stops for telegram-origin runs", async () => {
  const adapter = new FakeAdapter();
  const db = {
    getAgentBindingByType(agentName: string, adapterType: string) {
      if (agentName === "nex" && adapterType === "telegram") {
        return { adapterToken: "token-1" };
      }
      return null;
    },
  };
  const manager = new TelegramTypingManager(db, new Map([["token-1", adapter]]));

  await manager.onRunStarted({
    runId: "run-1",
    agentName: "nex",
    envelopes: [makeEnvelope("channel:telegram:12345")],
  });
  await manager.onRunFinished({ runId: "run-1" });

  assert.deepEqual(adapter.typingCalls, [
    { chatId: "12345", active: true },
    { chatId: "12345", active: false },
  ]);
});

test("typing ignores non-telegram channel envelopes", async () => {
  const adapter = new FakeAdapter();
  const db = {
    getAgentBindingByType() {
      return { adapterToken: "token-1" };
    },
  };
  const manager = new TelegramTypingManager(db, new Map([["token-1", adapter]]));

  await manager.onRunStarted({
    runId: "run-1",
    agentName: "nex",
    envelopes: [makeEnvelope("channel:slack:C123"), makeEnvelope("agent:alice")],
  });
  await manager.onRunFinished({ runId: "run-1" });

  assert.equal(adapter.typingCalls.length, 0);
});

test("typing uses ref-count across overlapping runs in same chat", async () => {
  const adapter = new FakeAdapter();
  const db = {
    getAgentBindingByType() {
      return { adapterToken: "token-1" };
    },
  };
  const manager = new TelegramTypingManager(db, new Map([["token-1", adapter]]));

  await manager.onRunStarted({
    runId: "run-1",
    agentName: "nex",
    envelopes: [makeEnvelope("channel:telegram:12345")],
  });
  await manager.onRunStarted({
    runId: "run-2",
    agentName: "nex",
    envelopes: [makeEnvelope("channel:telegram:12345"), makeEnvelope("channel:telegram:12345")],
  });

  await manager.onRunFinished({ runId: "run-1" });
  assert.deepEqual(adapter.typingCalls, [{ chatId: "12345", active: true }]);

  await manager.onRunFinished({ runId: "run-2" });
  assert.deepEqual(adapter.typingCalls, [
    { chatId: "12345", active: true },
    { chatId: "12345", active: false },
  ]);
});
