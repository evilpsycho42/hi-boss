import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Agent } from "../src/agent/types.js";
import type { AgentBinding } from "../src/daemon/db/database.js";
import type { Envelope } from "../src/envelope/types.js";
import { renderPrompt } from "../src/shared/prompt-renderer.js";
import {
  buildCliEnvelopePromptContext,
  buildSystemPromptContext,
  buildTurnPromptContext,
} from "../src/shared/prompt-context.js";

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, "utf-8");
}

function makeMockAgent(workspaceDir: string): Agent {
  return {
    name: "nex",
    token: "abc123",
    description: "AI assistant",
    workspace: workspaceDir,
    provider: "codex",
    model: "gpt-5.2",
    reasoningEffort: "medium",
    autoLevel: "high",
    createdAt: Date.now(),
    metadata: { example: true },
  };
}

function makeMockBindings(): AgentBinding[] {
  return [
    {
      id: "bind-1",
      agentName: "nex",
      adapterType: "telegram",
      adapterToken: "telegram-bot-token-redacted",
      createdAt: Date.now(),
    },
  ];
}

function makeMockEnvelopes(): Envelope[] {
  return [
    {
      id: "env-1",
      from: "channel:telegram:123",
      to: "agent:nex",
      fromBoss: false,
      content: {
        text: "Hello!",
        attachments: [{ source: "/tmp/photo.jpg" }],
      },
      status: "pending",
      createdAt: Date.now(),
      metadata: {
        platform: "telegram",
        channelMessageId: "2147483647",
        author: { id: "u-1", username: "alice", displayName: "Alice" },
        chat: { id: "123", name: "hiboss-test" },
      },
    },
    {
      id: "env-2",
      from: "agent:boss",
      to: "agent:nex",
      fromBoss: true,
      content: { text: "(second message)", attachments: [] },
      status: "pending",
      createdAt: Date.now(),
    },
  ];
}

function validateSystemPrompt(): void {
  const hibossDir = mkTmpDir("hiboss-state-");
  const workspaceDir = mkTmpDir("hiboss-workspace-");

  const agentName = "nex";
  fs.mkdirSync(path.join(hibossDir, "agents", agentName), { recursive: true });
  writeFile(path.join(hibossDir, "agents", agentName, "SOUL.md"), "# SOUL.md\n\nBe concise.\n");
  writeFile(path.join(hibossDir, "BOSS.md"), "# BOSS.md\n\n- Name: Kevin\n");

  const agent = makeMockAgent(workspaceDir);
  const ctx = buildSystemPromptContext({
    agent,
    agentToken: agent.token,
    bindings: makeMockBindings(),
    hibossDir,
  });
  (ctx.hiboss as Record<string, unknown>).additionalContext = "Extra line.";

  const out = renderPrompt({ surface: "system", template: "system/base.md", context: ctx });
  assert.ok(out.includes("## Your Identity"), "system prompt should include identity section");
  assert.ok(out.includes("- Name: nex"), "system prompt should include agent name");
  assert.ok(out.includes("You are a personal assistant"), "system prompt should include identity line");
  assert.ok(out.includes("### CLI Tools"), "system prompt should include tools section");
  assert.ok(out.includes("### Memory"), "system prompt should include memory section");
  assert.ok(out.includes("Be concise."), "system prompt should include SOUL.md content");
  assert.ok(out.includes("- Name: Kevin"), "system prompt should include BOSS.md content");
  assert.ok(out.includes("## Additional Context"), "system prompt should include additional context section");
}

function validateTurnPrompt(): void {
  // 0 envelopes
  {
    const ctx = buildTurnPromptContext({
      agentName: "nex",
      datetimeMs: Date.now(),
      envelopes: [],
    });
    const out = renderPrompt({ surface: "turn", template: "turn/turn.md", context: ctx }).trimEnd();
    assert.ok(out.includes("## Turn Context"), "turn prompt should include context");
    assert.ok(/^now: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/m.test(out), "turn prompt should include local now");
    assert.ok(/^pending-envelopes: 0$/m.test(out), "turn prompt should include pending-envelopes count");
    assert.ok(!/^agent:/m.test(out), "turn prompt should not include agent key");
    assert.ok(!out.includes("## Pending Envelopes"), "turn prompt should not include pending envelopes header");
  }

  // N envelopes
  {
    const now = Date.now();
    const ctx = buildTurnPromptContext({
      agentName: "nex",
      datetimeMs: now,
      envelopes: [{ ...makeMockEnvelopes()[0], deliverAt: now + 60_000 }, makeMockEnvelopes()[1]],
    });
    const out = renderPrompt({ surface: "turn", template: "turn/turn.md", context: ctx }).trimEnd();
    assert.ok(!out.includes("### Envelope "), "turn prompt should not include envelope headers");
    assert.ok(out.includes("sender:"), "turn prompt should include sender for channel messages");
    assert.ok(out.includes("in group \"hiboss-test\""), "turn prompt should show group name in sender line");
    assert.ok(out.includes("Alice (@alice)"), "turn prompt should show author for group messages");
    assert.ok(out.includes("channel-message-id: zik0zj"), "turn prompt should show compact telegram channel-message-id");
    assert.ok(out.includes("deliver-at:"), "turn prompt should include deliver-at when present");
  }

  // Group messages (same chat) should not be batched
  {
    const group1: Envelope = {
      id: "env-g1",
      from: "channel:telegram:123",
      to: "agent:nex",
      fromBoss: false,
      content: { text: "First message", attachments: [] },
      status: "pending",
      createdAt: Date.now(),
      metadata: {
        platform: "telegram",
        channelMessageId: "2147483647",
        author: { id: "u-1", username: "alice", displayName: "Alice" },
        chat: { id: "123", name: "hiboss-test" },
      },
    };
    const group2: Envelope = {
      id: "env-g2",
      from: "channel:telegram:123",
      to: "agent:nex",
      fromBoss: true,
      content: { text: "Second message", attachments: [] },
      status: "pending",
      createdAt: Date.now(),
      metadata: {
        platform: "telegram",
        channelMessageId: "2147483646",
        author: { id: "u-2", username: "kky1024", displayName: "Kevin" },
        chat: { id: "123", name: "hiboss-test" },
      },
    };
    const agentEnvelope: Envelope = {
      id: "env-a1",
      from: "agent:scheduler",
      to: "agent:nex",
      fromBoss: false,
      content: { text: "Agent message", attachments: [] },
      status: "pending",
      createdAt: Date.now(),
    };

    const ctx = buildTurnPromptContext({
      agentName: "nex",
      datetimeMs: Date.now(),
      envelopes: [group1, group2, agentEnvelope],
    });
    const out = renderPrompt({ surface: "turn", template: "turn/turn.md", context: ctx }).trimEnd();

    const groupFromMatches = out.match(/from: channel:telegram:123/g) ?? [];
    assert.equal(groupFromMatches.length, 2, "group messages should print from per envelope");
    const senderMatches = out.match(/sender: .* in group \"hiboss-test\"/g) ?? [];
    assert.equal(senderMatches.length, 2, "group messages should print sender per envelope");
    assert.ok(out.includes("Alice (@alice)"), "group messages should include first author");
    assert.ok(out.includes("Kevin (@kky1024) [boss]"), "group messages should include boss marker");
    assert.ok(!out.includes("### Envelope "), "turn prompt should not include envelope headers");
  }
}

function validateCliEnvelopePrompt(): void {
  const baseEnvelope: Envelope = {
    id: "env-cli",
    from: "channel:telegram:123",
    to: "agent:nex",
    fromBoss: false,
    content: { text: "Hello", attachments: [] },
    status: "pending",
    createdAt: Date.now(),
    metadata: {
      platform: "telegram",
      channelMessageId: "m-1",
      author: { id: "u-1", username: "alice", displayName: "Alice" },
      chat: { id: "123", name: "hiboss-test" },
    },
  };

  // Without deliver-at
  {
    const ctx = buildCliEnvelopePromptContext({ envelope: baseEnvelope });
    const out = renderPrompt({
      surface: "cli-envelope",
      template: "envelope/instruction.md",
      context: ctx,
    }).trimEnd();
    assert.ok(out.includes("from:"), "cli envelope should include from");
    assert.ok(out.includes("sender:"), "cli envelope should include sender");
    assert.ok(!out.includes("deliver-at:"), "cli envelope should omit deliver-at when missing");
  }

  // With deliver-at
  {
    const withDeliverAt: Envelope = { ...baseEnvelope, deliverAt: Date.now() };
    const ctx = buildCliEnvelopePromptContext({ envelope: withDeliverAt });
    const out = renderPrompt({
      surface: "cli-envelope",
      template: "envelope/instruction.md",
      context: ctx,
    }).trimEnd();
    assert.ok(out.includes("deliver-at:"), "cli envelope should include deliver-at when present");
  }
}

function main(): void {
  validateSystemPrompt();
  validateTurnPrompt();
  validateCliEnvelopePrompt();
  console.log("ok: prompts rendered successfully");
}

main();
