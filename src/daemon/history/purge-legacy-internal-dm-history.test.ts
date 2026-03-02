import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { purgeLegacyInternalDmHistory } from "./purge-legacy-internal-dm-history.js";

test("purgeLegacyInternalDmHistory removes only agent-dm chat directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-legacy-dm-history-test-"));
  try {
    const agentsDir = path.join(root, "agents");
    const dateDir = path.join(
      agentsDir,
      "nex",
      "internal_space",
      "history",
      "2026-03-02",
    );
    fs.mkdirSync(dateDir, { recursive: true });

    const legacyChatDir = path.join(dateDir, encodeURIComponent("agent-dm:alice:bob"));
    const keptChatDir = path.join(dateDir, encodeURIComponent("agent-chat-123"));
    fs.mkdirSync(legacyChatDir, { recursive: true });
    fs.mkdirSync(keptChatDir, { recursive: true });
    fs.writeFileSync(path.join(legacyChatDir, "s1.json"), "{\"version\":\"v0.0.0\",\"events\":[]}", "utf8");
    fs.writeFileSync(path.join(keptChatDir, "s2.json"), "{\"version\":\"v0.0.0\",\"events\":[]}", "utf8");

    purgeLegacyInternalDmHistory({ agentsDir });

    assert.equal(fs.existsSync(legacyChatDir), false);
    assert.equal(fs.existsSync(keptChatDir), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

