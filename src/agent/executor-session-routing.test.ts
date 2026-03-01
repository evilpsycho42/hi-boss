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
  let db: HiBossDatabase | null = null;
  try {
    db = new HiBossDatabase(dbPath);
    run(db);
  } finally {
    db?.close();
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

test("abortCurrentRun skips old queued tasks but allows new tasks queued after abort", async () => {
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

  (executor as any).queueSessionExecution({
    agent,
    db,
    scope,
    envelopes: [{ id: "e3" }],
    refreshReasons: [],
  });

  releaseFirst();
  await waitUntilIdle(executor, "nex");

  assert.deepEqual(calls, ["e1", "e3"]);
});

test("resolveExecutionScope respects envelope channelSessionId pin even after default mapping changed", () => {
  withTempDb((db) => {
    db.registerAgent({ name: "nex", provider: "codex" });

    const first = db.getOrCreateChannelDefaultSession({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "token-boss",
      provider: "codex",
    }).session;

    const fresh = db.createFreshChannelSessionAndSetDefault({
      agentName: "nex",
      adapterType: "telegram",
      chatId: "chat-1",
      ownerUserId: "token-boss",
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
        userToken: "token-member",
      },
    } as any;

    const scope = (executor as any).resolveExecutionScope(agent, db, pinnedEnvelope) as {
      kind: string;
      agentSessionId: string;
      ownerUserId?: string;
    };
    assert.equal(scope.kind, "channel");
    assert.equal(scope.agentSessionId, first.id);
    assert.equal(scope.ownerUserId, "token-member");

    const bossEnvelope = {
      id: "env-2",
      from: "channel:telegram:chat-1",
      fromBoss: true,
      metadata: {
        channelSessionId: first.id,
        userToken: "token-boss",
      },
    } as any;
    const bossScope = (executor as any).resolveExecutionScope(agent, db, bossEnvelope) as {
      ownerUserId?: string;
    };
    assert.equal(bossScope.ownerUserId, "token-boss");
  });
});

test("resolveExecutionScope routes agent-origin chatScope via internal channel sessions", () => {
  withTempDb((db) => {
    db.registerAgent({ name: "nex", provider: "claude" });

    const executor = new AgentExecutor();
    const agent = { name: "nex", provider: "claude" } as any;

    const dmEnvelope = {
      id: "env-direct",
      from: "agent:other",
      to: "agent:nex",
      fromBoss: false,
      metadata: {
        chatScope: "agent-dm:alice:bob",
      },
    } as any;
    const dmScope = (executor as any).resolveExecutionScope(agent, db, dmEnvelope) as {
      kind: string;
      agentSessionId?: string;
      adapterType?: string;
      chatId?: string;
    };
    assert.equal(dmScope.kind, "channel");
    assert.equal(dmScope.adapterType, "internal");
    assert.equal(dmScope.chatId, "agent-dm:alice:bob");

    const teamEnvelope = {
      id: "env-team",
      from: "agent:other",
      to: "agent:nex",
      fromBoss: false,
      metadata: {
        chatScope: "team:research",
      },
    } as any;
    const teamScope = (executor as any).resolveExecutionScope(agent, db, teamEnvelope) as {
      kind: string;
      agentSessionId?: string;
      adapterType?: string;
      chatId?: string;
    };
    assert.equal(teamScope.kind, "channel");
    assert.equal(teamScope.adapterType, "internal");
    assert.equal(teamScope.chatId, "team:research");
    assert.notEqual(teamScope.agentSessionId, dmScope.agentSessionId);
  });
});

test("resolveExecutionScope keeps backward compatibility for agent envelopes without chatScope", () => {
  withTempDb((db) => {
    db.registerAgent({ name: "nex", provider: "claude" });
    const executor = new AgentExecutor();
    const agent = { name: "nex", provider: "claude" } as any;

    const env = {
      id: "env-default",
      from: "agent:other",
      to: "agent:nex",
      fromBoss: false,
      metadata: { origin: "cli" },
    } as any;

    const scope = (executor as any).resolveExecutionScope(agent, db, env) as {
      kind: string;
    };
    assert.equal(scope.kind, "default");
  });
});

test("resolveExecutionScope ignores chatScope for channel-origin envelopes", () => {
  withTempDb((db) => {
    db.registerAgent({ name: "nex", provider: "claude" });
    const executor = new AgentExecutor();
    const agent = { name: "nex", provider: "claude" } as any;

    const channelEnvelope = {
      id: "env-channel",
      from: "channel:telegram:chat-1",
      to: "agent:nex",
      fromBoss: false,
      metadata: {
        chatScope: "team:research",
      },
    } as any;
    const channelScope = (executor as any).resolveExecutionScope(agent, db, channelEnvelope) as {
      kind: string;
      agentSessionId?: string;
      adapterType?: string;
      chatId?: string;
    };
    assert.equal(channelScope.kind, "channel");
    assert.equal(channelScope.adapterType, "telegram");
    assert.equal(channelScope.chatId, "chat-1");
  });
});
