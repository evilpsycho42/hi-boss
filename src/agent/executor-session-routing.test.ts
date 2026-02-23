import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentExecutor } from "./executor.js";
import { HiBossDatabase } from "../daemon/db/database.js";

function withTempDb(run: (db: HiBossDatabase) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-executor-scope-test-"));
  const dbPath = path.join(dir, "hiboss.db");
  const db = new HiBossDatabase(dbPath);
  try {
    run(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function waitUntilIdle(
  executor: AgentExecutor,
  agentName: string,
  timeoutMs = 1000
): Promise<void> {
  const startedAt = Date.now();
  while (executor.isAgentBusy(agentName)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`executor did not become idle within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("abortCurrentRun skips queued tasks enqueued before abort generation bump", async () => {
  const executor = new AgentExecutor();
  const calls: string[] = [];

  let releaseFirst!: () => void;
  const firstRunGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  (executor as any).runSessionExecution = async (params: { envelopes: Array<{ id: string }> }) => {
    const id = params.envelopes[0]?.id;
    if (id) calls.push(id);
    if (id === "e1") {
      await firstRunGate;
    }
  };

  const agent = { name: "nex" } as any;
  const db = {} as any;
  const scope = { kind: "default", cacheKey: "default:nex" } as any;

  (executor as any).queueSessionExecution({
    agent,
    db,
    scope,
    envelopes: [{ id: "e1" }],
    refreshReasons: [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  (executor as any).queueSessionExecution({
    agent,
    db,
    scope,
    envelopes: [{ id: "e2" }],
    refreshReasons: [],
  });

  const cancelled = executor.abortCurrentRun("nex", "test:/abort");
  assert.equal(cancelled, true);

  releaseFirst();
  await waitUntilIdle(executor, "nex");

  assert.deepEqual(calls, ["e1"]);
});

test("resolveExecutionScope respects envelope channelSessionId pin even after active mapping changed", () => {
  withTempDb((db) => {
    db.registerAgent({ name: "nex", provider: "codex", role: "speaker" });

    const first = db.getOrCreateChannelActiveSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "boss-1",
      provider: "codex",
    }).session;

    const fresh = db.createFreshChannelSessionAndSwitch({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "boss-1",
      provider: "codex",
    }).newSession;

    assert.notEqual(first.id, fresh.id);

    const executor = new AgentExecutor();
    const agent = { name: "nex", provider: "codex" } as any;

    const pinnedEnvelope = {
      id: "env-1",
      from: "channel:telegram:chat-1",
      fromBoss: false,
      metadata: {
        channelSessionId: first.id,
        author: { id: "member-2" },
      },
    } as any;

    const scope = (executor as any).resolveExecutionScope(agent, db, pinnedEnvelope) as {
      kind: string;
      agentSessionId: string;
      ownerUserId?: string;
    };
    assert.equal(scope.kind, "channel");
    assert.equal(scope.agentSessionId, first.id);
    assert.equal(scope.ownerUserId, undefined);

    const bossEnvelope = {
      id: "env-2",
      from: "channel:telegram:chat-1",
      fromBoss: true,
      metadata: {
        channelSessionId: first.id,
        author: { id: "boss-1" },
      },
    } as any;
    const bossScope = (executor as any).resolveExecutionScope(agent, db, bossEnvelope) as {
      ownerUserId?: string;
    };
    assert.equal(bossScope.ownerUserId, "boss-1");
  });
});
