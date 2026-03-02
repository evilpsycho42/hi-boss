import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateHistoryChatLayout } from "./history-chat-layout-migration.js";
import { DEFAULT_HISTORY_CHAT_DIR } from "./chat-scope-path.js";
import { SESSION_FILE_VERSION } from "./types.js";

function writeSessionFile(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

test("migrateHistoryChatLayout moves legacy date/session files into date/chat/session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-history-chat-layout-test-"));
  try {
    const agentsDir = path.join(root, "agents");
    const date = "2026-03-01";

    const channelLegacy = path.join(
      agentsDir,
      "alpha",
      "internal_space",
      "history",
      date,
      "channel-session.json",
    );
    writeSessionFile(channelLegacy, {
      version: SESSION_FILE_VERSION,
      sessionId: "channel-session",
      agentName: "alpha",
      startedAtMs: 1,
      endedAtMs: null,
      events: [
        {
          type: "envelope-created",
          timestampMs: 1,
          origin: "channel",
          envelope: {
            id: "env-1",
            from: "channel:telegram:-100123",
            to: "agent:alpha",
            fromBoss: false,
            content: { text: "hello" },
            status: "pending",
            createdAt: 1,
            metadata: { origin: "channel" },
          },
        },
      ],
    });

    const defaultLegacy = path.join(
      agentsDir,
      "beta",
      "internal_space",
      "history",
      date,
      "default-session.json",
    );
    writeSessionFile(defaultLegacy, {
      version: SESSION_FILE_VERSION,
      sessionId: "default-session",
      agentName: "beta",
      startedAtMs: 2,
      endedAtMs: null,
      events: [],
    });

    migrateHistoryChatLayout({ dataDir: root, agentsDir });

    assert.equal(fs.existsSync(channelLegacy), false);
    assert.equal(fs.existsSync(defaultLegacy), false);

    const channelTarget = path.join(
      agentsDir,
      "alpha",
      "internal_space",
      "history",
      date,
      "-100123",
      "channel-session.json",
    );
    const defaultTarget = path.join(
      agentsDir,
      "beta",
      "internal_space",
      "history",
      date,
      DEFAULT_HISTORY_CHAT_DIR,
      "default-session.json",
    );
    assert.equal(fs.existsSync(channelTarget), true);
    assert.equal(fs.existsSync(defaultTarget), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
