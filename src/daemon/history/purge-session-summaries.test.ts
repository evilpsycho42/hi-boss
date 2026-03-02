import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { purgeSessionSummaryFields } from "./purge-session-summaries.js";
import { DEFAULT_HISTORY_CHAT_DIR } from "./chat-scope-path.js";
import { SESSION_FILE_VERSION } from "./types.js";

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

test("purgeSessionSummaryFields removes summary field from history files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-summary-purge-test-"));
  try {
    const agentsDir = path.join(root, "agents");
    const target = path.join(
      agentsDir,
      "alpha",
      "internal_space",
      "history",
      "2026-02-27",
      DEFAULT_HISTORY_CHAT_DIR,
      "s1.json",
    );
    const untouched = path.join(
      agentsDir,
      "beta",
      "internal_space",
      "history",
      "2026-02-27",
      "chat-1",
      "s2.json",
    );

    writeJson(target, {
      version: SESSION_FILE_VERSION,
      sessionId: "s1",
      agentName: "alpha",
      startedAtMs: 1,
      endedAtMs: null,
      summary: "to remove",
      events: [],
    });
    writeJson(untouched, {
      version: SESSION_FILE_VERSION,
      sessionId: "s2",
      agentName: "beta",
      startedAtMs: 1,
      endedAtMs: null,
      events: [],
    });

    purgeSessionSummaryFields({ agentsDir });

    const targetParsed = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
    const untouchedParsed = JSON.parse(fs.readFileSync(untouched, "utf8")) as Record<string, unknown>;

    assert.equal(Object.prototype.hasOwnProperty.call(targetParsed, "summary"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(untouchedParsed, "summary"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
