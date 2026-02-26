import assert from "node:assert/strict";
import test from "node:test";

import { createEnvelopeHandlers } from "./envelope-handlers.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
import type { CreateEnvelopeInput, Envelope } from "../../envelope/types.js";
import type { Agent } from "../../agent/types.js";

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
  targetAgent?: Agent;
  routeEnvelope?: (input: CreateEnvelopeInput) => Promise<Envelope>;
  abortCurrentRun?: (agentName: string, reason: string) => boolean;
}): DaemonContext {
  const targetAgent = params.targetAgent ?? null;
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
      getAgentByNameCaseInsensitive: (name: string) =>
        targetAgent && targetAgent.name.toLowerCase() === name.toLowerCase() ? targetAgent : null,
      getAgentBindingByType: () => null,
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
    getPermissionPolicy: () => ({ version: 1, operations: { "envelope.send": "restricted" } }),
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
  const ctx = makeContext({ sender, targetAgent: target });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "agent:target",
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
  const ctx = makeContext({ sender, targetAgent: target });
  const handlers = createEnvelopeHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["envelope.send"]({
        token: sender.token,
        to: "agent:target",
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
    "interrupt-now is only supported for agent destinations"
  );
});

test("envelope.send interruptNow aborts work and creates priority envelope", async () => {
  const sender = makeAgent("sender");
  const target = makeAgent("target");
  const abortCalls: Array<{ agentName: string; reason: string }> = [];
  let routedInput: CreateEnvelopeInput | null = null;

  const ctx = makeContext({
    sender,
    targetAgent: target,
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
    to: "agent:target",
    text: "urgent",
    interruptNow: true,
  })) as { id: string; interruptedWork: boolean; priorityApplied: boolean };

  assert.equal(abortCalls.length, 1);
  assert.deepEqual(abortCalls[0], {
    agentName: "target",
    reason: "rpc:envelope.send:interrupt-now",
  });
  assert.notEqual(routedInput, null);
  assert.equal((routedInput as any).priority, 1);
  assert.equal(result.id, "env-priority");
  assert.equal(result.interruptedWork, true);
  assert.equal(result.priorityApplied, true);
});
