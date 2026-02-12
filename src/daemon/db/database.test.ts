import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HiBossDatabase } from "./database.js";

function withTempDb(run: (db: HiBossDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-db-test-"));
  const dbPath = path.join(dir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);
  try {
    run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("getAgentRoleCounts infers legacy roles from bindings", () => {
  withTempDb((db) => {
    db.registerAgent({
      name: "speakerish",
      provider: "codex",
      role: undefined,
    });
    db.registerAgent({
      name: "leaderish",
      provider: "codex",
      role: undefined,
    });

    db.createBinding("speakerish", "telegram", "123456:abcDEF");

    assert.deepEqual(db.getAgentRoleCounts(), { speaker: 1, leader: 1 });
  });
});

test("getAgentRoleCounts prefers explicit metadata.role over binding inference", () => {
  withTempDb((db) => {
    db.registerAgent({
      name: "explicit-leader",
      provider: "codex",
      role: "leader",
    });

    db.createBinding("explicit-leader", "telegram", "123456:abcDEF");

    assert.deepEqual(db.getAgentRoleCounts(), { speaker: 0, leader: 1 });
  });
});
