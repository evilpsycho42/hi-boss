import assert from "node:assert/strict";
import test from "node:test";

import { createEnvelopeHandlers } from "./envelope-handlers.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import type { CreateEnvelopeInput, Envelope } from "../../envelope/types.js";
import type { Agent } from "../../agent/types.js";
import { INTERNAL_VERSION } from "../../shared/version.js";

function makeAgent(name: string): Agent {
  return {
    name,
    token: `${name}-token`,
    provider: "codex",
    createdAt: Date.now(),
    permissionLevel: "restricted",
  };
}

function makeContext(params: {
  sender: Agent;
  knownAgents?: Agent[];
  teams?: Array<{
    name: string;
    status?: "active" | "archived";
    members: string[];
  }>;
  routeEnvelope?: (input: CreateEnvelopeInput) => Promise<Envelope>;
  abortCurrentRun?: (agentName: string, reason: string) => boolean;
  boundAdapterTypes?: string[];
}): DaemonContext {
  const knownAgents = new Map<string, Agent>();
  for (const agent of params.knownAgents ?? [params.sender]) {
    knownAgents.set(agent.name.toLowerCase(), agent);
  }
  if (!knownAgents.has(params.sender.name.toLowerCase())) {
    knownAgents.set(params.sender.name.toLowerCase(), params.sender);
  }

  const teams = new Map<string, { name: string; status: "active" | "archived"; members: string[] }>();
  for (const team of params.teams ?? []) {
    teams.set(team.name.toLowerCase(), {
      name: team.name,
      status: team.status ?? "active",
      members: [...team.members],
    });
  }

  const boundAdapterTypes = new Set(params.boundAdapterTypes ?? []);
  const routeEnvelope =
    params.routeEnvelope ??
    (async (input) =>
      ({
        id: "e-1",
        from: input.from,
        to: input.to,
        fromBoss: input.fromBoss ?? false,
        content: input.content,
        priority: input.priority,
        deliverAt: input.deliverAt,
        status: "pending",
        createdAt: Date.now(),
        metadata: input.metadata,
      }) satisfies Envelope);

  return {
    db: {
      updateAgentLastSeen: () => undefined,
      getAgentByNameCaseInsensitive: (name: string) => knownAgents.get(name.toLowerCase()) ?? null,
      getTeamByNameCaseInsensitive: (name: string) => {
        const team = teams.get(name.toLowerCase());
        if (!team) return null;
        return {
          id: `${team.name}-id`,
          name: team.name,
          status: team.status,
          kind: "manual",
          createdAt: Date.now(),
        };
      },
      listTeamMemberAgentNames: (teamName: string) => {
        const team = teams.get(teamName.toLowerCase());
        return team ? [...team.members] : [];
      },
      getAgentBindingByType: (_agentName: string, adapterType: string) =>
        boundAdapterTypes.has(adapterType)
          ? {
            id: "binding-1",
            agentName: params.sender.name,
            adapterType,
            adapterToken: "adapter-token",
            createdAt: Date.now(),
          }
          : null,
      getBossTimezone: () => "UTC",
      getEnvelopeById: () => null,
    } as unknown as DaemonContext["db"],
    router: {
      routeEnvelope,
    } as unknown as DaemonContext["router"],
    executor: {
      abortCurrentRun:
        params.abortCurrentRun ??
        (() => false),
    } as unknown as DaemonContext["executor"],
    scheduler: {
      onEnvelopeCreated: () => undefined,
    } as unknown as DaemonContext["scheduler"],
    cronScheduler: null,
    adapters: new Map(),
    config: { dataDir: "/tmp", daemonDir: "/tmp" },
    running: true,
    startTimeMs: Date.now(),
    resolvePrincipal: () => ({
      kind: "agent",
      level: "restricted",
      agent: params.sender,
    }),
    assertOperationAllowed: () => undefined,
    getPermissionPolicy: () => ({ version: INTERNAL_VERSION, operations: { "envelope.send": "restricted" } }),
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

test("envelope.send rejects non-boolean interruptNow", async () => {
  const sender = makeAgent("sender");
  const target = makeAgent("target");
  const ctx = makeContext({ sender, knownAgents: [sender, target] });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "agent:target:new",
        text: "hello",
        interruptNow: "true",
      } as unknown as Record<string, unknown>),
    RPC_ERRORS.INVALID_PARAMS,
    "Invalid interrupt-now"
  );
});

test("envelope.send rejects interruptNow with deliverAt", async () => {
  const sender = makeAgent("sender");
  const target = makeAgent("target");
  const ctx = makeContext({ sender, knownAgents: [sender, target] });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "agent:target:new",
        text: "hello",
        interruptNow: true,
        deliverAt: "+1m",
      }),
    RPC_ERRORS.INVALID_PARAMS,
    "interrupt-now cannot be used with deliver-at"
  );
});

test("envelope.send rejects interruptNow for channel destinations", async () => {
  const sender = makeAgent("sender");
  const ctx = makeContext({ sender });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "channel:telegram:123",
        text: "hello",
        interruptNow: true,
      }),
    RPC_ERRORS.INVALID_PARAMS,
    "interrupt-now is only supported for single agent destinations"
  );
});

test("envelope.send interruptNow aborts work and creates priority envelope", async () => {
  const sender = makeAgent("sender");
  const target = makeAgent("target");
  const abortCalls: Array<{ agentName: string; reason: string }> = [];
  let routedInput: CreateEnvelopeInput | null = null;

  const ctx = makeContext({
    sender,
    knownAgents: [sender, target],
    abortCurrentRun: (agentName: string, reason: string) => {
      abortCalls.push({ agentName, reason });
      return true;
    },
    routeEnvelope: async (input) => {
      routedInput = input;
      return {
        id: "env-priority",
        from: input.from,
        to: input.to,
        fromBoss: false,
        content: input.content,
        priority: input.priority,
        status: "pending",
        createdAt: Date.now(),
      };
    },
  });

  const handlers = createEnvelopeHandlers(ctx);
  const result = (await handlers["envelope.send"]({
    token: sender.token,
    to: "agent:target:new",
    text: "urgent",
    interruptNow: true,
  })) as { id: string; interruptedWork: boolean; priorityApplied: boolean };

  assert.equal(abortCalls.length, 1);
  assert.deepEqual(abortCalls[0], {
    agentName: "target",
    reason: "rpc:envelope.send:interrupt-now",
  });
  assert.notEqual(routedInput, null);
  const routed = routedInput as unknown as CreateEnvelopeInput;
  assert.equal(routed.priority, 1);
  assert.equal(result.id, "env-priority");
  assert.equal(result.interruptedWork, true);
  assert.equal(result.priorityApplied, true);
});

test("envelope.send rejects legacy plain agent destination without chat target", async () => {
  const sender = makeAgent("bob");
  const target = makeAgent("alice");
  const ctx = makeContext({
    sender,
    knownAgents: [sender, target],
  });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "agent:alice",
        text: "hello",
      }),
    RPC_ERRORS.INVALID_PARAMS,
    "agent destinations must use agent:<name>:new or agent:<name>:<chat-id>"
  );
});

test("envelope.send stamps chatScope for agent:new with generated chat id", async () => {
  const sender = makeAgent("bob");
  const target = makeAgent("alice");
  let routedInput: CreateEnvelopeInput | null = null;
  const ctx = makeContext({
    sender,
    knownAgents: [sender, target],
    routeEnvelope: async (input) => {
      routedInput = input;
      return {
        id: "env-dm",
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
  const handlers = createEnvelopeHandlers(ctx);

  await handlers["envelope.send"]({
    token: sender.token,
    to: "agent:alice:new",
    text: "hello",
  });

  assert.notEqual(routedInput, null);
  const metadata = (routedInput as unknown as CreateEnvelopeInput).metadata as Record<string, unknown> | undefined;
  assert.equal(typeof metadata?.chatScope, "string");
  assert.equal(String(metadata?.chatScope).startsWith("agent-chat-"), true);
});

test("envelope.send stamps chatScope from explicit agent chat id", async () => {
  const sender = makeAgent("bob");
  const target = makeAgent("alice");
  let routedInput: CreateEnvelopeInput | null = null;
  const ctx = makeContext({
    sender,
    knownAgents: [sender, target],
    routeEnvelope: async (input) => {
      routedInput = input;
      return {
        id: "env-chat-id",
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
  const handlers = createEnvelopeHandlers(ctx);

  await handlers["envelope.send"]({
    token: sender.token,
    to: "agent:alice:chat-42",
    text: "hello",
  });

  assert.notEqual(routedInput, null);
  const metadata = (routedInput as unknown as CreateEnvelopeInput).metadata as Record<string, unknown> | undefined;
  assert.equal(metadata?.chatScope, "chat-42");
});

test("envelope.send team mention stamps team chatScope", async () => {
  const sender = makeAgent("carol");
  const bob = makeAgent("bob");
  let routedInput: CreateEnvelopeInput | null = null;
  const ctx = makeContext({
    sender,
    knownAgents: [sender, bob],
    teams: [
      { name: "research", members: ["bob"] },
    ],
    routeEnvelope: async (input) => {
      routedInput = input;
      return {
        id: "env-mention",
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
  const handlers = createEnvelopeHandlers(ctx);

  await handlers["envelope.send"]({
    token: sender.token,
    to: "team:research:bob",
    text: "ping",
  });

  assert.notEqual(routedInput, null);
  const routed = routedInput as unknown as CreateEnvelopeInput;
  const metadata = routed.metadata as Record<string, unknown> | undefined;
  assert.equal(routed.to, "agent:bob");
  assert.equal(metadata?.chatScope, "team:research");
});

test("envelope.send team mention rejects non-member", async () => {
  const sender = makeAgent("carol");
  const ctx = makeContext({
    sender,
    teams: [{ name: "research", members: ["bob"] }],
  });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "team:research:alice",
        text: "ping",
      }),
    RPC_ERRORS.NOT_FOUND,
    "Team member not found"
  );
});

test("envelope.send team mention rejects archived team", async () => {
  const sender = makeAgent("carol");
  const ctx = makeContext({
    sender,
    teams: [{ name: "research", status: "archived", members: ["bob"] }],
  });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "team:research:bob",
        text: "ping",
      }),
    RPC_ERRORS.INVALID_PARAMS,
    "Cannot send to archived team"
  );
});

test("envelope.send rejects interruptNow for team broadcast", async () => {
  const sender = makeAgent("sender");
  const alice = makeAgent("alice");
  const ctx = makeContext({
    sender,
    knownAgents: [sender, alice],
    teams: [{ name: "alpha", members: ["sender", "alice"] }],
  });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "team:alpha",
        text: "hello",
        interruptNow: true,
      }),
    RPC_ERRORS.INVALID_PARAMS,
    "interrupt-now is not supported for team broadcast"
  );
});

test("envelope.send team broadcast fans out and returns ids", async () => {
  const sender = makeAgent("sender");
  const alice = makeAgent("alice");
  const bob = makeAgent("bob");
  const routed: CreateEnvelopeInput[] = [];
  const ctx = makeContext({
    sender,
    knownAgents: [sender, alice, bob],
    teams: [{ name: "alpha", members: ["sender", "alice", "bob"] }],
    routeEnvelope: async (input) => {
      routed.push(input);
      return {
        id: `env-${routed.length}`,
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
  const handlers = createEnvelopeHandlers(ctx);

  const result = (await handlers["envelope.send"]({
    token: sender.token,
    to: "team:alpha",
    text: "hello team",
  })) as { ids: string[] };

  assert.deepEqual(result.ids, ["env-1", "env-2"]);
  assert.deepEqual(routed.map((item) => item.to), ["agent:alice", "agent:bob"]);
  assert.deepEqual(
    routed.map((item) => (item.metadata as Record<string, unknown> | undefined)?.chatScope),
    ["team:alpha", "team:alpha"]
  );
});

test("envelope.send team broadcast failure includes partial delivery ids", async () => {
  const sender = makeAgent("sender");
  const alice = makeAgent("alice");
  const bob = makeAgent("bob");
  let sendCount = 0;
  const ctx = makeContext({
    sender,
    knownAgents: [sender, alice, bob],
    teams: [{ name: "alpha", members: ["sender", "alice", "bob"] }],
    routeEnvelope: async (input) => {
      sendCount += 1;
      if (sendCount === 2) {
        throw new Error(`failed to deliver to ${input.to}`);
      }
      return {
        id: `env-${sendCount}`,
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
  const handlers = createEnvelopeHandlers(ctx);

  await assert.rejects(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "team:alpha",
        text: "hello team",
      }),
    (err: unknown) => {
      const e = err as Error & { code?: number; data?: unknown };
      assert.equal(e.code, RPC_ERRORS.DELIVERY_FAILED);
      assert.equal(e.message.includes("failed to deliver to agent:bob"), true);
      const data =
        e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : null;
      assert.notEqual(data, null);
      assert.deepEqual(data?.ids, ["env-1"]);
      assert.equal(data?.partialDelivery, true);
      assert.equal(data?.deliveredCount, 1);
      assert.equal(data?.totalRecipients, 2);
      assert.equal(data?.failedAgentName, "bob");
      return true;
    }
  );
});

test("envelope.send team broadcast returns no-recipients for sender-only team", async () => {
  const sender = makeAgent("sender");
  const ctx = makeContext({
    sender,
    teams: [{ name: "alpha", members: ["sender"] }],
  });
  const handlers = createEnvelopeHandlers(ctx);

  const result = (await handlers["envelope.send"]({
    token: sender.token,
    to: "team:alpha",
    text: "hello",
  })) as { ids: string[]; noRecipients?: boolean };

  assert.deepEqual(result.ids, []);
  assert.equal(result.noRecipients, true);
});

test("envelope.send validates team broadcast params even with no recipients", async () => {
  const sender = makeAgent("sender");
  const ctx = makeContext({
    sender,
    teams: [{ name: "alpha", members: ["sender"] }],
  });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "team:alpha",
        text: "hello",
        deliverAt: "not-a-time",
      }),
    RPC_ERRORS.INVALID_PARAMS,
    "Invalid deliver-at"
  );
});
