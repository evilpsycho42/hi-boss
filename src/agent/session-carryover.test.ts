import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeSessionFile } from "../daemon/history/session-file-io.js";
import type { SessionFile } from "../daemon/history/types.js";
import { INTERNAL_VERSION } from "../shared/version.js";
import { buildSessionCarryoverFromHistory, shouldBuildSessionCarryover } from "./session-carryover.js";

test("shouldBuildSessionCarryover only matches provider-triggered reasons", () => {
  assert.equal(shouldBuildSessionCarryover(undefined), false);
  assert.equal(shouldBuildSessionCarryover("telegram:/provider"), true);
  assert.equal(shouldBuildSessionCarryover("provider-mismatch:codex!=claude"), true);
  assert.equal(shouldBuildSessionCarryover("rpc:agent.set"), false);
});

test("buildSessionCarryoverFromHistory extracts bounded lines from latest events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-carryover-test-"));
  try {
    const filePath = path.join(dir, "s1.json");
    const session: SessionFile = {
      version: INTERNAL_VERSION,
      sessionId: "0f0f0f0f",
      agentName: "nex",
      startedAtMs: Date.now() - 5_000,
      endedAtMs: Date.now(),
      events: [
        {
          type: "envelope-created",
          timestampMs: 1_000,
          origin: "channel",
          envelope: {
            id: "e-1",
            from: "channel:telegram:chat-1",
            to: "agent:nex",
            fromBoss: false,
            content: { text: "hello from chat" },
            status: "pending",
            createdAt: 1_000,
          },
        },
        {
          type: "envelope-created",
          timestampMs: 2_000,
          origin: "internal",
          envelope: {
            id: "e-2",
            from: "agent:nex",
            to: "channel:telegram:chat-1",
            fromBoss: false,
            content: { text: "reply from agent" },
            status: "done",
            createdAt: 2_000,
          },
        },
      ],
    };
    writeSessionFile(filePath, session);

    const carryover = buildSessionCarryoverFromHistory({
      reason: "telegram:/provider",
      oldSessionFilePath: filePath,
      timezone: "UTC",
    });
    assert.ok(carryover);
    assert.equal(carryover?.reason, "provider-switch-history");
    assert.equal(carryover?.sourceSessionId, "0f0f0f0f");
    assert.equal(carryover?.messageCount, 2);
    assert.ok(carryover?.text.includes("channel:telegram:chat-1 -> agent:nex"));
    assert.ok(carryover?.text.includes("agent:nex -> channel:telegram:chat-1"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
