import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HiBossDatabase } from "../daemon/db/database.js";
import type { AgentSession } from "./executor-support.js";
import { getOrCreateAgentSession } from "./executor-session.js";
import { readPersistedAgentSession } from "./persisted-session.js";

async function withTempDb(run: (params: { db: HiBossDatabase; hibossDir: string }) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-executor-session-test-"));
  const dbPath = path.join(dir, "hiboss.db");
  const hibossDir = path.join(dir, "hiboss-home");
  fs.mkdirSync(hibossDir, { recursive: true });
  let db: HiBossDatabase | null = null;
  try {
    db = new HiBossDatabase(dbPath);
    await run({ db, hibossDir });
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("getOrCreateAgentSession refreshes in-memory session on provider mismatch", async () => {
  await withTempDb(async ({ db, hibossDir }) => {
    db.registerAgent({ name: "nex", provider: "claude" });
    db.setAgentMetadataSessionHandle("nex", {
      version: 1,
      provider: "codex",
      handle: { provider: "codex", sessionId: "thread-old" },
      createdAtMs: Date.now() - 10_000,
      updatedAtMs: Date.now() - 10_000,
    });

    const agent = db.getAgentByName("nex");
    assert.ok(agent);

    const sessions = new Map<string, AgentSession>();
    sessions.set("nex", {
      provider: "codex",
      agentToken: "old-token",
      systemInstructions: "old-instructions",
      workspace: hibossDir,
      createdAtMs: Date.now() - 20_000,
    });

    const refreshReasons: string[] = [];
    const session = await getOrCreateAgentSession({
      agent,
      db,
      hibossDir,
      sessions,
      applyPendingSessionRefresh: async () => [],
      refreshSession: async (agentName, reason) => {
        refreshReasons.push(reason ?? "");
        sessions.delete(agentName);
        db.setAgentMetadataSessionHandle(agentName, null);
      },
      getSessionPolicy: () => ({}),
    });

    assert.deepEqual(refreshReasons, ["provider-mismatch:codex!=claude"]);
    assert.equal(session.provider, "claude");
    assert.equal(sessions.get("nex")?.provider, "claude");

    const refreshedAgent = db.getAgentByName("nex");
    assert.ok(refreshedAgent);
    assert.equal(readPersistedAgentSession(refreshedAgent), null);
  });
});
