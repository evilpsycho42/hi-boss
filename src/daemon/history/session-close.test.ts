import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConversationHistory } from "./conversation-history.js";
import { closeActiveSession, closeSessionByPath } from "./session-close.js";
import { readSessionFile } from "./session-file-io.js";

async function withTempAgentsDir(run: (agentsDir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-session-close-test-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("closeSessionByPath sets endedAtMs", async () => {
  await withTempAgentsDir((agentsDir) => {
    const history = new ConversationHistory({ agentsDir, timezone: "UTC" });
    history.startSession("alpha");
    const filePath = history.getCurrentSessionFilePath("alpha");
    assert.ok(filePath);

    const endedAtMs = Date.now();
    closeSessionByPath({ filePath: filePath!, agentName: "alpha", endedAtMs });

    const session = readSessionFile(filePath!);
    assert.ok(session);
    assert.equal(session?.endedAtMs, endedAtMs);
  });
});

test("closeActiveSession sets endedAtMs and clears active marker", async () => {
  await withTempAgentsDir((agentsDir) => {
    const history = new ConversationHistory({ agentsDir, timezone: "UTC" });
    history.startSession("beta");
    const filePath = history.getCurrentSessionFilePath("beta");
    assert.ok(filePath);

    const endedAtMs = Date.now();
    closeActiveSession({ history, agentName: "beta", endedAtMs });

    const session = readSessionFile(filePath!);
    assert.ok(session);
    assert.equal(session?.endedAtMs, endedAtMs);
    assert.equal(history.getCurrentSessionFilePath("beta"), null);
  });
});
