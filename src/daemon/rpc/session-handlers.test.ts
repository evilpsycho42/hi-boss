import assert from "node:assert/strict";
import test from "node:test";

import { createSessionHandlers } from "./session-handlers.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import type { Agent } from "../../agent/types.js";

function makeAgent(name: string): Agent {
  return {
    name,
    token: `${name}-token`,
    provider: "claude",
    createdAt: Date.now(),
    permissionLevel: "restricted",
  };
}

function makeContext(params: {
  principal: Agent;
  knownAgents?: Agent[];
}): DaemonContext {
  const knownAgents = params.knownAgents ?? [params.principal];
  return {
    db: {
      getAgentByNameCaseInsensitive: (name: string) =>
        knownAgents.find((item) => item.name.toLowerCase() === name.toLowerCase()) ?? null,
      listAgentSessionsByAgent: (agentName: string) => [
        {
          id: "sess-1",
          agentName,
          provider: "claude",
          providerSessionId: "provider-sess-1",
          createdAt: 1,
          lastActiveAt: 2,
          lastAdapterType: "telegram",
          lastChatId: "chat-1",
        },
      ],
    } as unknown as DaemonContext["db"],
    router: {} as unknown as DaemonContext["router"],
    executor: {} as unknown as DaemonContext["executor"],
    scheduler: {} as unknown as DaemonContext["scheduler"],
    cronScheduler: null,
    adapters: new Map(),
    config: { dataDir: "/tmp", daemonDir: "/tmp" },
    running: true,
    startTimeMs: Date.now(),
    resolvePrincipal: () => ({
      kind: "agent",
      level: "restricted",
      agent: params.principal,
    }),
    assertOperationAllowed: () => undefined,
    getPermissionPolicy: () => ({ version: 1, operations: { "session.list": "restricted" } }),
    createAdapterForBinding: async () => null,
    removeAdapter: async () => undefined,
    registerAgentHandler: () => undefined,
  };
}

async function assertRpcError(
  fn: () => Promise<unknown>,
  expectedCode: number,
  expectedMessageIncludes: string
): Promise<void> {
  await assert.rejects(
    fn,
    (err: unknown) => {
      const e = err as Error & { code?: number };
      assert.equal(e.code, expectedCode);
      assert.equal(e.message.includes(expectedMessageIncludes), true);
      return true;
    }
  );
}

test("session.list defaults to current agent when agentName is omitted", async () => {
  const principal = makeAgent("alpha");
  const ctx = makeContext({ principal });
  const handlers = createSessionHandlers(ctx);

  const result = (await handlers["session.list"]({
    token: principal.token,
  })) as {
    sessions: Array<{ id: string; agentName: string }>;
  };

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.agentName, "alpha");
});

test("session.list supports explicit agentName", async () => {
  const principal = makeAgent("alpha");
  const bravo = makeAgent("bravo");
  const ctx = makeContext({ principal, knownAgents: [principal, bravo] });
  const handlers = createSessionHandlers(ctx);

  const result = (await handlers["session.list"]({
    token: principal.token,
    agentName: "bravo",
    limit: 10,
  })) as {
    sessions: Array<{ id: string; agentName: string }>;
  };

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.agentName, "bravo");
});

test("session.list rejects invalid limit", async () => {
  const principal = makeAgent("alpha");
  const ctx = makeContext({ principal });
  const handlers = createSessionHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["session.list"]({
        token: principal.token,
        limit: 0,
      }),
    RPC_ERRORS.INVALID_PARAMS,
    "Invalid limit"
  );
});

