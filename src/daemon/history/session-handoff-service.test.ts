import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Envelope } from "../../envelope/types.js";
import { HiBossDatabase } from "../db/database.js";
import { SessionHandoffService } from "./session-handoff-service.js";
import { appendEvent, closeSessionFile, createSessionFile } from "./session-file-io.js";
import { getSessionMarkdownPath, readSessionMarkdownFile } from "./session-markdown-file-io.js";

function makeEnvelope(id: string): Envelope {
  return {
    id,
    from: "agent:boss",
    to: "agent:nex",
    fromBoss: true,
    content: { text: "Please continue this task" },
    status: "pending",
    createdAt: Date.now(),
    metadata: { origin: "internal" },
  };
}

async function withTempState(run: (params: { hibossDir: string; db: HiBossDatabase }) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-session-handoff-test-"));
  const hibossDir = path.join(root, "hiboss");
  fs.mkdirSync(path.join(hibossDir, ".daemon"), { recursive: true });
  const dbPath = path.join(hibossDir, ".daemon", "hiboss.db");
  const db = new HiBossDatabase(dbPath);
  try {
    await run({ hibossDir, db });
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("SessionHandoffService backfills markdown and writes handoff on success", async () => {
  await withTempState(async ({ hibossDir, db }) => {
    db.registerAgent({ name: "nex", provider: "codex" });

    const sessionJsonPath = path.join(
      hibossDir,
      "agents",
      "nex",
      "internal_space",
      "history",
      "2026-03-03",
      "chat-a",
      "s1.json",
    );
    const startedAtMs = Date.now() - 1_000;
    createSessionFile({
      filePath: sessionJsonPath,
      sessionId: "s1",
      agentName: "nex",
      startedAtMs,
    });
    appendEvent(sessionJsonPath, {
      type: "envelope-created",
      timestampMs: startedAtMs,
      origin: "internal",
      envelope: makeEnvelope("e1"),
    });
    closeSessionFile(sessionJsonPath, Date.now());

    const service = new SessionHandoffService({
      db,
      hibossDir,
      generateHandoff: async () => ({
        summary: "summary text",
        handoff: "handoff text",
      }),
    });
    await service.runOnce();

    const markdown = readSessionMarkdownFile(getSessionMarkdownPath(sessionJsonPath));
    assert.ok(markdown);
    assert.equal(markdown?.frontmatter.handoffStatus, "ready");
    assert.equal(markdown?.frontmatter.summary, "summary text");
    assert.equal(markdown?.frontmatter.handoff, "handoff text");
    assert.equal(markdown?.frontmatter.handoffAttempts, 1);
  });
});

test("SessionHandoffService stops after max retries and marks failed", async () => {
  await withTempState(async ({ hibossDir, db }) => {
    db.registerAgent({ name: "nex", provider: "codex" });

    const sessionJsonPath = path.join(
      hibossDir,
      "agents",
      "nex",
      "internal_space",
      "history",
      "2026-03-03",
      "chat-a",
      "s2.json",
    );
    const startedAtMs = Date.now() - 1_000;
    createSessionFile({
      filePath: sessionJsonPath,
      sessionId: "s2",
      agentName: "nex",
      startedAtMs,
    });
    appendEvent(sessionJsonPath, {
      type: "envelope-created",
      timestampMs: startedAtMs,
      origin: "internal",
      envelope: makeEnvelope("e2"),
    });
    closeSessionFile(sessionJsonPath, Date.now());

    const service = new SessionHandoffService({
      db,
      hibossDir,
      generateHandoff: async () => {
        throw new Error("provider failure");
      },
    });

    await service.runOnce();
    await service.runOnce();
    await service.runOnce();
    await service.runOnce();

    const markdown = readSessionMarkdownFile(getSessionMarkdownPath(sessionJsonPath));
    assert.ok(markdown);
    assert.equal(markdown?.frontmatter.handoffStatus, "failed");
    assert.equal(markdown?.frontmatter.handoffAttempts, 3);
    assert.equal(markdown?.frontmatter.summary, "summary-unavailable");
  });
});
