import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Agent } from "../../agent/types.js";
import type { CreateEnvelopeInput, Envelope } from "../../envelope/types.js";
import { HiBossDatabase } from "../db/database.js";
import { RPC_ERRORS } from "../ipc/types.js";
import { createTeamHandlers } from "./team-handlers.js";
import type { DaemonContext } from "./context.js";
import { INTERNAL_VERSION } from "../../shared/version.js";

async function withTempDb(
  run: (params: { db: HiBossDatabase; dataDir: string }) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hiboss-team-handlers-test-"));
  const dbPath = path.join(dir, "hiboss.db");
  const dataDir = path.join(dir, "hiboss-home");
  fs.mkdirSync(dataDir, { recursive: true });
  let db: HiBossDatabase | null = null;
  try {
    db = new HiBossDatabase(dbPath);
    await run({ db, dataDir });
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createContext(params: {
  db: HiBossDatabase;
  dataDir: string;
  reloadedAgentNames: string[];
  principal?: { kind: "admin" } | { kind: "agent"; agentName: string };
  routeEnvelope?: (input: CreateEnvelopeInput) => Promise<Envelope>;
  abortCurrentRun?: (agentName: string, reason: string) => boolean;
}): DaemonContext {
  let sequence = 0;
  const routeEnvelope = params.routeEnvelope ?? (async (input: CreateEnvelopeInput) => ({
    id: `env-${++sequence}`,
    from: input.from,
    to: input.to,
    fromBoss: input.fromBoss ?? false,
    content: input.content,
    priority: input.priority,
    deliverAt: input.deliverAt,
    status: "pending",
    createdAt: Date.now(),
    metadata: input.metadata,
  }));

  const principal = params.principal ?? { kind: "admin" as const };

  return {
    db: params.db,
    router: {
      routeEnvelope,
    } as unknown as DaemonContext["router"],
    executor: {
      requestSessionContextReload: (agentName: string) => {
        params.reloadedAgentNames.push(agentName);
      },
      abortCurrentRun: params.abortCurrentRun ?? (() => false),
    } as unknown as DaemonContext["executor"],
    scheduler: {
      onEnvelopeCreated: () => undefined,
    } as unknown as DaemonContext["scheduler"],
    cronScheduler: null,
    adapters: new Map(),
    config: {
      dataDir: params.dataDir,
      daemonDir: path.join(params.dataDir, ".daemon"),
    },
    running: true,
    startTimeMs: Date.now(),
    resolvePrincipal: () => {
      if (principal.kind === "admin") {
        return { kind: "admin", level: "admin" } as const;
      }
      const agent = params.db.getAgentByNameCaseInsensitive(principal.agentName);
      if (!agent) throw new Error(`Missing agent for test principal: ${principal.agentName}`);
      return {
        kind: "agent",
        level: (agent.permissionLevel ?? "restricted"),
        agent: agent as Agent,
      } as const;
    },
    assertOperationAllowed: () => undefined,
    getPermissionPolicy: () => ({ version: INTERNAL_VERSION, operations: {} }),
    createAdapterForBinding: async () => null,
    removeAdapter: async () => undefined,
    registerAgentHandler: () => undefined,
  };
}

async function assertRpcError(
  fn: () => Promise<unknown>,
  expectedCode: number,
  expectedMessageIncludes: string,
): Promise<void> {
  await assert.rejects(
    fn,
    (err: unknown) => {
      const e = err as Error & { code?: number };
      assert.equal(e.code, expectedCode);
      assert.equal(e.message.includes(expectedMessageIncludes), true);
      return true;
    },
  );
}

test("team.add-member triggers context reload for all active team members", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "alice" });
    db.registerAgent({ name: "bob" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "bob" });

    const reloaded: string[] = [];
    const ctx = createContext({ db, dataDir, reloadedAgentNames: reloaded });
    const handlers = createTeamHandlers(ctx);

    const result = await handlers["team.add-member"]({
      token: "admin-token",
      teamName: "alpha",
      agentName: "alice",
    });

    assert.equal((result as { success: boolean }).success, true);
    assert.deepEqual(reloaded.sort(), ["alice", "bob"]);
  });
});

test("team.remove-member triggers context reload for removed and remaining active members", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "alice" });
    db.registerAgent({ name: "bob" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });
    db.addTeamMember({ teamName: "alpha", agentName: "bob" });

    const reloaded: string[] = [];
    const ctx = createContext({ db, dataDir, reloadedAgentNames: reloaded });
    const handlers = createTeamHandlers(ctx);

    const result = await handlers["team.remove-member"]({
      token: "admin-token",
      teamName: "alpha",
      agentName: "alice",
    });

    assert.equal((result as { success: boolean }).success, true);
    assert.deepEqual(reloaded.sort(), ["alice", "bob"]);
  });
});

test("team.set triggers context reload only when status changes", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "alice" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });

    const reloaded: string[] = [];
    const ctx = createContext({ db, dataDir, reloadedAgentNames: reloaded });
    const handlers = createTeamHandlers(ctx);

    await handlers["team.set"]({
      token: "admin-token",
      teamName: "alpha",
      description: "updated description",
    });
    assert.deepEqual(reloaded, []);

    await handlers["team.set"]({
      token: "admin-token",
      teamName: "alpha",
      status: "archived",
    });
    assert.deepEqual(reloaded, ["alice"]);
  });
});

test("team.delete triggers context reload for active team members", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "alice" });
    db.registerAgent({ name: "bob" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });
    db.addTeamMember({ teamName: "alpha", agentName: "bob" });

    const reloaded: string[] = [];
    const ctx = createContext({ db, dataDir, reloadedAgentNames: reloaded });
    const handlers = createTeamHandlers(ctx);

    const result = await handlers["team.delete"]({
      token: "admin-token",
      teamName: "alpha",
    });

    assert.equal((result as { success: boolean }).success, true);
    assert.deepEqual(reloaded.sort(), ["alice", "bob"]);
  });
});

test("team.list-members returns sorted member records", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "alice" });
    db.registerAgent({ name: "bob" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });
    db.addTeamMember({ teamName: "alpha", agentName: "bob" });

    const ctx = createContext({ db, dataDir, reloadedAgentNames: [] });
    const handlers = createTeamHandlers(ctx);
    const result = await handlers["team.list-members"]({
      token: "admin-token",
      teamName: "alpha",
    }) as {
      teamName: string;
      members: Array<{ agentName: string; source: string; createdAt: number }>;
    };

    assert.equal(result.teamName, "alpha");
    assert.deepEqual(result.members.map((item) => item.agentName), ["alice", "bob"]);
    assert.equal(result.members.every((item) => item.source === "manual"), true);
    assert.equal(result.members.every((item) => item.createdAt > 0), true);
  });
});

test("team.list-members returns not found for missing team", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    const ctx = createContext({ db, dataDir, reloadedAgentNames: [] });
    const handlers = createTeamHandlers(ctx);
    await assertRpcError(
      () => handlers["team.list-members"]({
        token: "admin-token",
        teamName: "alpha",
      }),
      RPC_ERRORS.NOT_FOUND,
      "Team not found",
    );
  });
});

test("team.send fans out to team members and excludes sender", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "sender" });
    db.registerAgent({ name: "alice" });
    db.registerAgent({ name: "bob" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "sender" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });
    db.addTeamMember({ teamName: "alpha", agentName: "bob" });

    const routeCalls: CreateEnvelopeInput[] = [];
    const ctx = createContext({
      db,
      dataDir,
      reloadedAgentNames: [],
      principal: { kind: "agent", agentName: "sender" },
      routeEnvelope: async (input) => {
        routeCalls.push(input);
        return {
          id: `env-${routeCalls.length}`,
          from: input.from,
          to: input.to,
          fromBoss: false,
          content: input.content,
          priority: input.priority,
          status: "pending",
          createdAt: Date.now(),
          metadata: input.metadata,
        };
      },
    });
    const handlers = createTeamHandlers(ctx);

    const result = await handlers["team.send"]({
      token: "sender-token",
      teamName: "alpha",
      text: "hello team",
    }) as {
      requestedCount: number;
      sentCount: number;
      failedCount: number;
      results: Array<{ agentName: string; success: boolean; envelopeId?: string }>;
    };

    assert.equal(result.requestedCount, 2);
    assert.equal(result.sentCount, 2);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(result.results.map((item) => item.agentName), ["alice", "bob"]);
    assert.equal(result.results.every((item) => item.success), true);
    assert.deepEqual(routeCalls.map((item) => item.to), ["agent:alice", "agent:bob"]);
    assert.deepEqual(routeCalls.map((item) => item.from), ["agent:sender", "agent:sender"]);
  });
});

test("team.send returns empty result when sender is the only team member", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "sender" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "sender" });

    const ctx = createContext({
      db,
      dataDir,
      reloadedAgentNames: [],
      principal: { kind: "agent", agentName: "sender" },
    });
    const handlers = createTeamHandlers(ctx);
    const result = await handlers["team.send"]({
      token: "sender-token",
      teamName: "alpha",
      text: "hello",
    }) as { requestedCount: number; sentCount: number; failedCount: number; results: unknown[] };

    assert.equal(result.requestedCount, 0);
    assert.equal(result.sentCount, 0);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(result.results, []);
  });
});

test("team.send rejects archived team", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "sender" });
    db.registerAgent({ name: "alice" });
    db.createTeam({ name: "alpha", status: "archived" });
    db.addTeamMember({ teamName: "alpha", agentName: "sender" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });

    const ctx = createContext({
      db,
      dataDir,
      reloadedAgentNames: [],
      principal: { kind: "agent", agentName: "sender" },
    });
    const handlers = createTeamHandlers(ctx);
    await assertRpcError(
      () => handlers["team.send"]({
        token: "sender-token",
        teamName: "alpha",
        text: "hello",
      }),
      RPC_ERRORS.INVALID_PARAMS,
      "Cannot send to archived team",
    );
  });
});

test("team.send best-effort returns partial failures", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "sender" });
    db.registerAgent({ name: "alice" });
    db.registerAgent({ name: "bob" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "sender" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });
    db.addTeamMember({ teamName: "alpha", agentName: "bob" });

    const ctx = createContext({
      db,
      dataDir,
      reloadedAgentNames: [],
      principal: { kind: "agent", agentName: "sender" },
      routeEnvelope: async (input) => {
        if (input.to === "agent:bob") {
          throw new Error("mock-failure:bob");
        }
        return {
          id: "env-alice",
          from: input.from,
          to: input.to,
          fromBoss: false,
          content: input.content,
          priority: input.priority,
          status: "pending",
          createdAt: Date.now(),
          metadata: input.metadata,
        };
      },
    });
    const handlers = createTeamHandlers(ctx);
    const result = await handlers["team.send"]({
      token: "sender-token",
      teamName: "alpha",
      text: "hello",
    }) as {
      sentCount: number;
      failedCount: number;
      results: Array<{ agentName: string; success: boolean; envelopeId?: string; error?: string }>;
    };

    assert.equal(result.sentCount, 1);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(result.results.map((item) => item.agentName), ["alice", "bob"]);
    assert.equal(result.results[0]?.success, true);
    assert.equal(result.results[0]?.envelopeId, "env-alice");
    assert.equal(result.results[1]?.success, false);
    assert.equal((result.results[1]?.error ?? "").includes("mock-failure:bob"), true);
  });
});

test("team.send rejects interrupt-now combined with deliver-at", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "sender" });
    db.registerAgent({ name: "alice" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "sender" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });

    let called = 0;
    const ctx = createContext({
      db,
      dataDir,
      reloadedAgentNames: [],
      principal: { kind: "agent", agentName: "sender" },
      routeEnvelope: async (input) => {
        called += 1;
        return {
          id: "env-unexpected",
          from: input.from,
          to: input.to,
          fromBoss: false,
          content: input.content,
          priority: input.priority,
          status: "pending",
          createdAt: Date.now(),
          metadata: input.metadata,
        };
      },
    });
    const handlers = createTeamHandlers(ctx);
    await assertRpcError(
      () => handlers["team.send"]({
        token: "sender-token",
        teamName: "alpha",
        text: "hello",
        interruptNow: true,
        deliverAt: "+1m",
      }),
      RPC_ERRORS.INVALID_PARAMS,
      "interrupt-now cannot be used with deliver-at",
    );
    assert.equal(called, 0);
  });
});

test("team.send rejects admin principal", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "sender" });
    db.registerAgent({ name: "alice" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "sender" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });

    const ctx = createContext({ db, dataDir, reloadedAgentNames: [] });
    const handlers = createTeamHandlers(ctx);
    await assertRpcError(
      () => handlers["team.send"]({
        token: "admin-token",
        teamName: "alpha",
        text: "hello",
      }),
      RPC_ERRORS.UNAUTHORIZED,
      "Admin tokens cannot send envelopes",
    );
  });
});

test("team.send supports reply-to with partial success", async () => {
  await withTempDb(async ({ db, dataDir }) => {
    db.registerAgent({ name: "sender" });
    db.registerAgent({ name: "alice" });
    db.registerAgent({ name: "bob" });
    db.createTeam({ name: "alpha" });
    db.addTeamMember({ teamName: "alpha", agentName: "sender" });
    db.addTeamMember({ teamName: "alpha", agentName: "alice" });
    db.addTeamMember({ teamName: "alpha", agentName: "bob" });

    const root = db.createEnvelope({
      from: "agent:sender",
      to: "agent:alice",
      content: { text: "root" },
      metadata: { origin: "cli" },
    });

    const routed: CreateEnvelopeInput[] = [];
    const ctx = createContext({
      db,
      dataDir,
      reloadedAgentNames: [],
      principal: { kind: "agent", agentName: "sender" },
      routeEnvelope: async (input) => {
        if (input.to === "agent:bob") {
          throw new Error("mock-failure:bob");
        }
        routed.push(input);
        return {
          id: "env-alice",
          from: input.from,
          to: input.to,
          fromBoss: false,
          content: input.content,
          priority: input.priority,
          status: "pending",
          createdAt: Date.now(),
          metadata: input.metadata,
        };
      },
    });
    const handlers = createTeamHandlers(ctx);
    const result = await handlers["team.send"]({
      token: "sender-token",
      teamName: "alpha",
      text: "hello",
      replyToEnvelopeId: root.id,
    }) as {
      sentCount: number;
      failedCount: number;
      results: Array<{ agentName: string; success: boolean; error?: string }>;
    };

    assert.equal(result.sentCount, 1);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(result.results.map((item) => item.agentName), ["alice", "bob"]);
    assert.equal(result.results[0]?.success, true);
    assert.equal(result.results[1]?.success, false);
    assert.equal((result.results[1]?.error ?? "").includes("mock-failure:bob"), true);

    assert.equal(routed.length, 1);
    const metadata = routed[0]?.metadata as Record<string, unknown> | undefined;
    assert.equal(metadata?.replyToEnvelopeId, root.id);
    assert.equal(metadata?.targetSessionId, undefined);
  });
});
