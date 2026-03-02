import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildInitialSessionHistoryFrontmatter,
  serializeSessionHistoryMarkdown,
} from "./session-history-markdown.js";
import { readAgentInternalSessionHandoffSnapshot } from "./internal-space.js";

function withTempHiBoss(run: (hibossDir: string) => void): void {
  const hibossDir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-internal-space-handoff-test-"));
  try {
    run(hibossDir);
  } finally {
    fs.rmSync(hibossDir, { recursive: true, force: true });
  }
}

test("readAgentInternalSessionHandoffSnapshot returns summary and handoff blocks", () => {
  withTempHiBoss((hibossDir) => {
    const mdPath = path.join(
      hibossDir,
      "agents",
      "nex",
      "internal_space",
      "history",
      "2026-03-03",
      "chat-a",
      "s1.md",
    );
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });

    const doc = {
      frontmatter: {
        ...buildInitialSessionHistoryFrontmatter({
          sessionId: "s1",
          agentName: "nex",
          startedAtMs: Date.now() - 1000,
        }),
        endedAt: new Date().toISOString(),
        summary: "short summary",
        handoff: "do this next",
        handoffStatus: "ready" as const,
      },
      body: "",
    };
    fs.writeFileSync(mdPath, serializeSessionHistoryMarkdown(doc), "utf8");

    const snapshot = readAgentInternalSessionHandoffSnapshot({
      hibossDir,
      agentName: "nex",
      recentDays: 3,
      perSessionMaxChars: 24000,
    });

    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) return;
    assert.ok(snapshot.note.includes("session-id: s1"));
    assert.ok(snapshot.note.includes("summary:\nshort summary"));
    assert.ok(snapshot.note.includes("handoff:\ndo this next"));
    assert.ok(snapshot.note.includes(mdPath));
  });
});

test("readAgentInternalSessionHandoffSnapshot surfaces summary-unavailable placeholder", () => {
  withTempHiBoss((hibossDir) => {
    const mdPath = path.join(
      hibossDir,
      "agents",
      "nex",
      "internal_space",
      "history",
      "2026-03-03",
      "chat-a",
      "s2.md",
    );
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });

    const doc = {
      frontmatter: {
        ...buildInitialSessionHistoryFrontmatter({
          sessionId: "s2",
          agentName: "nex",
          startedAtMs: Date.now() - 1000,
        }),
        endedAt: new Date().toISOString(),
        summary: "",
        handoff: "",
        handoffStatus: "failed" as const,
      },
      body: "",
    };
    fs.writeFileSync(mdPath, serializeSessionHistoryMarkdown(doc), "utf8");

    const snapshot = readAgentInternalSessionHandoffSnapshot({
      hibossDir,
      agentName: "nex",
      recentDays: 3,
      perSessionMaxChars: 24000,
    });

    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) return;
    assert.ok(snapshot.note.includes("summary:\nsummary-unavailable"));
  });
});
