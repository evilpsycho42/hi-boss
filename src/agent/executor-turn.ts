import type { AgentSession, TurnTokenUsage } from "./executor-support.js";
import { readTokenUsage } from "./executor-support.js";

export async function executeUnifiedTurn(
  session: AgentSession,
  turnInput: string
): Promise<{ finalText: string; usage: TurnTokenUsage }> {
  const runHandle = await session.session.run({
    input: { parts: [{ type: "text", text: turnInput }] },
  });

  // Drain events silently (required for run completion)
  for await (const _ of runHandle.events) {
    // Events must be consumed for the run to complete
  }

  const result = await runHandle.result;

  if (result.status !== "success") {
    throw new Error(`Agent run ${result.status}`);
  }

  const usage = readTokenUsage(result.usage);
  return { finalText: result.finalText ?? "", usage };
}

