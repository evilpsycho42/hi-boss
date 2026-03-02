import assert from "node:assert/strict";
import test from "node:test";

import {
  parseClaudeTraceEntries,
  parseCodexFailureMessage,
  parseCodexTraceEntries,
} from "./provider-cli-parsers.js";

test("parseCodexFailureMessage prefers turn.failed error message", () => {
  const stdout = [
    "{\"type\":\"thread.started\",\"thread_id\":\"abc\"}",
    "{\"type\":\"error\",\"message\":\"Reconnecting... 1/5 (...)\"}",
    "{\"type\":\"turn.failed\",\"error\":{\"message\":\"unexpected status 401 Unauthorized\"}}",
  ].join("\n");

  const message = parseCodexFailureMessage(stdout);
  assert.equal(message, "unexpected status 401 Unauthorized");
});

test("parseCodexFailureMessage falls back to last error event", () => {
  const stdout = [
    "{\"type\":\"error\",\"message\":\"Reconnecting... 1/5\"}",
    "{\"type\":\"error\",\"message\":\"unexpected status 429 Too Many Requests\"}",
  ].join("\n");

  const message = parseCodexFailureMessage(stdout);
  assert.equal(message, "unexpected status 429 Too Many Requests");
});

test("parseCodexFailureMessage returns null when no error events are present", () => {
  const stdout = [
    "{\"type\":\"thread.started\",\"thread_id\":\"abc\"}",
    "{\"type\":\"turn.started\"}",
    "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"OK\"}}",
    "{\"type\":\"turn.completed\"}",
  ].join("\n");

  const message = parseCodexFailureMessage(stdout);
  assert.equal(message, null);
});

test("parseClaudeTraceEntries includes assistant text and tool calls only", () => {
  const stdout = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I will inspect files." },
          { type: "tool_use", name: "Bash", input: { cmd: "ls -la" } },
          { type: "thinking", text: "hidden thinking" },
          { type: "tool_result", content: "ignored" },
        ],
      },
    }),
  ].join("\n");

  const entries = parseClaudeTraceEntries(stdout);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { type: "assistant", text: "I will inspect files." });
  assert.equal(entries[1]?.type, "tool-call");
  assert.equal(entries[1]?.toolName, "Bash");
  assert.equal(entries[1]?.text.includes("input="), true);
});

test("parseCodexTraceEntries includes assistant text and tool calls only", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        content: [
          { type: "output_text", text: "I inspected the repo." },
          { type: "reasoning", text: "ignore me" },
        ],
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "function_call",
        name: "bash",
        arguments: { cmd: "ls -la" },
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "function_call_output",
        output: "ignored tool result",
      },
    }),
  ].join("\n");

  const entries = parseCodexTraceEntries(stdout);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { type: "assistant", text: "I inspected the repo." });
  assert.equal(entries[1]?.type, "tool-call");
  assert.equal(entries[1]?.toolName, "bash");
  assert.equal(entries[1]?.text.includes("input="), true);
});

test("parseCodexTraceEntries keeps the latest entries when maxEntries is reached", () => {
  const lines: string[] = [];
  for (let i = 1; i <= 5; i++) {
    lines.push(JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: `step ${i}`,
      },
    }));
  }

  const entries = parseCodexTraceEntries(lines.join("\n"), { maxEntries: 3 });
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ["step 3", "step 4", "step 5"],
  );
});

test("parseClaudeTraceEntries keeps the latest entries when maxEntries is reached", () => {
  const lines: string[] = [];
  for (let i = 1; i <= 5; i++) {
    lines.push(JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: `step ${i}` }],
      },
    }));
  }

  const entries = parseClaudeTraceEntries(lines.join("\n"), { maxEntries: 3 });
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ["step 3", "step 4", "step 5"],
  );
});
