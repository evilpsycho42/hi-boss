import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Envelope } from "../../envelope/types.js";
import { ConversationHistory } from "./conversation-history.js";
import { readSessionFile } from "./session-file-io.js";

async function withTempAgentsDir(run: (agentsDir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-history-test-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeEnvelope(params: {
  id: string;
  from: string;
  to: string;
  text?: string;
}): Envelope {
  return {
    id: params.id,
    from: params.from,
    to: params.to,
    fromBoss: false,
    content: params.text
      ? { text: params.text }
      : {
          attachments: [{ source: "/tmp/file.bin" }],
        },
    status: "pending",
    createdAt: Date.now(),
    metadata: { origin: "internal" },
  };
}

async function waitForHistoryWrites(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("appendEnvelopeCreated records envelope event for both agent participants", async () => {
  await withTempAgentsDir(async (agentsDir) => {
    const history = new ConversationHistory({ agentsDir, timezone: "UTC" });
    const envelope = makeEnvelope({
      id: "env-a",
      from: "agent:alpha",
      to: "agent:beta",
    });

    history.appendEnvelopeCreated({
      envelope,
      origin: "internal",
      timestampMs: envelope.createdAt,
    });
    await waitForHistoryWrites();

    const alphaPath = history.getCurrentSessionFilePath("alpha");
    const betaPath = history.getCurrentSessionFilePath("beta");
    assert.ok(alphaPath);
    assert.ok(betaPath);

    const alpha = readSessionFile(alphaPath!);
    const beta = readSessionFile(betaPath!);
    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha?.events.length, 1);
    assert.equal(beta?.events.length, 1);
    assert.equal(alpha?.events[0]?.type, "envelope-created");
    assert.equal(beta?.events[0]?.type, "envelope-created");
  });
});

test("appendStatusChange records status event for both agent participants", async () => {
  await withTempAgentsDir(async (agentsDir) => {
    const history = new ConversationHistory({ agentsDir, timezone: "UTC" });
    const envelope = makeEnvelope({
      id: "env-b",
      from: "agent:alpha",
      to: "agent:beta",
      text: "hello",
    });

    history.appendEnvelopeCreated({
      envelope,
      origin: "internal",
      timestampMs: envelope.createdAt,
    });
    history.appendStatusChange({
      envelope: {
        ...envelope,
        status: "done",
      },
      fromStatus: "pending",
      toStatus: "done",
      timestampMs: Date.now(),
      origin: "internal",
      reason: "test-change",
      outcome: "executed",
    });
    await waitForHistoryWrites();

    const alpha = readSessionFile(history.getCurrentSessionFilePath("alpha")!);
    const beta = readSessionFile(history.getCurrentSessionFilePath("beta")!);
    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha?.events.length, 2);
    assert.equal(beta?.events.length, 2);
    assert.equal(alpha?.events[1]?.type, "envelope-status-changed");
    assert.equal(beta?.events[1]?.type, "envelope-status-changed");
  });
});
