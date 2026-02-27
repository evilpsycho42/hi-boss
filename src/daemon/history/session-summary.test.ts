import assert from "node:assert/strict";
import test from "node:test";

import { generateSessionSummary } from "./session-summary.js";
import type { SessionFile } from "./types.js";

function makeBaseSession(events: SessionFile["events"]): SessionFile {
  return {
    version: 2,
    sessionId: "abcd1234",
    agentName: "nex",
    startedAtMs: Date.now(),
    endedAtMs: null,
    summary: null,
    events,
  };
}

test("generateSessionSummary returns null when there are no text envelope-created events", async () => {
  const now = Date.now();
  const sessionFile = makeBaseSession([
    {
      type: "envelope-status-changed",
      timestampMs: now,
      origin: "internal",
      envelopeId: "env-1",
      fromStatus: "pending",
      toStatus: "done",
      reason: "ack",
    },
    {
      type: "envelope-created",
      timestampMs: now,
      origin: "internal",
      envelope: {
        id: "env-2",
        from: "agent:a",
        to: "agent:b",
        fromBoss: false,
        content: {
          attachments: [{ source: "/tmp/file.bin" }],
        },
        status: "pending",
        createdAt: now,
      },
    },
  ]);

  const summary = await generateSessionSummary({ sessionFile });
  assert.equal(summary, null);
});
