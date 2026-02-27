import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { archiveLegacyHistoryV1 } from "./legacy-history-archive.js";

function writeSessionFile(filePath: string, version: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      version,
      sessionId: "abcd1234",
      agentName: "agent",
      startedAtMs: Date.now(),
      endedAtMs: null,
      summary: null,
      conversations: [],
      events: [],
    }),
    "utf8",
  );
}

test("archiveLegacyHistoryV1 moves only legacy v1 history directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-history-archive-test-"));
  try {
    const agentsDir = path.join(root, "agents");
    const alphaHistory = path.join(agentsDir, "alpha", "internal_space", "history");
    const betaHistory = path.join(agentsDir, "beta", "internal_space", "history");

    writeSessionFile(path.join(alphaHistory, "2026-02-26", "s1.json"), 1);
    writeSessionFile(path.join(betaHistory, "2026-02-26", "s2.json"), 2);

    archiveLegacyHistoryV1({ dataDir: root, agentsDir });

    assert.equal(fs.existsSync(alphaHistory), false);
    assert.equal(fs.existsSync(betaHistory), true);

    const archiveRoot = path.join(root, "_archive");
    assert.equal(fs.existsSync(archiveRoot), true);
    const archiveRuns = fs.readdirSync(archiveRoot);
    assert.ok(archiveRuns.length >= 1);
    const archivedAlphaHistory = path.join(archiveRoot, archiveRuns[0]!, "alpha", "history");
    assert.equal(fs.existsSync(archivedAlphaHistory), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
