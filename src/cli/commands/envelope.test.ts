import assert from "node:assert/strict";
import test from "node:test";

import { sendEnvelope } from "./envelope.js";
import { IpcClient } from "../ipc-client.js";
import { formatShortId } from "../../shared/id-format.js";

test("sendEnvelope passes interruptNow and prints interrupt status keys", async () => {
  const originalCall = IpcClient.prototype.call;
  const originalLog = console.log;
  const logs: string[] = [];
  const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const id = "11111111-2222-3333-4444-555555555555";

  IpcClient.prototype.call = async function call<T = unknown>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    rpcCalls.push({ method, params });
    return {
      id,
      interruptedWork: true,
      priorityApplied: true,
    } as T;
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    await sendEnvelope({
      token: "agent-token",
      to: "agent:nex",
      text: "urgent",
      interruptNow: true,
    });
  } finally {
    IpcClient.prototype.call = originalCall;
    console.log = originalLog;
  }

  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0]?.method, "envelope.send");
  assert.equal(rpcCalls[0]?.params.interruptNow, true);
  assert.deepEqual(logs, [
    `id: ${formatShortId(id)}`,
    "interrupt-now: true",
    "interrupted-work: true",
    "priority-applied: true",
  ]);
});

test("sendEnvelope without interruptNow keeps legacy single-line success output", async () => {
  const originalCall = IpcClient.prototype.call;
  const originalLog = console.log;
  const logs: string[] = [];
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  IpcClient.prototype.call = async function call<T = unknown>(): Promise<T> {
    return { id } as T;
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    await sendEnvelope({
      token: "agent-token",
      to: "agent:nex",
      text: "normal",
    });
  } finally {
    IpcClient.prototype.call = originalCall;
    console.log = originalLog;
  }

  assert.deepEqual(logs, [`id: ${formatShortId(id)}`]);
});

test("sendEnvelope prints one id per broadcast envelope", async () => {
  const originalCall = IpcClient.prototype.call;
  const originalLog = console.log;
  const logs: string[] = [];
  const ids = [
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "11111111-2222-3333-4444-555555555555",
  ];

  IpcClient.prototype.call = async function call<T = unknown>(): Promise<T> {
    return { ids } as T;
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    await sendEnvelope({
      token: "agent-token",
      to: "team:research",
      text: "hello",
    });
  } finally {
    IpcClient.prototype.call = originalCall;
    console.log = originalLog;
  }

  assert.deepEqual(logs, ids.map((id) => `id: ${formatShortId(id)}`));
});

test("sendEnvelope prints no-recipients for empty broadcast", async () => {
  const originalCall = IpcClient.prototype.call;
  const originalLog = console.log;
  const logs: string[] = [];

  IpcClient.prototype.call = async function call<T = unknown>(): Promise<T> {
    return { ids: [], noRecipients: true } as T;
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    await sendEnvelope({
      token: "agent-token",
      to: "team:research",
      text: "hello",
    });
  } finally {
    IpcClient.prototype.call = originalCall;
    console.log = originalLog;
  }

  assert.deepEqual(logs, ["no-recipients: true"]);
});
