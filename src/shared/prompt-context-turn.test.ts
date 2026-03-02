import assert from "node:assert/strict";
import test from "node:test";
import type { Envelope } from "../envelope/types.js";
import { buildTurnPromptContext } from "./prompt-context.js";

function buildEnvelope(text: string): Envelope {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    from: "channel:telegram:123",
    to: "agent:MolBot",
    fromBoss: false,
    content: { text },
    status: "pending",
    createdAt: Date.now(),
    metadata: {
      origin: "channel",
      platform: "telegram",
      channelMessageId: "1",
      channelUser: {
        id: "u1",
        username: "polyu_clc",
        displayName: "PolyU_CLC",
      },
      chat: {
        id: "123",
      },
    },
  };
}

test("buildTurnPromptContext marks /start envelopes", () => {
  const ctx = buildTurnPromptContext({
    agentName: "MolBot",
    datetimeMs: Date.now(),
    bossTimezone: "Asia/Hong_Kong",
    envelopes: [buildEnvelope("/start"), buildEnvelope("/start@MolBot hello"), buildEnvelope("hello /start")],
  }) as { envelopes: Array<{ isStartCommand: boolean }> };

  assert.equal(ctx.envelopes[0]?.isStartCommand, true);
  assert.equal(ctx.envelopes[1]?.isStartCommand, true);
  assert.equal(ctx.envelopes[2]?.isStartCommand, false);
});
