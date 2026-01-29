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
    createdAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
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
      createdAt: new Date().toISOString(),
      metadata: {
        platform: "telegram",
        channelMessageId: "m-1",
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
      createdAt: new Date().toISOString(),
    },
  ];
}

function validateSystemPrompt(): void {
  const hibossDir = mkTmpDir("hiboss-state-");
  const workspaceDir = mkTmpDir("hiboss-workspace-");

  const agentName = "nex";
  fs.mkdirSync(path.join(hibossDir, "agents", agentName), { recursive: true });
  writeFile(path.join(hibossDir, "agents", agentName, "SOUL.md"), "# SOUL.md\n\nBe concise.\n");
  writeFile(path.join(hibossDir, "USER.md"), "# USER.md\n\n- Name: Kevin\n");

  const agent = makeMockAgent(workspaceDir);
  const ctx = buildSystemPromptContext({
    agent,
    agentToken: agent.token,
    bindings: makeMockBindings(),
    hibossDir,
  });
  (ctx.hiboss as Record<string, unknown>).additionalContext = "Extra line.";

  const out = renderPrompt({ surface: "system", template: "system/base.md", context: ctx });
  assert.ok(out.includes("# Agent:"), "system prompt should include agent header");
  assert.ok(out.includes("## Your Identity"), "system prompt should include identity section");
  assert.ok(out.includes("## Customization"), "system prompt should include customization section");
}

function validateTurnPrompt(): void {
  // 0 envelopes
  {
    const ctx = buildTurnPromptContext({
      agentName: "nex",
      datetimeIso: new Date().toISOString(),
      envelopes: [],
    });
    const out = renderPrompt({ surface: "turn", template: "turn/turn.md", context: ctx }).trimEnd();
    assert.ok(out.includes("## Turn Context"), "turn prompt should include context");
    assert.ok(out.includes("## Pending Envelopes (0)"), "turn prompt should show 0 envelopes");
  }

  // N envelopes
  {
    const ctx = buildTurnPromptContext({
      agentName: "nex",
      datetimeIso: new Date().toISOString(),
      envelopes: makeMockEnvelopes(),
    });
    const out = renderPrompt({ surface: "turn", template: "turn/turn.md", context: ctx }).trimEnd();
    assert.ok(out.includes("### Envelope 1"), "turn prompt should render envelope 1");
    assert.ok(out.includes("from-name:"), "turn prompt should include from-name for channel messages");
    assert.ok(out.includes("attachments:"), "turn prompt should include attachments section");
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
    createdAt: new Date().toISOString(),
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
    assert.ok(out.includes("from-name:"), "cli envelope should include from-name");
    assert.ok(!out.includes("deliver-at:"), "cli envelope should omit deliver-at when missing");
  }

  // With deliver-at
  {
    const withDeliverAt: Envelope = { ...baseEnvelope, deliverAt: new Date().toISOString() };
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
