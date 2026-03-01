import assert from "node:assert/strict";
import test from "node:test";

import { createCronHandlers } from "./cron-handlers.js";
import { RPC_ERRORS } from "../ipc/types.js";
import type { DaemonContext } from "./context.js";
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
  principal: Agent;
  knownAgents?: Agent[];
  createSchedule?: (input: Record<string, unknown>) => { schedule: { id: string } };
}): DaemonContext {
  const knownAgents = new Map<string, Agent>();
  for (const agent of params.knownAgents ?? [params.principal]) {
    knownAgents.set(agent.name.toLowerCase(), agent);
  }
  if (!knownAgents.has(params.principal.name.toLowerCase())) {
    knownAgents.set(params.principal.name.toLowerCase(), params.principal);
  }

  return {
    db: {
      updateAgentLastSeen: () => undefined,
      getBossTimezone: () => "UTC",
      getAgentByNameCaseInsensitive: (name: string) => knownAgents.get(name.toLowerCase()) ?? null,
      getAgentBindingByType: () => null,
      listCronSchedulesByAgent: () => [],
      listCronSchedules: () => [],
      getCronScheduleById: () => null,
    } as unknown as DaemonContext["db"],
    router: {} as unknown as DaemonContext["router"],
    executor: {} as unknown as DaemonContext["executor"],
    scheduler: {} as unknown as DaemonContext["scheduler"],
    cronScheduler: {
      createSchedule: params.createSchedule ?? (() => ({ schedule: { id: "cron-1" } })),
      listSchedules: () => [],
      enableSchedule: () => ({ schedule: { id: "cron-1" } }),
      disableSchedule: () => ({ id: "cron-1" }),
      deleteSchedule: () => true,
      reconcileAllSchedules: () => undefined,
      onEnvelopeDone: () => undefined,
      onEnvelopesDone: () => undefined,
    } as unknown as DaemonContext["cronScheduler"],
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
    getPermissionPolicy: () => ({ version: INTERNAL_VERSION, operations: { "cron.create": "restricted" } }),
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

test("cron.create rejects team broadcast destination", async () => {
  const principal = makeAgent("sender");
  const ctx = makeContext({ principal });
  const handlers = createCronHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["cron.create"]({
        token: principal.token,
        cron: "0 * * * *",
        to: "team:research",
        text: "ping",
      }),
    RPC_ERRORS.INVALID_PARAMS,
    "Cron schedules cannot use team destinations"
  );
});

test("cron.create rejects team mention destination", async () => {
  const principal = makeAgent("sender");
  const ctx = makeContext({ principal });
  const handlers = createCronHandlers(ctx);

  await assertRpcError(
    () =>
      handlers["cron.create"]({
        token: principal.token,
        cron: "0 * * * *",
        to: "team:research:bob",
        text: "ping",
      }),
    RPC_ERRORS.INVALID_PARAMS,
    "Cron schedules cannot use team destinations"
  );
});

test("cron.create still accepts agent destination", async () => {
  const principal = makeAgent("sender");
  const target = makeAgent("bob");
  let capturedTo = "";
  const ctx = makeContext({
    principal,
    knownAgents: [principal, target],
    createSchedule: (input) => {
      capturedTo = String(input.to);
      return { schedule: { id: "cron-agent" } };
    },
  });
  const handlers = createCronHandlers(ctx);

  const result = (await handlers["cron.create"]({
    token: principal.token,
    cron: "0 * * * *",
    to: "agent:bob",
    text: "ping",
  })) as { id: string };

  assert.equal(result.id, "cron-agent");
  assert.equal(capturedTo, "agent:bob");
});
