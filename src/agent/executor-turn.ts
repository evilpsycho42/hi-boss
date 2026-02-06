import type { RunHandle } from "@unified-agent-sdk/runtime";
import type { AgentSession, TurnTokenUsage } from "./executor-support.js";
import { readTokenUsage } from "./executor-support.js";

export async function executeUnifiedTurn(
  session: AgentSession,
  turnInput: string,
  options?: {
    signal?: AbortSignal;
    onRunHandle?: (handle: RunHandle) => void;
  }
): Promise<{ status: "success" | "cancelled"; finalText: string; usage: TurnTokenUsage }> {
  const config = options?.signal ? { signal: options.signal } : undefined;

  const runHandle = await session.session.run({
    input: { parts: [{ type: "text", text: turnInput }] },
    ...(config ? { config } : {}),
  });

  options?.onRunHandle?.(runHandle);

  // Drain events silently (required for run completion)
  for await (const _ of runHandle.events) {
    // Events must be consumed for the run to complete
  }

  const result = await runHandle.result;

  if (result.status === "cancelled") {
    return { status: "cancelled", finalText: "", usage: readTokenUsage(result.usage) };
  }

  if (result.status !== "success") {
    throw new Error(`Agent run ${result.status}`);
  }

  const usage = readTokenUsage(result.usage);
  return { status: "success", finalText: result.finalText ?? "", usage };
}
